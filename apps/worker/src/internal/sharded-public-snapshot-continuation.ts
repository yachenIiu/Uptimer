import type { Env } from '../env';
import { refreshMonitorRuntimeSnapshotFromUpdateFragments } from './runtime-fragments-refresh-core';
import {
  assembleShardedPublicSnapshot,
  seedShardedPublicSnapshotFragments,
  type ShardedPublicSnapshotAssemblyMode,
  type ShardedPublicSnapshotKind,
  type ShardedPublicSnapshotSeedPart,
} from './sharded-public-snapshot-core';

export type ShardedPublicSnapshotContinuationStep =
  | { step: 'runtime' }
  | {
      step: 'seed';
      kind: ShardedPublicSnapshotKind;
      part: Exclude<ShardedPublicSnapshotSeedPart, 'all'>;
      monitorOffset?: number;
      monitorLimit?: number;
    }
  | { step: 'assemble'; kind: ShardedPublicSnapshotKind };

export type ShardedPublicSnapshotContinuationResult = {
  ok: boolean;
  step: ShardedPublicSnapshotContinuationStep['step'];
  continued: boolean;
  nextStep?: ShardedPublicSnapshotContinuationStep;
  refreshed?: boolean;
  seeded?: boolean;
  assembled?: boolean;
  kind?: ShardedPublicSnapshotKind;
  part?: Exclude<ShardedPublicSnapshotSeedPart, 'all'>;
  monitorCount?: number;
  monitorOffset?: number;
  monitorLimit?: number;
  writeCount?: number;
  invalidCount?: number;
  staleCount?: number;
  skipped?: string;
  error?: boolean;
};

const CONTINUATION_PATH = '/api/v1/internal/continue/sharded-public-snapshot';
const DEFAULT_MONITOR_LIMIT = 5;

function isTruthyEnvFlag(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function readBoundedMonitorLimit(env: Env, requested?: number): number {
  const raw = requested ?? (env as unknown as Record<string, unknown>).UPTIMER_SHARDED_FRAGMENT_SEED_BATCH_SIZE;
  const parsed = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(parsed)) return DEFAULT_MONITOR_LIMIT;
  return Math.max(1, Math.min(10, Math.floor(parsed)));
}

function readAssemblyMode(env: Env): ShardedPublicSnapshotAssemblyMode {
  const raw = (env as unknown as Record<string, unknown>).UPTIMER_SHARDED_ASSEMBLER_MODE;
  return typeof raw === 'string' && raw.trim().toLowerCase() === 'json' ? 'json' : 'validated';
}

function canRefreshRuntimeFragments(env: Env): boolean {
  return isTruthyEnvFlag((env as unknown as Record<string, unknown>).UPTIMER_SCHEDULED_RUNTIME_FRAGMENT_REFRESH);
}

function canSeedShardedFragments(env: Env): boolean {
  const raw = env as unknown as Record<string, unknown>;
  return (
    isTruthyEnvFlag(raw.UPTIMER_PUBLIC_SHARDED_FRAGMENT_SEED) &&
    isTruthyEnvFlag(raw.UPTIMER_SCHEDULED_SHARDED_FRAGMENT_SEED)
  );
}

function canAssembleShardedSnapshots(env: Env): boolean {
  const raw = env as unknown as Record<string, unknown>;
  return (
    isTruthyEnvFlag(raw.UPTIMER_PUBLIC_SHARDED_ASSEMBLER) &&
    isTruthyEnvFlag(raw.UPTIMER_SCHEDULED_SHARDED_ASSEMBLER)
  );
}

function nextSeedStep(opts: {
  kind: ShardedPublicSnapshotKind;
  part: Exclude<ShardedPublicSnapshotSeedPart, 'all'>;
  monitorOffset: number;
  monitorLimit: number;
  monitorCount: number;
}): ShardedPublicSnapshotContinuationStep {
  if (opts.part === 'envelope') {
    return opts.monitorCount > 0
      ? {
          step: 'seed',
          kind: opts.kind,
          part: 'monitors',
          monitorOffset: 0,
          monitorLimit: opts.monitorLimit,
        }
      : opts.kind === 'homepage'
        ? { step: 'seed', kind: 'status', part: 'envelope', monitorOffset: 0, monitorLimit: opts.monitorLimit }
        : { step: 'assemble', kind: 'homepage' };
  }

  const nextOffset = opts.monitorOffset + opts.monitorLimit;
  if (nextOffset < opts.monitorCount) {
    return {
      step: 'seed',
      kind: opts.kind,
      part: 'monitors',
      monitorOffset: nextOffset,
      monitorLimit: opts.monitorLimit,
    };
  }

  return opts.kind === 'homepage'
    ? { step: 'seed', kind: 'status', part: 'envelope', monitorOffset: 0, monitorLimit: opts.monitorLimit }
    : { step: 'assemble', kind: 'homepage' };
}

function nextAssembleStep(kind: ShardedPublicSnapshotKind): ShardedPublicSnapshotContinuationStep | null {
  return kind === 'homepage' ? { step: 'assemble', kind: 'status' } : null;
}

