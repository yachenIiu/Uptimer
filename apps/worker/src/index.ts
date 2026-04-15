import { z } from 'zod';

import type { Env } from './env';
import type { Trace } from './observability/trace';
import type { CompletedDueMonitor } from './scheduler/scheduled';

const HOMEPAGE_REFRESH_LOCK_NAME = 'snapshot:homepage:refresh';
const HOMEPAGE_REFRESH_LOCK_LEASE_SECONDS = 55;

function normalizeTruthyHeader(value: string | null): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function isScheduledRefreshRequest(request: Request): boolean {
  return request.headers.get('X-Uptimer-Refresh-Source') === 'scheduled';
}

function isSameMinute(a: number, b: number): boolean {
  return Math.floor(a / 60) === Math.floor(b / 60);
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

const internalRefreshJsonBodySchema = z.object({
  token: z.string(),
  runtime_updates: z
    .array(
      z.object({
        monitor_id: z.number().int().positive(),
        interval_sec: z.number().int().positive(),
        created_at: z.number().int().nonnegative(),
        checked_at: z.number().int().nonnegative(),
        check_status: z.string().nullable(),
        next_status: z.string().nullable(),
        latency_ms: z.number().nullable(),
      }),
    )
    .optional(),
});

const internalScheduledCheckBatchJsonBodySchema = z.object({
  token: z.string(),
  ids: z.array(z.number().int().positive()).min(1),
  checked_at: z.number().int().nonnegative(),
  suppressed_monitor_ids: z.array(z.number().int().positive()).optional(),
  state_failures_to_down_from_up: z.number().int().min(1).max(10),
  state_successes_to_up_from_down: z.number().int().min(1).max(10),
  allow_notifications: z.boolean().optional(),
});

function finalizeInternalRefreshResponse(
  res: Response,
  trace: Trace | null,
  traceMod: typeof import('./observability/trace') | null,
  info: { refreshed?: boolean; error?: boolean },
): Response {
  if (!trace || !traceMod) {
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
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  let token = '';
  let runtimeUpdates:
    | Array<{
        monitor_id: number;
        interval_sec: number;
        created_at: number;
        checked_at: number;
        check_status: string | null;
        next_status: string | null;
        latency_ms: number | null;
      }>
    | undefined;
  const contentType = request.headers.get('Content-Type') ?? '';

  if (contentType.includes('application/json')) {
    const parsedBody = internalRefreshJsonBodySchema.safeParse(
      await request.json().catch(() => null),
    );
    if (!parsedBody.success) {
      return new Response('Forbidden', { status: 403 });
    }

    token = parsedBody.data.token.trim();
    runtimeUpdates = parsedBody.data.runtime_updates;
  } else {
    token = (await request.text()).trim();
  }

  if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) {
    return new Response('Forbidden', { status: 403 });
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
  }
  const skipInitialFreshnessCheck = isScheduledRefreshRequest(request);
  if (trace?.enabled && skipInitialFreshnessCheck) {
    trace.setLabel('skip_initial_freshness_check', '1');
  }

  try {
    const {
      readHomepageRefreshBaseSnapshot,
      readHomepageSnapshotGeneratedAt,
    } = trace
      ? await trace.timeAsync(
          'import_homepage_snapshot_read_module',
          async () => await import('./snapshots/public-homepage-read'),
        )
      : await import('./snapshots/public-homepage-read');

    if (!skipInitialFreshnessCheck) {
      const generatedAt = trace
        ? await trace.timeAsync(
            'homepage_refresh_read_generated_at_1',
            async () => await readHomepageSnapshotGeneratedAt(env.DB),
          )
        : await readHomepageSnapshotGeneratedAt(env.DB);
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

    if (!skipInitialFreshnessCheck) {
      const { acquireLease } = trace
        ? await trace.timeAsync(
            'import_scheduler_lock_module',
            async () => await import('./scheduler/lock'),
          )
        : await import('./scheduler/lock');
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
    }

    const baseSnapshot = trace
      ? await trace.timeAsync(
          'homepage_refresh_read_snapshot_base',
          async () => await readHomepageRefreshBaseSnapshot(env.DB, now),
        )
      : await readHomepageRefreshBaseSnapshot(env.DB, now);
    if (baseSnapshot.generatedAt !== null && isSameMinute(baseSnapshot.generatedAt, now)) {
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

    const [homepageMod, snapshotMod] = await Promise.all([
      trace
        ? trace.timeAsync('import_homepage_module', async () => await import('./public/homepage'))
        : import('./public/homepage'),
      trace
        ? trace.timeAsync(
            'import_homepage_snapshot_module',
            async () => await import('./snapshots/public-homepage'),
          )
        : import('./snapshots/public-homepage'),
    ]);
    const fastComputed =
      skipInitialFreshnessCheck && baseSnapshot.bodyJson
        ? trace
          ? await trace.timeAsync(
              'homepage_refresh_fast_compute',
              async () =>
                await homepageMod.tryComputePublicHomepagePayloadFromScheduledRuntimeUpdates({
                  db: env.DB,
                  now,
                  baseSnapshotBodyJson: baseSnapshot.bodyJson,
                  updates: runtimeUpdates ?? [],
                  trace,
                }),
            )
          : await homepageMod.tryComputePublicHomepagePayloadFromScheduledRuntimeUpdates({
              db: env.DB,
              now,
              baseSnapshotBodyJson: baseSnapshot.bodyJson,
              updates: runtimeUpdates ?? [],
            })
        : null;
    if (trace?.enabled && fastComputed) {
      trace.setLabel('fast_path', 'scheduled_runtime');
    }
    const computed = fastComputed
      ? fastComputed
      : trace
        ? await trace.timeAsync(
            'homepage_refresh_compute',
            async () =>
              await homepageMod.computePublicHomepagePayload(env.DB, now, {
                trace,
                baseSnapshotBodyJson: baseSnapshot.bodyJson,
              }),
          )
        : await homepageMod.computePublicHomepagePayload(env.DB, now, {
            baseSnapshotBodyJson: baseSnapshot.bodyJson,
          });
    const payload = trace
      ? trace.time('homepage_refresh_validate', () =>
          snapshotMod.toHomepageSnapshotPayload(computed),
        )
      : snapshotMod.toHomepageSnapshotPayload(computed);
    if (trace) {
      await trace.timeAsync(
        'homepage_refresh_write',
        async () =>
          await snapshotMod.writeHomepageSnapshot(
            env.DB,
            now,
            payload,
            trace,
            baseSnapshot.seedDataSnapshot,
          ),
      );
    } else {
      await snapshotMod.writeHomepageSnapshot(
        env.DB,
        now,
        payload,
        undefined,
        baseSnapshot.seedDataSnapshot,
      );
    }

    return finalizeInternalRefreshResponse(
      buildInternalRefreshResponse(true, true),
      trace,
      traceMod,
      { refreshed: true },
    );
  } catch (err) {
    console.warn('internal refresh: homepage failed', err);
    return finalizeInternalRefreshResponse(
      buildInternalRefreshResponse(false, false),
      trace,
      traceMod,
      { error: true },
    );
  }
}

async function handleInternalScheduledCheckBatch(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const parsedBody = internalScheduledCheckBatchJsonBodySchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsedBody.success) {
    return new Response('Forbidden', { status: 403 });
  }

  const token = parsedBody.data.token.trim();
  if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) {
    return new Response('Forbidden', { status: 403 });
  }
  const now = Math.floor(Date.now() / 1000);
  const currentCheckedAt = Math.floor(now / 60) * 60;
  if (
    parsedBody.data.checked_at > currentCheckedAt ||
    parsedBody.data.checked_at < currentCheckedAt - 60
  ) {
    return new Response('Forbidden', { status: 403 });
  }

  const ids = [...new Set(parsedBody.data.ids)];
  const suppressedMonitorIds = new Set(parsedBody.data.suppressed_monitor_ids ?? []);
  const [{ listMonitorRowsByIds, runPersistedMonitorBatch }, notificationsModule] =
    await Promise.all([
      import('./scheduler/scheduled'),
      parsedBody.data.allow_notifications === true
        ? import('./scheduler/notifications')
        : Promise.resolve(null),
    ]);

  const fetchedRows = await listMonitorRowsByIds(env.DB, ids);
  const rowById = new Map(fetchedRows.map((row) => [row.id, row]));
  const rows = ids
    .map((id) => rowById.get(id) ?? null)
    .filter((row): row is NonNullable<typeof row> => row !== null);

  const notify = notificationsModule
    ? await notificationsModule.createNotifyContext(env, ctx)
    : null;
  const result = await runPersistedMonitorBatch({
    db: env.DB,
    rows,
    checkedAt: parsedBody.data.checked_at,
    suppressedMonitorIds,
    stateMachineConfig: {
      failuresToDownFromUp: parsedBody.data.state_failures_to_down_from_up,
      successesToUpFromDown: parsedBody.data.state_successes_to_up_from_down,
    },
    ...(notificationsModule && notify
      ? {
          onPersistedMonitor: (completed: CompletedDueMonitor) =>
            notificationsModule.queueMonitorNotification(env, notify, completed),
        }
      : {}),
  });

  return new Response(
    JSON.stringify({
      ok: true,
      runtime_updates: result.runtimeUpdates,
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
      const [{ runRetention }, { runDailyRollup }] = await Promise.all([
        import('./scheduler/retention'),
        import('./scheduler/daily-rollup'),
      ]);
      await runRetention(env, controller);
      await runDailyRollup(env, controller, ctx);
      return;
    }

    const { runScheduledTick } = await import('./scheduler/scheduled');
    await runScheduledTick(env, ctx);
  },
} satisfies ExportedHandler<Env>;
