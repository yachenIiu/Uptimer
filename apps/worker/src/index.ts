import { z } from 'zod';

import type { Env } from './env';
import type { Trace } from './observability/trace';
import {
  encodeMonitorRuntimeUpdatesCompact,
  fromRuntimeStatusCode,
  parseMonitorRuntimeUpdates,
  readPublicMonitorRuntimeSnapshot,
  toMonitorRuntimeEntryMap,
  type MonitorRuntimeUpdate,
} from './public/monitor-runtime';
import type { CompletedDueMonitor } from './scheduler/scheduled';
import { LeaseLostError, startRenewableLease } from './scheduler/lease-guard';

const HOMEPAGE_REFRESH_LOCK_NAME = 'snapshot:homepage:refresh';
const HOMEPAGE_REFRESH_LOCK_LEASE_SECONDS = 55;
const HOMEPAGE_REFRESH_LOCK_RENEW_INTERVAL_MS = 15_000;
const HOMEPAGE_REFRESH_LOCK_RENEW_MIN_REMAINING_SECONDS = 20;
const INTERNAL_REQUEST_MAX_BYTES = 256 * 1024;
const INTERNAL_PROTOCOL_FORMAT = 'compact-v1';
const INTERNAL_BASELINE_QUERY_CHUNK_SIZE = 64;

function normalizeTruthyHeader(value: string | null): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function readBearerToken(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? null;
}

function hasValidInternalAuth(request: Request, env: Env): boolean {
  if (!env.ADMIN_TOKEN) {
    return false;
  }
  return readBearerToken(request.headers.get('Authorization')) === env.ADMIN_TOKEN;
}

function isInternalServiceRequest(request: Request): boolean {
  try {
    return new URL(request.url).hostname === 'internal';
  } catch {
    return false;
  }
}

