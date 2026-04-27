import { z } from 'zod';

import type { Env } from './env';
import type { Trace } from './observability/trace';
import {
  normalizeInternalTruthy,
  runInternalHomepageRefreshCore,
} from './internal/homepage-refresh-core';
import {
  encodeMonitorRuntimeUpdatesCompact,
  parseMonitorRuntimeUpdates,
  type MonitorRuntimeUpdate,
} from './public/monitor-runtime';
import type { CompletedDueMonitor } from './scheduler/scheduled';
import { LeaseLostError } from './scheduler/lease-guard';

const INTERNAL_REQUEST_MAX_BYTES = 256 * 1024;
const INTERNAL_PROTOCOL_FORMAT = 'compact-v1';

function normalizeTruthyHeader(value: string | null): boolean {
  return normalizeInternalTruthy(value);
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
  const traceInfo = trace.toInfoHeader();
  const serverTiming = trace.toServerTiming('w');
  traceMod.applyTraceToResponse({ res, trace, prefix: 'w', info: traceInfo, serverTiming });
  console.log(
    info.error
      ? `internal-refresh: id=${trace.id} failed=1 timing=${serverTiming} info=${traceInfo}`
      : `internal-refresh: id=${trace.id} refreshed=${info.refreshed} timing=${serverTiming} info=${traceInfo}`,
  );
  return res;
}

function finalizeInternalCheckBatchResponse(
  res: Response,
  trace: Trace | null,
  traceMod: typeof import('./observability/trace') | null,
  info: { ok?: boolean; error?: boolean },
): Response {
  if (!trace?.enabled || !traceMod) {
    return res;
  }

  if (typeof info.ok === 'boolean') {
    trace.setLabel('ok', info.ok);
  }
  if (info.error) {
    trace.setLabel('error', '1');
  }

  trace.finish('total');
  const traceInfo = trace.toInfoHeader();
  const serverTiming = trace.toServerTiming('w');
  traceMod.applyTraceToResponse({ res, trace, prefix: 'w', info: traceInfo, serverTiming });
  console.log(
    info.error
      ? `internal-check-batch: id=${trace.id} failed=1 timing=${serverTiming} info=${traceInfo}`
      : `internal-check-batch: id=${trace.id} ok=${info.ok} timing=${serverTiming} info=${traceInfo}`,
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

  let runtimeUpdates: MonitorRuntimeUpdate[] | undefined;
  const scheduledRefreshRequest = isScheduledRefreshRequest(request);
  const contentType = request.headers.get('Content-Type') ?? '';
  const traceResidualDetails =
    trace?.enabled === true && normalizeTruthyHeader(env.UPTIMER_HOMEPAGE_RESIDUAL_TRACE ?? null);
  const detailTrace: Trace | undefined = traceResidualDetails && trace ? trace : undefined;

  if (trace?.enabled && traceResidualDetails) {
    trace.setLabel('request_content_length', request.headers.get('Content-Length') ?? 'unknown');
    trace.setLabel('internal_format', wantsCompactInternalFormat(request) ? 'compact-v1' : 'default');
  }

  if (contentType.includes('application/json')) {
    const rawBody = detailTrace
      ? await detailTrace.timeAsync('homepage_refresh_body_json_read', async () =>
          await request.json().catch(() => null),
        )
      : await request.json().catch(() => null);
    const parseBody = () =>
      scheduledRefreshRequest
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
    const parsedBody = detailTrace
      ? detailTrace.time('homepage_refresh_body_parse_validate', parseBody)
      : parseBody();
    if (!parsedBody) {
      return new Response('Forbidden', { status: 403 });
    }

    runtimeUpdates = parsedBody.runtime_updates;
  }

  const result = await runInternalHomepageRefreshCore({
    env,
    now: Math.floor(Date.now() / 1000),
    scheduledRefreshRequest,
    ...(runtimeUpdates ? { runtimeUpdates } : {}),
    trace,
  });

  return finalizeInternalRefreshResponse(
    buildInternalRefreshResponse(result.ok, result.refreshed),
    trace,
    traceMod,
    { refreshed: result.refreshed, ...(result.error ? { error: true } : {}) },
  );
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
  trace?.setLabel('route', 'internal/scheduled-check-batch');

  const rawBody = trace
    ? await trace.timeAsync('check_batch_parse_body', async () => await request.json().catch(() => null))
    : await request.json().catch(() => null);
  const parsedBody = parseInternalScheduledCheckBatchBody(rawBody);
  if (!parsedBody) {
    return new Response('Forbidden', { status: 403 });
  }
  const now = Math.floor(Date.now() / 1000);
  trace?.setLabel('now', now);
  trace?.setLabel('checked_at', parsedBody.checked_at);
  trace?.setLabel('ids', parsedBody.ids.length);
  trace?.setLabel('allow_notifications', parsedBody.allow_notifications === true);
  const currentCheckedAt = Math.floor(now / 60) * 60;
  if (
    parsedBody.checked_at > currentCheckedAt ||
    parsedBody.checked_at < currentCheckedAt - maxPastCheckedAtSkewSeconds
  ) {
    return new Response('Forbidden', { status: 403 });
  }

  const ids = [...new Set(parsedBody.ids)];
  const suppressedMonitorIds = new Set(parsedBody.suppressed_monitor_ids ?? []);
  const [{ runExclusivePersistedMonitorBatch }, notificationsModule] = await (trace
    ? trace.timeAsync(
        'check_batch_import_modules',
        async () =>
          await Promise.all([
            import('./scheduler/scheduled'),
            parsedBody.allow_notifications === true
              ? import('./scheduler/notifications')
              : Promise.resolve(null),
          ]),
      )
    : Promise.all([
        import('./scheduler/scheduled'),
        parsedBody.allow_notifications === true
          ? import('./scheduler/notifications')
          : Promise.resolve(null),
      ]));

  const notify = notificationsModule
    ? trace
      ? await trace.timeAsync(
          'check_batch_notify_context',
          async () => await notificationsModule.createNotifyContext(env, ctx),
        )
      : await notificationsModule.createNotifyContext(env, ctx)
    : null;
  let result;
  try {
    const runBatch = async () =>
      await runExclusivePersistedMonitorBatch({
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
        ...(trace ? { trace } : {}),
      });
    result = trace ? await trace.timeAsync('check_batch_run', runBatch) : await runBatch();
  } catch (err) {
    if (err instanceof LeaseLostError) {
      console.warn(err.message);
      return finalizeInternalCheckBatchResponse(new Response('Service Unavailable', {
        status: 503,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      }), trace, traceMod, { ok: false });
    }
    console.error('internal scheduled check batch failed', err);
    return finalizeInternalCheckBatchResponse(new Response('Internal Server Error', {
      status: 500,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    }), trace, traceMod, { ok: false, error: true });
  }

  const responsePayload = {
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
  };
  const bodyText = trace
    ? trace.time('check_batch_stringify_response', () => JSON.stringify(responsePayload))
    : JSON.stringify(responsePayload);
  return finalizeInternalCheckBatchResponse(new Response(
    bodyText,
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    },
  ), trace, traceMod, { ok: true });
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
