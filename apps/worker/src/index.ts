import type { Env } from './env';
import type { Trace } from './observability/trace';

const HOMEPAGE_REFRESH_LOCK_NAME = 'snapshot:homepage:refresh';
const HOMEPAGE_REFRESH_LOCK_LEASE_SECONDS = 55;

function normalizeTruthyHeader(value: string | null): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
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

  const token = (await request.text()).trim();
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

  try {
    const { readHomepageSnapshotGeneratedAt } = trace
      ? await trace.timeAsync(
          'import_homepage_snapshot_read_module',
          async () => await import('./snapshots/public-homepage-read'),
        )
      : await import('./snapshots/public-homepage-read');

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

    const latestGeneratedAt = trace
      ? await trace.timeAsync(
          'homepage_refresh_read_generated_at_2',
          async () => await readHomepageSnapshotGeneratedAt(env.DB),
        )
      : await readHomepageSnapshotGeneratedAt(env.DB);
    if (latestGeneratedAt !== null && isSameMinute(latestGeneratedAt, now)) {
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
    const computed = trace
      ? await trace.timeAsync(
          'homepage_refresh_compute',
          async () => await homepageMod.computePublicHomepagePayload(env.DB, now, { trace }),
        )
      : await homepageMod.computePublicHomepagePayload(env.DB, now);
    const payload = trace
      ? trace.time('homepage_refresh_validate', () =>
          snapshotMod.toHomepageSnapshotPayload(computed),
        )
      : snapshotMod.toHomepageSnapshotPayload(computed);
    if (trace) {
      await trace.timeAsync(
        'homepage_refresh_write',
        async () => await snapshotMod.writeHomepageSnapshot(env.DB, now, payload, trace),
      );
    } else {
      await snapshotMod.writeHomepageSnapshot(env.DB, now, payload);
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

export default {
  fetch: async (request: Request, env: Env, ctx: ExecutionContext): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname === '/api/v1/internal/refresh/homepage') {
      return handleInternalHomepageRefresh(request, env);
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