function isRequestBodyTooLarge(request: Request): boolean {
  const raw = request.headers.get('Content-Length');
  if (!raw) {
    return false;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > INTERNAL_REQUEST_MAX_BYTES;
}

function isScheduledRefreshRequest(request: Request): boolean {
  return request.headers.get('X-Uptimer-Refresh-Source') === 'scheduled';
}

function wantsCompactInternalFormat(request: Request): boolean {
  return request.headers.get('X-Uptimer-Internal-Format') === INTERNAL_PROTOCOL_FORMAT;
}

function isSameMinute(a: number, b: number): boolean {
  return Math.floor(a / 60) === Math.floor(b / 60);
}

function normalizeRuntimeUpdateStatus(
  value: MonitorRuntimeUpdate['check_status'] | MonitorRuntimeUpdate['next_status'],
): 'up' | 'down' | 'maintenance' | 'paused' | 'unknown' {
  switch (value) {
    case 'up':
    case 'down':
    case 'maintenance':
    case 'paused':
    case 'unknown':
      return value;
    default:
      return 'unknown';
  }
}

function readRuntimeUpdateCurrentStatus(
  update: MonitorRuntimeUpdate,
): 'up' | 'down' | 'maintenance' | 'paused' | 'unknown' {
  return normalizeRuntimeUpdateStatus(update.next_status ?? update.check_status);
}

function readRuntimeUpdateHeartbeatStatus(
  update: MonitorRuntimeUpdate,
): 'up' | 'down' | 'maintenance' | 'paused' | 'unknown' {
  return normalizeRuntimeUpdateStatus(update.check_status);
}

function buildNumberedPlaceholders(count: number, start = 1): string {
  return Array.from({ length: count }, (_, index) => `?${index + start}`).join(', ');
}

async function readPersistedRuntimeUpdateBaseline(
  db: D1Database,
  updates: MonitorRuntimeUpdate[],
): Promise<ReadonlyMap<number, { last_checked_at: number | null; status: string | null }> | null> {
  const monitorIds = [...new Set(updates.map((update) => update.monitor_id))];
  if (monitorIds.length === 0) {
    return new Map();
  }

  const baseline = new Map<number, { last_checked_at: number | null; status: string | null }>();
  try {
    for (let index = 0; index < monitorIds.length; index += INTERNAL_BASELINE_QUERY_CHUNK_SIZE) {
      const chunk = monitorIds.slice(index, index + INTERNAL_BASELINE_QUERY_CHUNK_SIZE);
      const { results } = await db
        .prepare(
          `
            SELECT monitor_id, last_checked_at, status
            FROM monitor_state
            WHERE monitor_id IN (${buildNumberedPlaceholders(chunk.length)})
          `,
        )
        .bind(...chunk)
        .all<{
          monitor_id: number;
          last_checked_at: number | null;
          status: string | null;
        }>();

      for (const row of results ?? []) {
        baseline.set(row.monitor_id, {
          last_checked_at: row.last_checked_at,
          status: row.status,
        });
      }
    }

    return baseline;
  } catch {
    return null;
  }
}

async function sanitizeScheduledRuntimeUpdatesForFastPath(opts: {
  db: D1Database;
  now: number;
  updates: MonitorRuntimeUpdate[];
  trace?: Trace | null;
}): Promise<MonitorRuntimeUpdate[]> {
  if (opts.updates.length === 0) {
    return opts.updates;
  }

  const runtimeSnapshot = await readPublicMonitorRuntimeSnapshot(opts.db, opts.now);
  if (!runtimeSnapshot) {
    const persistedBaseline = await readPersistedRuntimeUpdateBaseline(opts.db, opts.updates);
    if (!persistedBaseline) {
      opts.trace?.setLabel('runtime_updates_baseline', 'stale');
      opts.trace?.setLabel('runtime_updates_stale_reason', 'baseline_unavailable');
      return [];
    }

    for (const update of opts.updates) {
      const persistedState = persistedBaseline.get(update.monitor_id);
      if (!persistedState || persistedState.last_checked_at === null) {
        continue;
      }

      if (update.checked_at < persistedState.last_checked_at) {
        opts.trace?.setLabel('runtime_updates_baseline', 'stale');
        opts.trace?.setLabel('runtime_updates_stale_monitor_id', update.monitor_id);
        opts.trace?.setLabel('runtime_updates_stale_reason', 'checked_at_regressed');
        return [];
      }

      if (
        update.checked_at === persistedState.last_checked_at &&
        normalizeRuntimeUpdateStatus(persistedState.status as MonitorRuntimeUpdate['next_status']) !==
          readRuntimeUpdateCurrentStatus(update)
      ) {
        opts.trace?.setLabel('runtime_updates_baseline', 'stale');
        opts.trace?.setLabel('runtime_updates_stale_monitor_id', update.monitor_id);
        opts.trace?.setLabel('runtime_updates_stale_reason', 'state_mismatch');
        return [];
      }

      if (update.checked_at === persistedState.last_checked_at) {
        opts.trace?.setLabel('runtime_updates_baseline', 'stale');
        opts.trace?.setLabel('runtime_updates_stale_monitor_id', update.monitor_id);
        opts.trace?.setLabel('runtime_updates_stale_reason', 'heartbeat_unverified');
        return [];
      }
    }

    opts.trace?.setLabel('runtime_updates_baseline', 'persisted');
    return opts.updates;
  }

  const runtimeById = toMonitorRuntimeEntryMap(runtimeSnapshot);
  for (const update of opts.updates) {
    const runtimeEntry = runtimeById.get(update.monitor_id);
    if (!runtimeEntry || runtimeEntry.last_checked_at === null) {
      continue;
    }

    if (update.checked_at < runtimeEntry.last_checked_at) {
      opts.trace?.setLabel('runtime_updates_baseline', 'stale');
      opts.trace?.setLabel('runtime_updates_stale_monitor_id', update.monitor_id);
      opts.trace?.setLabel('runtime_updates_stale_reason', 'checked_at_regressed');
      return [];
    }

    if (update.checked_at > runtimeEntry.last_checked_at) {
      continue;
    }

    if (fromRuntimeStatusCode(runtimeEntry.last_status_code) !== readRuntimeUpdateCurrentStatus(update)) {
      opts.trace?.setLabel('runtime_updates_baseline', 'stale');
      opts.trace?.setLabel('runtime_updates_stale_monitor_id', update.monitor_id);
      opts.trace?.setLabel('runtime_updates_stale_reason', 'state_mismatch');
      return [];
    }

    const latestHeartbeatStatusCode = runtimeEntry.heartbeat_status_codes[0];
    if (
      latestHeartbeatStatusCode === 'u' ||
      latestHeartbeatStatusCode === 'd' ||
      latestHeartbeatStatusCode === 'm' ||
      latestHeartbeatStatusCode === 'p' ||
      latestHeartbeatStatusCode === 'x'
    ) {
      if (fromRuntimeStatusCode(latestHeartbeatStatusCode) !== readRuntimeUpdateHeartbeatStatus(update)) {
        opts.trace?.setLabel('runtime_updates_baseline', 'stale');
        opts.trace?.setLabel('runtime_updates_stale_monitor_id', update.monitor_id);
        opts.trace?.setLabel('runtime_updates_stale_reason', 'heartbeat_mismatch');
        return [];
      }

      if ((runtimeEntry.heartbeat_latency_ms[0] ?? null) !== update.latency_ms) {
        opts.trace?.setLabel('runtime_updates_baseline', 'stale');
        opts.trace?.setLabel('runtime_updates_stale_monitor_id', update.monitor_id);
        opts.trace?.setLabel('runtime_updates_stale_reason', 'latency_mismatch');
        return [];
      }
    }
  }

  opts.trace?.setLabel('runtime_updates_baseline', 'ok');
  return opts.updates;
}

function buildInternalRefreshResponse(ok: boolean, refreshed: boolean): Response {
  return new Response(JSON.stringify({ ok, refreshed }), {
    status: ok ? 200 : 500,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function buildNotFoundJsonResponse(origin: string | null): Response {
  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    Vary: 'Origin',
  });
  if (origin) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Authorization,Content-Type');
  }
  return new Response(
    JSON.stringify({
      error: {
        code: 'NOT_FOUND',
        message: 'Not Found',
      },
    }),
    {
      status: 404,
      headers,
    },
  );
}

const internalRefreshJsonBodySchema = z.object({
  token: z.string().optional(),
  runtime_updates: z.array(z.unknown()).optional(),
});

type InternalScheduledCheckBatchBody = {
  token?: string;
  ids: number[];
  checked_at: number;
  suppressed_monitor_ids?: number[];
  state_failures_to_down_from_up: number;
  state_successes_to_up_from_down: number;
  allow_notifications?: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isInternalRefreshBody(
  value: unknown,
): value is { token?: string; runtime_updates?: unknown } {
  return isRecord(value);
}

function parseInternalRefreshRuntimeUpdates(
  value: unknown,
): { runtime_updates?: MonitorRuntimeUpdate[] } | null {
  if (!isInternalRefreshBody(value)) {
    return null;
  }
  if (value.token !== undefined && typeof value.token !== 'string') {
    return null;
  }
  if (value.runtime_updates === undefined) {
    return {};
  }

  const runtimeUpdates = parseMonitorRuntimeUpdates(value.runtime_updates);
  return runtimeUpdates ? { runtime_updates: runtimeUpdates } : null;
}

function parseInternalScheduledCheckBatchBody(value: unknown): InternalScheduledCheckBatchBody | null {
  if (!isRecord(value)) {
    return null;
  }
  if (value.token !== undefined && typeof value.token !== 'string') {
    return null;
  }
  if (!Array.isArray(value.ids) || value.ids.length === 0 || !value.ids.every(isPositiveInteger)) {
    return null;
  }
  if (!isNonNegativeInteger(value.checked_at)) {
    return null;
  }
  if (
    value.suppressed_monitor_ids !== undefined &&
    (!Array.isArray(value.suppressed_monitor_ids) ||
      !value.suppressed_monitor_ids.every(isPositiveInteger))
  ) {
    return null;
  }
  if (
    !isPositiveInteger(value.state_failures_to_down_from_up) ||
    value.state_failures_to_down_from_up > 10 ||
    !isPositiveInteger(value.state_successes_to_up_from_down) ||
    value.state_successes_to_up_from_down > 10
  ) {
    return null;
  }
  if (
    value.allow_notifications !== undefined &&
    typeof value.allow_notifications !== 'boolean'
  ) {
    return null;
  }

  return {
    ...(value.token !== undefined ? { token: value.token } : {}),
    ids: value.ids,
    checked_at: value.checked_at,
    ...(value.suppressed_monitor_ids !== undefined
      ? { suppressed_monitor_ids: value.suppressed_monitor_ids }
      : {}),
    state_failures_to_down_from_up: value.state_failures_to_down_from_up,
    state_successes_to_up_from_down: value.state_successes_to_up_from_down,
    ...(value.allow_notifications !== undefined
      ? { allow_notifications: value.allow_notifications }
      : {}),
  };
}

function finalizeInternalRefreshResponse(
  res: Response,
  trace: Trace | null,
  traceMod: typeof import('./observability/trace') | null,
  info: { refreshed?: boolean; error?: boolean },
): Response {
  if (!trace?.enabled || !traceMod) {
    return res;
  }

  if (typeof info.refreshed === 'boolean') {
    trace.setLabel('refreshed', info.refreshed);
  }
  if (info.error) {
    trace.setLabel('error', '1');
  }

  trace.finish('total');
  traceMod.applyTraceToResponse({ res, trace, prefix: 'w' });
  console.log(
    info.error
      ? `internal-refresh: id=${trace.id} failed=1 timing=${trace.toServerTiming('w')} info=${trace.toInfoHeader()}`
      : `internal-refresh: id=${trace.id} refreshed=${info.refreshed} timing=${trace.toServerTiming('w')} info=${trace.toInfoHeader()}`,
  );
  return res;
}

async function handleInternalHomepageRefresh(request: Request, env: Env): Promise<Response> {
  if (!isInternalServiceRequest(request)) {
    return buildNotFoundJsonResponse(request.headers.get('Origin'));
  }
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }
  if (!hasValidInternalAuth(request, env)) {
    return new Response('Forbidden', { status: 403 });
  }
  if (isRequestBodyTooLarge(request)) {
    return new Response('Payload Too Large', { status: 413 });
  }

  let runtimeUpdates: MonitorRuntimeUpdate[] | undefined;
  const scheduledRefreshRequest = isScheduledRefreshRequest(request);
  const contentType = request.headers.get('Content-Type') ?? '';

  if (contentType.includes('application/json')) {
    const rawBody = await request.json().catch(() => null);
    const parsedBody = scheduledRefreshRequest
      ? parseInternalRefreshRuntimeUpdates(rawBody)
      : (() => {
          const parsed = internalRefreshJsonBodySchema.safeParse(rawBody);
          if (!parsed.success) {
            return null;
          }

          const runtime_updates = parsed.data.runtime_updates;
          if (runtime_updates === undefined) {
            return {};
          }

          const parsedRuntimeUpdates = parseMonitorRuntimeUpdates(runtime_updates);
          return parsedRuntimeUpdates ? { runtime_updates: parsedRuntimeUpdates } : null;
        })();
    if (!parsedBody) {
      return new Response('Forbidden', { status: 403 });
    }

    runtimeUpdates = parsedBody.runtime_updates;
  }

  const now = Math.floor(Date.now() / 1000);
  let traceMod: typeof import('./observability/trace') | null = null;
  let trace: Trace | null = null;
  if (normalizeTruthyHeader(request.headers.get('X-Uptimer-Trace'))) {
    traceMod = await import('./observability/trace');
    trace = new traceMod.Trace(
      traceMod.resolveTraceOptions({
        header: (name) => request.headers.get(name) ?? undefined,
        env: env as unknown as Record<string, unknown>,
      }),
    );
  }
  if (trace?.enabled) {
    trace.setLabel('route', 'internal/homepage-refresh');
    trace.setLabel('now', now);
    trace.setLabel('runtime_updates_count', runtimeUpdates?.length ?? 0);
  }
  const fastPathRuntimeUpdates =
    scheduledRefreshRequest && runtimeUpdates
      ? await sanitizeScheduledRuntimeUpdatesForFastPath({
          db: env.DB,
          now,
          updates: runtimeUpdates,
          trace,
        })
      : (runtimeUpdates ?? []);
  if (trace?.enabled) {
    trace.setLabel('runtime_updates_fast_path_count', fastPathRuntimeUpdates.length);
  }
  const scheduledRuntimeUpdatesRequested =
    scheduledRefreshRequest && (runtimeUpdates?.length ?? 0) > 0;
  const useScheduledRuntimeFastPath =
    scheduledRefreshRequest && fastPathRuntimeUpdates.length > 0;
  const skipInitialFreshnessCheck = scheduledRuntimeUpdatesRequested;
  if (trace?.enabled && skipInitialFreshnessCheck) {
    trace.setLabel('skip_initial_freshness_check', '1');
  }

  let claimedLeaseExpiresAt: number | null = null;
  let homepageRefreshLease: ReturnType<typeof startRenewableLease> | null = null;
  let releaseHomepageRefreshLease:
    | ((
        db: D1Database,
        name: string,
        expiresAt: number,
      ) => Promise<void>)
    | null = null;

  try {
    const { readHomepageRefreshBaseSnapshot, readHomepageSnapshotGeneratedAt } = trace
      ? await trace.timeAsync(
          'import_homepage_snapshot_read_module',
          async () => await import('./snapshots/public-homepage-read'),
        )
      : await import('./snapshots/public-homepage-read');

    if (!skipInitialFreshnessCheck) {
      const generatedAt = trace
        ? await trace.timeAsync(
              'homepage_refresh_read_generated_at_1',
            async () => await readHomepageSnapshotGeneratedAt(env.DB, now),
          )
        : await readHomepageSnapshotGeneratedAt(env.DB, now);
      if (generatedAt !== null && isSameMinute(generatedAt, now)) {
        if (trace?.enabled) {
          trace.setLabel('skip', 'fresh');
        }
        return finalizeInternalRefreshResponse(
          buildInternalRefreshResponse(true, false),
          trace,
          traceMod,
          { refreshed: false },
        );
      }
    }

    const { acquireLease, releaseLease } = trace
      ? await trace.timeAsync(
          'import_scheduler_lock_module',
          async () => await import('./scheduler/lock'),
        )
      : await import('./scheduler/lock');
    releaseHomepageRefreshLease = releaseLease;
    const acquired = trace
      ? await trace.timeAsync(
          'homepage_refresh_lease',
          async () =>
            await acquireLease(
              env.DB,
              HOMEPAGE_REFRESH_LOCK_NAME,
              now,
              HOMEPAGE_REFRESH_LOCK_LEASE_SECONDS,
            ),
        )
      : await acquireLease(
          env.DB,
          HOMEPAGE_REFRESH_LOCK_NAME,
          now,
          HOMEPAGE_REFRESH_LOCK_LEASE_SECONDS,
        );
    if (!acquired) {
      if (trace?.enabled) {
        trace.setLabel('skip', 'lease');
      }
      return finalizeInternalRefreshResponse(
        buildInternalRefreshResponse(true, false),
        trace,
        traceMod,
        { refreshed: false },
      );
    }
    claimedLeaseExpiresAt = now + HOMEPAGE_REFRESH_LOCK_LEASE_SECONDS;
    homepageRefreshLease = startRenewableLease({
      db: env.DB,
      name: HOMEPAGE_REFRESH_LOCK_NAME,
      leaseSeconds: HOMEPAGE_REFRESH_LOCK_LEASE_SECONDS,
      initialExpiresAt: claimedLeaseExpiresAt,
      renewIntervalMs: HOMEPAGE_REFRESH_LOCK_RENEW_INTERVAL_MS,
      renewMinRemainingSeconds: HOMEPAGE_REFRESH_LOCK_RENEW_MIN_REMAINING_SECONDS,
      logPrefix: 'internal refresh',
    });

    const baseSnapshot = trace
      ? await trace.timeAsync(
          'homepage_refresh_read_snapshot_base',
          async () => await readHomepageRefreshBaseSnapshot(env.DB, now),
        )
      : await readHomepageRefreshBaseSnapshot(env.DB, now);
    if (trace?.enabled) {
      trace.setLabel('base_seed_data', baseSnapshot.seedDataSnapshot ? '1' : '0');
      trace.setLabel(
        'base_age_s',
        baseSnapshot.generatedAt === null ? 'none' : Math.max(0, now - baseSnapshot.generatedAt),
      );
    }
    const shouldHonorFreshAfterLeaseGate = !scheduledRuntimeUpdatesRequested;
    if (
      shouldHonorFreshAfterLeaseGate &&
      baseSnapshot.generatedAt !== null &&
      isSameMinute(baseSnapshot.generatedAt, now)
    ) {
      if (trace?.enabled) {
        trace.setLabel('skip', 'fresh_after_lease');
      }
      return finalizeInternalRefreshResponse(
        buildInternalRefreshResponse(true, false),
        trace,
        traceMod,
        { refreshed: false },
      );
    }

    const [homepageMod, snapshotMod, statusMod, statusSnapshotMod] = await Promise.all([
      trace
        ? trace.timeAsync('import_homepage_module', async () => await import('./public/homepage'))
        : import('./public/homepage'),
      trace
        ? trace.timeAsync(
            'import_homepage_snapshot_module',
            async () => await import('./snapshots/public-homepage'),
          )
        : import('./snapshots/public-homepage'),
      trace
        ? trace.timeAsync(
            'import_status_refresh_module',
            async () => await import('./public/status-refresh'),
          )
        : import('./public/status-refresh'),
      trace
        ? trace.timeAsync(
            'import_status_snapshot_module',
            async () => await import('./snapshots/public-status'),
          )
        : import('./snapshots/public-status'),
    ]);
    let statusFastGuardState:
      | {
          settings: {
            site_title: string;
            site_description: string;
            site_locale: 'auto' | 'en' | 'zh-CN' | 'zh-TW' | 'ja' | 'es';
            site_timezone: string;
            retention_check_results_days: number;
            state_failures_to_down_from_up: number;
            state_successes_to_up_from_down: number;
            admin_default_overview_range: '24h' | '7d';
            admin_default_monitor_range: '24h' | '7d' | '30d' | '90d';
            uptime_rating_level: 1 | 2 | 3 | 4 | 5;
          };
          monitorMetadataStamp: {
            monitorCountTotal: number;
            maxUpdatedAt: number | null;
          };
          hasActiveIncidents: boolean;
          hasActiveMaintenance: boolean;
          hasUpcomingMaintenance: boolean;
        }
      | undefined;
    let payload =
      useScheduledRuntimeFastPath && baseSnapshot.snapshot
        ? trace
          ? await trace.timeAsync(
              'homepage_refresh_fast_compute',
              async () =>
                await homepageMod.tryComputePublicHomepagePayloadFromScheduledRuntimeUpdates({
                  db: env.DB,
                  now,
                  baseSnapshot: baseSnapshot.snapshot,
                  baseSnapshotBodyJson: null,
                  updates: fastPathRuntimeUpdates,
                  trace,
                  onGuardState: (guardState) => {
                    statusFastGuardState = {
                      settings: guardState.settings,
                      monitorMetadataStamp: guardState.monitorMetadataStamp,
                      hasActiveIncidents: guardState.hasActiveIncidents,
                      hasActiveMaintenance: guardState.hasActiveMaintenance,
                      hasUpcomingMaintenance: guardState.hasUpcomingMaintenance,
                    };
                  },
                }),
            )
          : await homepageMod.tryComputePublicHomepagePayloadFromScheduledRuntimeUpdates({
              db: env.DB,
              now,
              baseSnapshot: baseSnapshot.snapshot,
              baseSnapshotBodyJson: null,
              updates: fastPathRuntimeUpdates,
              onGuardState: (guardState) => {
                statusFastGuardState = {
                  settings: guardState.settings,
                  monitorMetadataStamp: guardState.monitorMetadataStamp,
                  hasActiveIncidents: guardState.hasActiveIncidents,
                  hasActiveMaintenance: guardState.hasActiveMaintenance,
                  hasUpcomingMaintenance: guardState.hasUpcomingMaintenance,
                };
              },
            })
        : null;
    if (trace?.enabled && payload) {
      trace.setLabel('fast_path', 'scheduled_runtime');
    }
    if (payload === null) {
      if (trace?.enabled && skipInitialFreshnessCheck) {
        trace.setLabel('fast_path', 'full_compute_fallback');
      }
      const computed = trace
        ? await trace.timeAsync(
            'homepage_refresh_compute',
            async () =>
              await homepageMod.computePublicHomepagePayload(env.DB, now, {
                trace,
                baseSnapshot: baseSnapshot.snapshot,
                baseSnapshotBodyJson: null,
              }),
          )
        : await homepageMod.computePublicHomepagePayload(env.DB, now, {
            baseSnapshot: baseSnapshot.snapshot,
            baseSnapshotBodyJson: null,
          });
      payload = computed;
    }
    payload = trace
      ? trace.time('homepage_refresh_validate', () =>
          snapshotMod.toHomepageSnapshotPayload(payload),
        )
      : snapshotMod.toHomepageSnapshotPayload(payload);
    homepageRefreshLease.assertHeld('writing homepage snapshot');
    const homepageSnapshotWritten = trace
      ? await trace.timeAsync(
          'homepage_refresh_write',
          async () =>
            await snapshotMod.writeHomepageSnapshot(
              env.DB,
              now,
              payload,
              trace,
              baseSnapshot.seedDataSnapshot,
            ),
        )
      : await snapshotMod.writeHomepageSnapshot(
          env.DB,
          now,
          payload,
          undefined,
          baseSnapshot.seedDataSnapshot,
        );
    if (!homepageSnapshotWritten) {
      if (trace?.enabled) {
        trace.setLabel('skip', 'homepage_write_noop');
      }
      return finalizeInternalRefreshResponse(
        buildInternalRefreshResponse(true, false),
        trace,
        traceMod,
        { refreshed: false },
      );
    }

    homepageRefreshLease.assertHeld('writing status snapshot');
    const statusRefreshArgs = statusFastGuardState
      ? {
          db: env.DB,
          now,
          updates: fastPathRuntimeUpdates,
          guardState: statusFastGuardState,
        }
      : {
          db: env.DB,
          now,
          updates: fastPathRuntimeUpdates,
        };
    const refreshedStatusPayload = trace
      ? await trace.timeAsync(
          'status_refresh_fast_compute',
          async () =>
            await statusMod.tryComputePublicStatusPayloadFromScheduledRuntimeUpdates(statusRefreshArgs),
        )
      : await statusMod.tryComputePublicStatusPayloadFromScheduledRuntimeUpdates(statusRefreshArgs);
    if (refreshedStatusPayload) {
      homepageRefreshLease.assertHeld('writing status snapshot');
      if (trace) {
        await trace.timeAsync(
          'status_refresh_write',
          async () => await statusSnapshotMod.writeStatusSnapshot(env.DB, now, refreshedStatusPayload),
        );
      } else {
        await statusSnapshotMod.writeStatusSnapshot(env.DB, now, refreshedStatusPayload);
      }
      trace?.setLabel('status_refresh', 'patched');
    } else {
      trace?.setLabel('status_refresh', 'skipped');
    }

    return finalizeInternalRefreshResponse(
      buildInternalRefreshResponse(true, true),
      trace,
      traceMod,
      { refreshed: true },
    );
  } catch (err) {
    if (err instanceof LeaseLostError) {
      console.warn(err.message);
      if (trace?.enabled) {
        trace.setLabel('skip', 'lease_lost');
      }
      return finalizeInternalRefreshResponse(
        buildInternalRefreshResponse(true, false),
        trace,
        traceMod,
        { refreshed: false },
      );
    }

    console.warn('internal refresh: homepage failed', err);
    return finalizeInternalRefreshResponse(
      buildInternalRefreshResponse(false, false),
      trace,
      traceMod,
      { error: true },
    );
  } finally {
    if (homepageRefreshLease) {
      await homepageRefreshLease.stop().catch((err) => {
        console.warn('internal refresh: lease renewal task failed', err);
      });
    }
    if (claimedLeaseExpiresAt !== null && releaseHomepageRefreshLease) {
      await releaseHomepageRefreshLease(
        env.DB,
        HOMEPAGE_REFRESH_LOCK_NAME,
        homepageRefreshLease?.getExpiresAt() ?? claimedLeaseExpiresAt,
      ).catch((err) => {
        console.warn('internal refresh: failed to release homepage lease', err);
      });
    }
  }
}

async function handleInternalScheduledCheckBatch(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const maxPastCheckedAtSkewSeconds = 5 * 60;
  if (!isInternalServiceRequest(request)) {
    return buildNotFoundJsonResponse(request.headers.get('Origin'));
  }
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }
  if (!hasValidInternalAuth(request, env)) {
    return new Response('Forbidden', { status: 403 });
  }
  if (isRequestBodyTooLarge(request)) {
    return new Response('Payload Too Large', { status: 413 });
  }

  const parsedBody = parseInternalScheduledCheckBatchBody(await request.json().catch(() => null));
  if (!parsedBody) {
    return new Response('Forbidden', { status: 403 });
  }
  const now = Math.floor(Date.now() / 1000);
  const currentCheckedAt = Math.floor(now / 60) * 60;
  if (
    parsedBody.checked_at > currentCheckedAt ||
    parsedBody.checked_at < currentCheckedAt - maxPastCheckedAtSkewSeconds
  ) {
    return new Response('Forbidden', { status: 403 });
  }

  const ids = [...new Set(parsedBody.ids)];
  const suppressedMonitorIds = new Set(parsedBody.suppressed_monitor_ids ?? []);
  const [{ runExclusivePersistedMonitorBatch }, notificationsModule] =
    await Promise.all([
      import('./scheduler/scheduled'),
      parsedBody.allow_notifications === true
        ? import('./scheduler/notifications')
        : Promise.resolve(null),
    ]);

  const notify = notificationsModule
    ? await notificationsModule.createNotifyContext(env, ctx)
    : null;
  let result;
  try {
    result = await runExclusivePersistedMonitorBatch({
      db: env.DB,
      ids,
      checkedAt: parsedBody.checked_at,
      abortSignal: request.signal,
      suppressedMonitorIds,
      stateMachineConfig: {
        failuresToDownFromUp: parsedBody.state_failures_to_down_from_up,
        successesToUpFromDown: parsedBody.state_successes_to_up_from_down,
      },
      ...(notificationsModule && notify
        ? {
            onPersistedMonitor: (completed: CompletedDueMonitor) =>
              notificationsModule.queueMonitorNotification(env, notify, completed),
          }
        : {}),
    });
  } catch (err) {
    if (err instanceof LeaseLostError) {
      console.warn(err.message);
      return new Response('Service Unavailable', {
        status: 503,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      });
    }
    console.error('internal scheduled check batch failed', err);
    return new Response('Internal Server Error', {
      status: 500,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  }

  return new Response(
    JSON.stringify({
      ok: true,
      runtime_updates: wantsCompactInternalFormat(request)
        ? encodeMonitorRuntimeUpdatesCompact(result.runtimeUpdates)
        : result.runtimeUpdates,
      processed_count: result.stats.processedCount,
      rejected_count: result.stats.rejectedCount,
      attempt_total: result.stats.attemptTotal,
      http_count: result.stats.httpCount,
      tcp_count: result.stats.tcpCount,
      assertion_count: result.stats.assertionCount,
      down_count: result.stats.downCount,
      unknown_count: result.stats.unknownCount,
      checks_duration_ms: result.checksDurMs,
      persist_duration_ms: result.persistDurMs,
    }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    },
  );
}

export default {
  fetch: async (request: Request, env: Env, ctx: ExecutionContext): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname === '/api/v1/internal/refresh/homepage') {
      return handleInternalHomepageRefresh(request, env);
    }
    if (url.pathname === '/api/v1/internal/scheduled/check-batch') {
      return handleInternalScheduledCheckBatch(request, env, ctx);
    }

    const mod = await import('./fetch-handler');
    return mod.handleFetch(request, env, ctx);
  },
  scheduled: async (controller: ScheduledController, env: Env, ctx: ExecutionContext) => {
    if (controller.cron === '0 0 * * *') {
      const { runDailyRollup } = await import('./scheduler/daily-rollup');
      await runDailyRollup(env, controller, ctx);
      return;
    }
    if (controller.cron === '30 0 * * *') {
      const { runRetention } = await import('./scheduler/retention');
      await runRetention(env, controller);
      return;
    }

    const { runScheduledTick } = await import('./scheduler/scheduled');
    await runScheduledTick(env, ctx);
  },
} satisfies ExportedHandler<Env>;