function toWireStep(step: ShardedPublicSnapshotContinuationStep): Record<string, unknown> {
  if (step.step === 'seed') {
    return {
      step: step.step,
      kind: step.kind,
      part: step.part,
      monitor_offset: step.monitorOffset ?? 0,
      monitor_limit: step.monitorLimit ?? DEFAULT_MONITOR_LIMIT,
    };
  }
  if (step.step === 'assemble') {
    return { step: step.step, kind: step.kind };
  }
  return { step: step.step };
}

function queueContinuation(
  env: Env,
  ctx: ExecutionContext,
  nextStep: ShardedPublicSnapshotContinuationStep | null,
): boolean {
  if (!nextStep || !env.SELF || !env.ADMIN_TOKEN) {
    return false;
  }

  ctx.waitUntil(
    env.SELF.fetch(
      new Request(`http://internal${CONTINUATION_PATH}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.ADMIN_TOKEN}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify(toWireStep(nextStep)),
      }),
    )
      .then(async (res) => {
        const bodyText = await res.text().catch(() => '');
        if (!res.ok) {
          throw new Error(
            `sharded public snapshot continuation failed: HTTP ${res.status} ${bodyText}`.trim(),
          );
        }
      })
      .catch((err) => {
        console.warn('sharded public snapshot continuation dispatch failed', err);
      }),
  );
  return true;
}

export async function runShardedPublicSnapshotContinuation(opts: {
  env: Env;
  ctx: ExecutionContext;
  now: number;
  step: ShardedPublicSnapshotContinuationStep;
}): Promise<ShardedPublicSnapshotContinuationResult> {
  if (opts.step.step === 'runtime') {
    if (!canRefreshRuntimeFragments(opts.env)) {
      return { ok: true, step: 'runtime', continued: false, skipped: 'runtime_disabled' };
    }
    const result = await refreshMonitorRuntimeSnapshotFromUpdateFragments({
      env: opts.env,
      now: opts.now,
    });
    const nextStep: ShardedPublicSnapshotContinuationStep = {
      step: 'seed',
      kind: 'homepage',
      part: 'envelope',
      monitorOffset: 0,
      monitorLimit: readBoundedMonitorLimit(opts.env),
    };
    const continued = queueContinuation(opts.env, opts.ctx, nextStep);
    return {
      ok: result.ok,
      step: 'runtime',
      refreshed: result.refreshed,
      invalidCount: result.invalidCount,
      staleCount: result.staleCount,
      monitorCount: result.updateCount,
      continued,
      ...(continued ? { nextStep } : {}),
      ...(result.skip ? { skipped: result.skip } : {}),
    };
  }

  if (opts.step.step === 'seed') {
    if (!canSeedShardedFragments(opts.env)) {
      return { ok: true, step: 'seed', continued: false, skipped: 'seed_disabled' };
    }
    const monitorLimit = readBoundedMonitorLimit(opts.env, opts.step.monitorLimit);
    const monitorOffset = Math.max(0, Math.floor(opts.step.monitorOffset ?? 0));
    const result = await seedShardedPublicSnapshotFragments({
      env: opts.env,
      kind: opts.step.kind,
      part: opts.step.part,
      now: opts.now,
      offset: monitorOffset,
      limit: monitorLimit,
    });
    const nextStep = result.ok
      ? nextSeedStep({
          kind: opts.step.kind,
          part: opts.step.part,
          monitorOffset,
          monitorLimit,
          monitorCount: result.monitorCount,
        })
      : null;
    const continued = queueContinuation(opts.env, opts.ctx, nextStep);
    return {
      ok: result.ok,
      step: 'seed',
      seeded: result.seeded,
      kind: result.kind,
      part: opts.step.part,
      monitorCount: result.monitorCount,
      monitorOffset,
      monitorLimit,
      writeCount: result.writeCount,
      continued,
      ...(continued && nextStep ? { nextStep } : {}),
      ...(result.skipped ? { skipped: result.skipped } : {}),
      ...(result.error ? { error: true } : {}),
    };
  }

  if (!canAssembleShardedSnapshots(opts.env)) {
    return { ok: true, step: 'assemble', continued: false, skipped: 'assemble_disabled' };
  }
  const result = await assembleShardedPublicSnapshot({
    env: opts.env,
    kind: opts.step.kind,
    mode: readAssemblyMode(opts.env),
  });
  const nextStep = result.ok ? nextAssembleStep(opts.step.kind) : null;
  const continued = queueContinuation(opts.env, opts.ctx, nextStep);
  return {
    ok: result.ok,
    step: 'assemble',
    assembled: result.assembled,
    kind: result.kind,
    monitorCount: result.monitorCount,
    invalidCount: result.invalidCount,
    staleCount: result.staleCount,
    continued,
    ...(continued && nextStep ? { nextStep } : {}),
    ...(result.skip ? { skipped: result.skip } : {}),
    ...(result.error ? { error: true } : {}),
  };
}
