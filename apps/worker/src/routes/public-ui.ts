import { Hono } from 'hono';
import { z } from 'zod';

import type { Env } from '../env';
import { hasValidAdminTokenRequest } from '../middleware/auth';
import { AppError } from '../middleware/errors';
import { cachePublic } from '../middleware/cache-public';
import {
  buildUnknownIntervals,
  mergeIntervals,
  overlapSeconds,
  rangeToSeconds,
  sumIntervals,
  utcDayStart,
} from '../analytics/uptime';
import {
  materializeMonitorRuntimeTotals,
  MONITOR_RUNTIME_MAX_AGE_SECONDS,
  MONITOR_RUNTIME_SNAPSHOT_KEY,
  parsePublicMonitorRuntimeEntry,
  type PublicMonitorRuntimeEntry,
  readPublicMonitorRuntimeSnapshot,
  snapshotHasMonitorIds,
  toMonitorRuntimeEntryMap,
} from '../public/monitor-runtime';
import {
  buildNumberedPlaceholders,
  chunkPositiveIntegerIds,
  filterStatusPageScopedMonitorIds,
  incidentStatusPageVisibilityPredicate,
  listStatusPageVisibleMonitorIds,
  monitorVisibilityPredicate,
  shouldIncludeStatusPageScopedItem,
} from '../public/visibility';

function isAuthorizedStatusAdminRequest(c: {
  env: Pick<Env, 'ADMIN_TOKEN'>;
  req: { header(name: string): string | undefined };
}): boolean {
  return hasValidAdminTokenRequest(c);
}

function applyPrivateNoStore(res: Response): Response {
  const vary = res.headers.get('Vary');
  if (!vary) {
    res.headers.set('Vary', 'Authorization');
  } else if (!vary.split(',').some((part) => part.trim().toLowerCase() === 'authorization')) {
    res.headers.set('Vary', `${vary}, Authorization`);
  }

  res.headers.set('Cache-Control', 'private, no-store');
  return res;
}

function withVisibilityAwareCaching(res: Response, includeHiddenMonitors: boolean): Response {
  return includeHiddenMonitors ? applyPrivateNoStore(res) : res;
}

const latencyRangeSchema = z.enum(['24h']);
const uptimeRangeSchema = z.enum(['24h', '7d', '30d']);
const uptimeOverviewRangeSchema = z.enum(['30d', '90d']);

type IncidentRow = {
  id: number;
  title: string;
  status: string;
  impact: string;
  message: string | null;
  started_at: number;
  resolved_at: number | null;
};

type IncidentUpdateRow = {
  id: number;
  incident_id: number;
  status: string | null;
  message: string;
  created_at: number;
};

type IncidentMonitorLinkRow = {
  incident_id: number;
  monitor_id: number;
};

type MaintenanceWindowRow = {
  id: number;
  title: string;
  message: string | null;
  starts_at: number;
  ends_at: number;
  created_at: number;
};

type MaintenanceWindowMonitorLinkRow = {
  maintenance_window_id: number;
  monitor_id: number;
};

function toIncidentStatus(
  value: string | null,
): 'investigating' | 'identified' | 'monitoring' | 'resolved' {
  switch (value) {
    case 'investigating':
    case 'identified':
    case 'monitoring':
    case 'resolved':
      return value;
    default:
      return 'investigating';
  }
}

function toIncidentImpact(value: string | null): 'none' | 'minor' | 'major' | 'critical' {
  switch (value) {
    case 'none':
    case 'minor':
    case 'major':
    case 'critical':
      return value;
    default:
      return 'minor';
  }
}

function incidentUpdateRowToApi(row: IncidentUpdateRow) {
  return {
    id: row.id,
    incident_id: row.incident_id,
    status: row.status === null ? null : toIncidentStatus(row.status),
    message: row.message,
    created_at: row.created_at,
  };
}

function incidentRowToApi(
  row: IncidentRow,
  updates: IncidentUpdateRow[] = [],
  monitorIds: number[] = [],
) {
  return {
    id: row.id,
    title: row.title,
    status: toIncidentStatus(row.status),
    impact: toIncidentImpact(row.impact),
    message: row.message,
    started_at: row.started_at,
    resolved_at: row.resolved_at,
    monitor_ids: monitorIds,
    updates: updates.map(incidentUpdateRowToApi),
  };
}

async function listIncidentUpdatesByIncidentId(
  db: D1Database,
  incidentIds: number[],
): Promise<Map<number, IncidentUpdateRow[]>> {
  const byIncident = new Map<number, IncidentUpdateRow[]>();

  for (const ids of chunkPositiveIntegerIds(incidentIds)) {
    const placeholders = buildNumberedPlaceholders(ids.length);
    const { results } = await db
      .prepare(
        `
          SELECT id, incident_id, status, message, created_at
          FROM incident_updates
          WHERE incident_id IN (${placeholders})
          ORDER BY incident_id, created_at, id
        `,
      )
      .bind(...ids)
      .all<IncidentUpdateRow>();

    for (const row of results ?? []) {
      const existing = byIncident.get(row.incident_id) ?? [];
      existing.push(row);
      byIncident.set(row.incident_id, existing);
    }
  }

  return byIncident;
}

async function listIncidentMonitorIdsByIncidentId(
  db: D1Database,
  incidentIds: number[],
): Promise<Map<number, number[]>> {
  const byIncident = new Map<number, number[]>();

  for (const ids of chunkPositiveIntegerIds(incidentIds)) {
    const placeholders = buildNumberedPlaceholders(ids.length);
    const { results } = await db
      .prepare(
        `
          SELECT incident_id, monitor_id
          FROM incident_monitors
          WHERE incident_id IN (${placeholders})
          ORDER BY incident_id, monitor_id
        `,
      )
      .bind(...ids)
      .all<IncidentMonitorLinkRow>();

    for (const row of results ?? []) {
      const existing = byIncident.get(row.incident_id) ?? [];
      existing.push(row.monitor_id);
      byIncident.set(row.incident_id, existing);
    }
  }

  return byIncident;
}

function maintenanceWindowRowToApi(row: MaintenanceWindowRow, monitorIds: number[] = []) {
  return {
    id: row.id,
    title: row.title,
    message: row.message,
    starts_at: row.starts_at,
    ends_at: row.ends_at,
    created_at: row.created_at,
    monitor_ids: monitorIds,
  };
}

async function listMaintenanceWindowMonitorIdsByWindowId(
  db: D1Database,
  windowIds: number[],
): Promise<Map<number, number[]>> {
  const byWindow = new Map<number, number[]>();

  for (const ids of chunkPositiveIntegerIds(windowIds)) {
    const placeholders = buildNumberedPlaceholders(ids.length);
    const { results } = await db
      .prepare(
        `
          SELECT maintenance_window_id, monitor_id
          FROM maintenance_window_monitors
          WHERE maintenance_window_id IN (${placeholders})
          ORDER BY maintenance_window_id, monitor_id
        `,
      )
      .bind(...ids)
      .all<MaintenanceWindowMonitorLinkRow>();

    for (const row of results ?? []) {
      const existing = byWindow.get(row.maintenance_window_id) ?? [];
      existing.push(row.monitor_id);
      byWindow.set(row.maintenance_window_id, existing);
    }
  }

  return byWindow;
}

async function listPublicMaintenanceWindowsPage(opts: {
  db: D1Database;
  now: number;
  limit: number;
  cursor: number | undefined;
  includeHiddenMonitors: boolean;
}): Promise<{
  maintenance_windows: Array<ReturnType<typeof maintenanceWindowRowToApi>>;
  next_cursor: number | null;
}> {
  const limitPlusOne = opts.limit + 1;
  const batchLimit = Math.max(50, limitPlusOne);
  let seekCursor = opts.cursor;
  const collected: Array<{ row: MaintenanceWindowRow; monitorIds: number[] }> = [];

  while (collected.length < limitPlusOne) {
    const { results: windowRows } = seekCursor
      ? await opts.db
          .prepare(
            `
              SELECT id, title, message, starts_at, ends_at, created_at
              FROM maintenance_windows
              WHERE ends_at <= ?1
                AND id < ?3
              ORDER BY id DESC
              LIMIT ?2
            `,
          )
          .bind(opts.now, batchLimit, seekCursor)
          .all<MaintenanceWindowRow>()
      : await opts.db
          .prepare(
            `
              SELECT id, title, message, starts_at, ends_at, created_at
              FROM maintenance_windows
              WHERE ends_at <= ?1
              ORDER BY id DESC
              LIMIT ?2
            `,
          )
          .bind(opts.now, batchLimit)
          .all<MaintenanceWindowRow>();

    const allWindows = windowRows ?? [];
    if (allWindows.length === 0) {
      break;
    }

    const monitorIdsByWindowId = await listMaintenanceWindowMonitorIdsByWindowId(
      opts.db,
      allWindows.map((window) => window.id),
    );
    const linkedMonitorIds = [...monitorIdsByWindowId.values()].flat();
    const visibleMonitorIds =
      opts.includeHiddenMonitors || linkedMonitorIds.length === 0
        ? new Set<number>()
        : await listStatusPageVisibleMonitorIds(opts.db, linkedMonitorIds);

    for (const row of allWindows) {
      const originalMonitorIds = monitorIdsByWindowId.get(row.id) ?? [];
      const filteredMonitorIds = filterStatusPageScopedMonitorIds(
        originalMonitorIds,
        visibleMonitorIds,
        opts.includeHiddenMonitors,
      );
      if (!shouldIncludeStatusPageScopedItem(originalMonitorIds, filteredMonitorIds)) {
        continue;
      }
      collected.push({ row, monitorIds: filteredMonitorIds });
      if (collected.length >= limitPlusOne) {
        break;
      }
    }

    const lastRow = allWindows[allWindows.length - 1];
    if (allWindows.length < batchLimit || !lastRow) {
      break;
    }
    seekCursor = lastRow.id;
  }

  return {
    maintenance_windows: collected
      .slice(0, opts.limit)
      .map(({ row, monitorIds }) => maintenanceWindowRowToApi(row, monitorIds)),
    next_cursor:
      collected.length > opts.limit ? (collected[opts.limit - 1]?.row.id ?? null) : null,
  };
}

function jsonNumberLiteral(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(Math.round(value)) : 'null';
}

function jsonArrayLiteral(value: string | null | undefined): string {
  if (typeof value !== 'string') return '[]';
  const trimmed = value.trim();
  return trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed : '[]';
}

function safeJsonParse(text: string): unknown | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

function toCheckStatus(value: string | null): 'up' | 'down' | 'maintenance' | 'unknown' {
  switch (value) {
    case 'up':
    case 'down':
    case 'maintenance':
    case 'unknown':
      return value;
    default:
      return 'unknown';
  }
}

function resolveUptimeRangeStart(
  rangeStart: number,
  rangeEnd: number,
  monitorCreatedAt: number,
  lastCheckedAt: number | null,
  checks: Array<{ checked_at: number; status: string }>,
): number | null {
  const monitorRangeStart = Math.max(rangeStart, monitorCreatedAt);
  if (rangeEnd <= monitorRangeStart) return null;

  if (monitorRangeStart > rangeStart) {
    const firstCheckAt = checks.find(
      (check) => check.checked_at >= monitorRangeStart && check.checked_at < rangeEnd,
    )?.checked_at;
    if (firstCheckAt !== undefined) {
      return firstCheckAt;
    }

    return lastCheckedAt === null ? null : monitorRangeStart;
  }

  return monitorRangeStart;
}

async function resolveUptimeRangeStartFromDb(opts: {
  db: D1Database;
  monitorId: number;
  rangeStart: number;
  rangeEnd: number;
  monitorCreatedAt: number;
  lastCheckedAt: number | null;
}): Promise<number | null> {
  const monitorRangeStart = Math.max(opts.rangeStart, opts.monitorCreatedAt);
  if (opts.rangeEnd <= monitorRangeStart) return null;

  if (monitorRangeStart > opts.rangeStart) {
    const firstCheck = await opts.db
      .prepare(
        `
          SELECT checked_at
          FROM check_results
          WHERE monitor_id = ?1
            AND checked_at >= ?2
            AND checked_at < ?3
          ORDER BY checked_at
          LIMIT 1
        `,
      )
      .bind(opts.monitorId, monitorRangeStart, opts.rangeEnd)
      .first<{ checked_at: number }>();

    if (typeof firstCheck?.checked_at === 'number') {
      return firstCheck.checked_at;
    }

    return opts.lastCheckedAt === null ? null : monitorRangeStart;
  }

  return monitorRangeStart;
}

function addUptimeTotals(
  target: { total_sec: number; downtime_sec: number; unknown_sec: number; uptime_sec: number },
  source: { total_sec: number; downtime_sec: number; unknown_sec: number; uptime_sec: number },
): void {
  target.total_sec += source.total_sec;
  target.downtime_sec += source.downtime_sec;
  target.unknown_sec += source.unknown_sec;
  target.uptime_sec += source.uptime_sec;
}

async function computePartialUptimeTotals(
  db: D1Database,
  monitorId: number,
  intervalSec: number,
  createdAt: number,
  lastCheckedAt: number | null,
  rangeStart: number,
  rangeEnd: number,
): Promise<{ total_sec: number; downtime_sec: number; unknown_sec: number; uptime_sec: number }> {
  if (rangeEnd <= rangeStart) {
    return { total_sec: 0, downtime_sec: 0, unknown_sec: 0, uptime_sec: 0 };
  }

  const checksStart = rangeStart - intervalSec * 2;
  const { results: checkRows } = await db
    .prepare(
      `
        SELECT checked_at, status
        FROM check_results
        WHERE monitor_id = ?1
          AND checked_at >= ?2
          AND checked_at < ?3
        ORDER BY checked_at
      `,
    )
    .bind(monitorId, checksStart, rangeEnd)
    .all<{ checked_at: number; status: string }>();

  const checks = (checkRows ?? []).map((row) => ({
    checked_at: row.checked_at,
    status: toCheckStatus(row.status),
  }));
  const effectiveRangeStart = resolveUptimeRangeStart(
    rangeStart,
    rangeEnd,
    createdAt,
    lastCheckedAt,
    checks,
  );
  if (effectiveRangeStart === null || rangeEnd <= effectiveRangeStart) {
    return { total_sec: 0, downtime_sec: 0, unknown_sec: 0, uptime_sec: 0 };
  }

  const total_sec = rangeEnd - effectiveRangeStart;
  const { results: outageRows } = await db
    .prepare(
      `
        SELECT started_at, ended_at
        FROM outages
        WHERE monitor_id = ?1
          AND started_at < ?2
          AND (ended_at IS NULL OR ended_at > ?3)
        ORDER BY started_at
      `,
    )
    .bind(monitorId, rangeEnd, effectiveRangeStart)
    .all<{ started_at: number; ended_at: number | null }>();

  const downtimeIntervals = mergeIntervals(
    (outageRows ?? [])
      .map((row) => ({
        start: Math.max(row.started_at, effectiveRangeStart),
        end: Math.min(row.ended_at ?? rangeEnd, rangeEnd),
      }))
      .filter((interval) => interval.end > interval.start),
  );
  const downtime_sec = sumIntervals(downtimeIntervals);

  const checksForUnknown =
    effectiveRangeStart > rangeStart
      ? checks.filter((check) => check.checked_at >= effectiveRangeStart)
      : checks;
  const unknownIntervals = buildUnknownIntervals(
    effectiveRangeStart,
    rangeEnd,
    intervalSec,
    checksForUnknown,
  );
  const unknown_sec = Math.max(
    0,
    sumIntervals(unknownIntervals) - overlapSeconds(unknownIntervals, downtimeIntervals),
  );

  const unavailable_sec = Math.min(total_sec, downtime_sec + unknown_sec);
  const uptime_sec = Math.max(0, total_sec - unavailable_sec);

  return { total_sec, downtime_sec, unknown_sec, uptime_sec };
}

async function readPublicMonitorRuntimeEntry(opts: {
  db: D1Database;
  now: number;
  monitorId: number;
  maxAgeSeconds?: number;
}): Promise<PublicMonitorRuntimeEntry | null> {
  const row = await opts.db
    .prepare(
      `
        SELECT
          generated_at,
          CAST(json_extract(body_json, '$.day_start_at') AS INTEGER) AS day_start_at,
          (
            SELECT entry.value
            FROM json_each(public_snapshots.body_json, '$.monitors') AS entry
            WHERE CAST(json_extract(entry.value, '$.monitor_id') AS INTEGER) = ?2
            LIMIT 1
          ) AS monitor_json
        FROM public_snapshots
        WHERE key = ?1
      `,
    )
    .bind(MONITOR_RUNTIME_SNAPSHOT_KEY, opts.monitorId)
    .first<{
      generated_at: number;
      day_start_at: number | null;
      monitor_json: string | null;
    }>();

  if (!row || typeof row.generated_at !== 'number') {
    return null;
  }

  const age = Math.max(0, opts.now - row.generated_at);
  if (age > (opts.maxAgeSeconds ?? MONITOR_RUNTIME_MAX_AGE_SECONDS)) {
    return null;
  }

  if (row.day_start_at !== utcDayStart(opts.now) || typeof row.monitor_json !== 'string') {
    return null;
  }

  const parsed = safeJsonParse(row.monitor_json);
  if (parsed === null) {
    return null;
  }

  return parsePublicMonitorRuntimeEntry(parsed);
}

async function buildCompactLatencyResponseJson(opts: {
  db: D1Database;
  monitor: { id: number; name: string };
  range: z.infer<typeof latencyRangeSchema>;
  rangeStart: number;
  rangeEnd: number;
}): Promise<string> {
  const row = await opts.db
    .prepare(
      `
        WITH ordered_points AS (
          SELECT
            checked_at,
            CASE status
              WHEN 'up' THEN 'u'
              WHEN 'down' THEN 'd'
              WHEN 'maintenance' THEN 'm'
              ELSE 'x'
            END AS status_code,
            latency_ms
          FROM check_results
          WHERE monitor_id = ?1
            AND checked_at >= ?2
            AND checked_at <= ?3
          ORDER BY checked_at
        ),
        up_latencies AS (
          SELECT
            latency_ms,
            row_number() OVER (ORDER BY latency_ms) AS rn,
            count(*) OVER () AS cnt
          FROM ordered_points
          WHERE status_code = 'u'
            AND latency_ms IS NOT NULL
        )
        SELECT
          COALESCE((SELECT json_group_array(checked_at) FROM ordered_points), '[]') AS checked_at_json,
          COALESCE((SELECT group_concat(status_code, '') FROM ordered_points), '') AS status_codes,
          COALESCE((SELECT json_group_array(latency_ms) FROM ordered_points), '[]') AS latency_ms_json,
          CAST(round((SELECT avg(latency_ms) FROM up_latencies)) AS INTEGER) AS avg_latency_ms,
          (
            SELECT latency_ms
            FROM up_latencies
            WHERE rn = ((95 * cnt + 99) / 100)
            LIMIT 1
          ) AS p95_latency_ms
      `,
    )
    .bind(opts.monitor.id, opts.rangeStart, opts.rangeEnd)
    .first<{
      checked_at_json: string | null;
      status_codes: string | null;
      latency_ms_json: string | null;
      avg_latency_ms: number | null;
      p95_latency_ms: number | null;
    }>();

  const monitorJson = JSON.stringify({
    id: opts.monitor.id,
    name: opts.monitor.name,
  });

  return `{"monitor":${monitorJson},"range":"${opts.range}","range_start_at":${opts.rangeStart},"range_end_at":${opts.rangeEnd},"avg_latency_ms":${jsonNumberLiteral(row?.avg_latency_ms)},"p95_latency_ms":${jsonNumberLiteral(row?.p95_latency_ms)},"points":{"checked_at":${jsonArrayLiteral(row?.checked_at_json)},"status_codes":${JSON.stringify(row?.status_codes ?? '')},"latency_ms":${jsonArrayLiteral(row?.latency_ms_json)}}}`;
}

export const publicUiRoutes = new Hono<{ Bindings: Env }>();

publicUiRoutes.use(
  '*',
  cachePublic({
    cacheName: 'uptimer-public',
    maxAgeSeconds: 30,
  }),
);

publicUiRoutes.get('/incidents', async (c) => {
  const includeHiddenMonitors = isAuthorizedStatusAdminRequest(c);
  const limit = z.coerce.number().int().min(1).max(200).optional().default(20).parse(c.req.query('limit'));
  const cursor = z.coerce.number().int().positive().optional().parse(c.req.query('cursor'));
  const resolvedOnly =
    z.coerce.number().int().min(0).max(1).optional().default(0).parse(c.req.query('resolved_only')) === 1;
  const incidentVisibilitySql = incidentStatusPageVisibilityPredicate(includeHiddenMonitors);

  let active: IncidentRow[] = [];
  let remaining = limit;
  if (!resolvedOnly) {
    const { results } = await c.env.DB
      .prepare(
        `
          SELECT id, title, status, impact, message, started_at, resolved_at
          FROM incidents
          WHERE status != 'resolved'
            AND ${incidentVisibilitySql}
          ORDER BY started_at DESC, id DESC
          LIMIT ?1
        `,
      )
      .bind(limit)
      .all<IncidentRow>();
    active = results ?? [];
    remaining = Math.max(0, limit - active.length);
  }

  let resolved: IncidentRow[] = [];
  let next_cursor: number | null = null;
  if (remaining > 0) {
    const baseSql = `
      SELECT id, title, status, impact, message, started_at, resolved_at
      FROM incidents
      WHERE status = 'resolved'
        AND ${incidentVisibilitySql}
    `;
    const resolvedLimitPlusOne = remaining + 1;
    const batchLimit = Math.max(50, resolvedLimitPlusOne);
    let seekCursor = cursor;
    const collected: IncidentRow[] = [];

    while (collected.length < resolvedLimitPlusOne) {
      const { results } = seekCursor
        ? await c.env.DB
            .prepare(
              `
                ${baseSql}
                  AND id < ?2
                ORDER BY id DESC
                LIMIT ?1
              `,
            )
            .bind(batchLimit, seekCursor)
            .all<IncidentRow>()
        : await c.env.DB
            .prepare(
              `
                ${baseSql}
                ORDER BY id DESC
                LIMIT ?1
              `,
            )
            .bind(batchLimit)
            .all<IncidentRow>();

      const rows = results ?? [];
      if (rows.length === 0) break;
      collected.push(...rows);
      const lastRow = rows[rows.length - 1];
      if (rows.length < batchLimit || !lastRow) break;
      seekCursor = lastRow.id;
    }

    resolved = collected.slice(0, remaining);
    next_cursor = collected.length > remaining ? (resolved[resolved.length - 1]?.id ?? null) : null;
  }

  const combined = [...active, ...resolved];
  const [updatesByIncidentId, monitorIdsByIncidentId] = await Promise.all([
    listIncidentUpdatesByIncidentId(
      c.env.DB,
      combined.map((row) => row.id),
    ),
    listIncidentMonitorIdsByIncidentId(
      c.env.DB,
      combined.map((row) => row.id),
    ),
  ]);

  const visibleMonitorIds = includeHiddenMonitors
    ? new Set<number>()
    : await listStatusPageVisibleMonitorIds(c.env.DB, [...monitorIdsByIncidentId.values()].flat());

  return withVisibilityAwareCaching(
    c.json({
      incidents: combined.flatMap((row) => {
        const originalMonitorIds = monitorIdsByIncidentId.get(row.id) ?? [];
        const filteredMonitorIds = filterStatusPageScopedMonitorIds(
          originalMonitorIds,
          visibleMonitorIds,
          includeHiddenMonitors,
        );
        if (!shouldIncludeStatusPageScopedItem(originalMonitorIds, filteredMonitorIds)) {
          return [];
        }
        return [incidentRowToApi(row, updatesByIncidentId.get(row.id) ?? [], filteredMonitorIds)];
      }),
      next_cursor,
    }),
    includeHiddenMonitors,
  );
});

publicUiRoutes.get('/maintenance-windows', async (c) => {
  const includeHiddenMonitors = isAuthorizedStatusAdminRequest(c);
  const limit = z.coerce.number().int().min(1).max(200).optional().default(20).parse(c.req.query('limit'));
  const cursor = z.coerce.number().int().positive().optional().parse(c.req.query('cursor'));
  const now = Math.floor(Date.now() / 1000);

  return withVisibilityAwareCaching(
    c.json(
      await listPublicMaintenanceWindowsPage({
        db: c.env.DB,
        now,
        limit,
        cursor,
        includeHiddenMonitors,
      }),
    ),
    includeHiddenMonitors,
  );
});

publicUiRoutes.get('/monitors/:id/day-context', async (c) => {
  const includeHiddenMonitors = isAuthorizedStatusAdminRequest(c);
  const id = z.coerce.number().int().positive().parse(c.req.param('id'));
  const dayStartAt = z.coerce.number().int().nonnegative().parse(c.req.query('day_start_at'));
  const dayEndAt = dayStartAt + 86400;

  const monitor = await c.env.DB
    .prepare(
      `
        SELECT id
        FROM monitors
        WHERE id = ?1 AND is_active = 1
          AND ${monitorVisibilityPredicate(includeHiddenMonitors)}
      `,
    )
    .bind(id)
    .first<{ id: number }>();
  if (!monitor) {
    throw new AppError(404, 'NOT_FOUND', 'Monitor not found');
  }

  const [{ results: maintenanceRows }, { results: incidentRows }] = await Promise.all([
    c.env.DB
      .prepare(
        `
          SELECT mw.id, mw.title, mw.message, mw.starts_at, mw.ends_at, mw.created_at
          FROM maintenance_windows mw
          JOIN maintenance_window_monitors mwm ON mwm.maintenance_window_id = mw.id
          WHERE mwm.monitor_id = ?1
            AND mw.starts_at < ?3
            AND mw.ends_at > ?2
          ORDER BY mw.starts_at ASC, mw.id ASC
          LIMIT 50
        `,
      )
      .bind(id, dayStartAt, dayEndAt)
      .all<MaintenanceWindowRow>(),
    c.env.DB
      .prepare(
        `
          SELECT i.id, i.title, i.status, i.impact, i.message, i.started_at, i.resolved_at
          FROM incidents i
          JOIN incident_monitors im ON im.incident_id = i.id
          WHERE im.monitor_id = ?1
            AND i.started_at < ?3
            AND (i.resolved_at IS NULL OR i.resolved_at > ?2)
          ORDER BY i.started_at ASC, i.id ASC
          LIMIT 50
        `,
      )
      .bind(id, dayStartAt, dayEndAt)
      .all<IncidentRow>(),
  ]);

  const maintenance = maintenanceRows ?? [];
  const incidents = incidentRows ?? [];
  if (maintenance.length === 0 && incidents.length === 0) {
    return withVisibilityAwareCaching(
      c.json({
        day_start_at: dayStartAt,
        day_end_at: dayEndAt,
        maintenance_windows: [],
        incidents: [],
      }),
      includeHiddenMonitors,
    );
  }

  const [monitorIdsByWindowId, updatesByIncidentId, monitorIdsByIncidentId] = await Promise.all([
    maintenance.length > 0
      ? listMaintenanceWindowMonitorIdsByWindowId(
          c.env.DB,
          maintenance.map((row) => row.id),
        )
      : Promise.resolve(new Map<number, number[]>()),
    incidents.length > 0
      ? listIncidentUpdatesByIncidentId(
          c.env.DB,
          incidents.map((row) => row.id),
        )
      : Promise.resolve(new Map<number, IncidentUpdateRow[]>()),
    incidents.length > 0
      ? listIncidentMonitorIdsByIncidentId(
          c.env.DB,
          incidents.map((row) => row.id),
        )
      : Promise.resolve(new Map<number, number[]>()),
  ]);

  const visibleMonitorIds = includeHiddenMonitors
    ? new Set<number>()
    : await (async () => {
        const scopedMonitorIds = [...monitorIdsByWindowId.values(), ...monitorIdsByIncidentId.values()].flat();
        return scopedMonitorIds.length === 0
          ? new Set<number>()
          : listStatusPageVisibleMonitorIds(c.env.DB, scopedMonitorIds);
      })();

  return withVisibilityAwareCaching(
    c.json({
      day_start_at: dayStartAt,
      day_end_at: dayEndAt,
      maintenance_windows: maintenance.flatMap((row) => {
        const originalMonitorIds = monitorIdsByWindowId.get(row.id) ?? [];
        const filteredMonitorIds = filterStatusPageScopedMonitorIds(
          originalMonitorIds,
          visibleMonitorIds,
          includeHiddenMonitors,
        );
        if (!shouldIncludeStatusPageScopedItem(originalMonitorIds, filteredMonitorIds)) {
          return [];
        }
        return [maintenanceWindowRowToApi(row, filteredMonitorIds)];
      }),
      incidents: incidents.flatMap((row) => {
        const originalMonitorIds = monitorIdsByIncidentId.get(row.id) ?? [];
        const filteredMonitorIds = filterStatusPageScopedMonitorIds(
          originalMonitorIds,
          visibleMonitorIds,
          includeHiddenMonitors,
        );
        if (!shouldIncludeStatusPageScopedItem(originalMonitorIds, filteredMonitorIds)) {
          return [];
        }
        return [incidentRowToApi(row, updatesByIncidentId.get(row.id) ?? [], filteredMonitorIds)];
      }),
    }),
    includeHiddenMonitors,
  );
});

publicUiRoutes.get('/monitors/:id/outages', async (c) => {
  const includeHiddenMonitors = isAuthorizedStatusAdminRequest(c);
  const id = z.coerce.number().int().positive().parse(c.req.param('id'));
  const limit = z.coerce.number().int().min(1).max(200).optional().default(200).parse(c.req.query('limit'));
  const cursor = z.coerce.number().int().positive().optional().parse(c.req.query('cursor'));

  const monitor = await c.env.DB
    .prepare(
      `
        SELECT id, created_at
        FROM monitors
        WHERE id = ?1 AND is_active = 1
          AND ${monitorVisibilityPredicate(includeHiddenMonitors)}
      `,
    )
    .bind(id)
    .first<{ id: number; created_at: number }>();
  if (!monitor) {
    throw new AppError(404, 'NOT_FOUND', 'Monitor not found');
  }

  const now = Math.floor(Date.now() / 1000);
  const rangeEnd = Math.floor(now / 60) * 60;
  const rangeStart = Math.max(rangeEnd - 30 * 86400, monitor.created_at);
  const take = limit + 1;
  const sqlBase = `
    SELECT id, started_at, ended_at, initial_error, last_error
    FROM outages
    WHERE monitor_id = ?1
      AND started_at < ?2
      AND (ended_at IS NULL OR ended_at > ?3)
  `;

  const { results } = cursor
    ? await c.env.DB
        .prepare(
          `
            ${sqlBase}
              AND id < ?4
            ORDER BY id DESC
            LIMIT ?5
          `,
        )
        .bind(id, rangeEnd, rangeStart, cursor, take)
        .all<{
          id: number;
          started_at: number;
          ended_at: number | null;
          initial_error: string | null;
          last_error: string | null;
        }>()
    : await c.env.DB
        .prepare(
          `
            ${sqlBase}
            ORDER BY id DESC
            LIMIT ?4
          `,
        )
        .bind(id, rangeEnd, rangeStart, take)
        .all<{
          id: number;
          started_at: number;
          ended_at: number | null;
          initial_error: string | null;
          last_error: string | null;
        }>();

  const rows = results ?? [];
  const page = rows.slice(0, limit);
  const next_cursor = rows.length > limit ? (page[page.length - 1]?.id ?? null) : null;

  return withVisibilityAwareCaching(
    c.json({
      range: '30d',
      range_start_at: rangeStart,
      range_end_at: rangeEnd,
      outages: page.map((row) => ({
        id: row.id,
        monitor_id: id,
        started_at: row.started_at,
        ended_at: row.ended_at,
        initial_error: row.initial_error,
        last_error: row.last_error,
      })),
      next_cursor,
    }),
    includeHiddenMonitors,
  );
});

publicUiRoutes.get('/monitors/:id/latency', async (c) => {
  const includeHiddenMonitors = isAuthorizedStatusAdminRequest(c);
  const id = z.coerce.number().int().positive().parse(c.req.param('id'));
  const range = latencyRangeSchema.optional().default('24h').parse(c.req.query('range'));
  const format = c.req.query('format');
  if (format !== 'compact-v1') {
    throw new AppError(404, 'NOT_FOUND', 'Latency route not found');
  }

  const monitor = await c.env.DB
    .prepare(
      `
        SELECT id, name
        FROM monitors
        WHERE id = ?1 AND is_active = 1
          AND ${monitorVisibilityPredicate(includeHiddenMonitors)}
      `,
    )
    .bind(id)
    .first<{ id: number; name: string }>();
  if (!monitor) {
    throw new AppError(404, 'NOT_FOUND', 'Monitor not found');
  }

  const now = Math.floor(Date.now() / 1000);
  const rangeEnd = Math.floor(now / 60) * 60;
  const rangeStart = rangeEnd - 24 * 60 * 60;
  const bodyJson = await buildCompactLatencyResponseJson({
    db: c.env.DB,
    monitor,
    range,
    rangeStart,
    rangeEnd,
  });
  return withVisibilityAwareCaching(
    new Response(bodyJson, {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    }),
    includeHiddenMonitors,
  );
});

publicUiRoutes.get('/analytics/uptime', async (c) => {
  const includeHiddenMonitors = isAuthorizedStatusAdminRequest(c);
  const range = uptimeOverviewRangeSchema.optional().default('30d').parse(c.req.query('range'));

  const now = Math.floor(Date.now() / 1000);
  const rangeEnd = Math.floor(now / 60) * 60;
  const rangeEndFullDays = utcDayStart(rangeEnd);
  const rangeStart = rangeEnd - (range === '30d' ? 30 * 86400 : 90 * 86400);

  const { results: monitorRows } = await c.env.DB
    .prepare(
      `
        SELECT m.id, m.name, m.type
        FROM monitors m
        WHERE m.is_active = 1
          AND ${monitorVisibilityPredicate(includeHiddenMonitors, 'm')}
        ORDER BY m.id
      `,
    )
    .all<{
      id: number;
      name: string;
      type: string;
    }>();

  const monitors = monitorRows ?? [];
  const monitorIds = monitors.map((monitor) => monitor.id);
  const runtimeSnapshot =
    monitorIds.length > 0 ? await readPublicMonitorRuntimeSnapshot(c.env.DB, rangeEnd) : null;
  if (monitorIds.length > 0 && (!runtimeSnapshot || !snapshotHasMonitorIds(runtimeSnapshot, monitorIds))) {
    const { publicRoutes } = await import('./public');
    return publicRoutes.fetch(c.req.raw, c.env, c.executionCtx);
  }

  const rollupByMonitorId = new Map<
    number,
    { total_sec: number; downtime_sec: number; unknown_sec: number; uptime_sec: number }
  >();
  for (const ids of chunkPositiveIntegerIds(monitorIds, 90)) {
    const placeholders = buildNumberedPlaceholders(ids.length, 3);
    const { results: sumRows } = await c.env.DB
      .prepare(
        `
          SELECT
            monitor_id,
            SUM(total_sec) AS total_sec,
            SUM(downtime_sec) AS downtime_sec,
            SUM(unknown_sec) AS unknown_sec,
            SUM(uptime_sec) AS uptime_sec
          FROM monitor_daily_rollups
          WHERE day_start_at >= ?1
            AND day_start_at < ?2
            AND monitor_id IN (${placeholders})
          GROUP BY monitor_id
        `,
      )
      .bind(rangeStart, rangeEndFullDays, ...ids)
      .all<{
        monitor_id: number;
        total_sec: number;
        downtime_sec: number;
        unknown_sec: number;
        uptime_sec: number;
      }>();

    for (const row of sumRows ?? []) {
      rollupByMonitorId.set(row.monitor_id, {
        total_sec: row.total_sec ?? 0,
        downtime_sec: row.downtime_sec ?? 0,
        unknown_sec: row.unknown_sec ?? 0,
        uptime_sec: row.uptime_sec ?? 0,
      });
    }
  }

  const runtimeByMonitorId = runtimeSnapshot ? toMonitorRuntimeEntryMap(runtimeSnapshot) : null;
  let total_sec = 0;
  let downtime_sec = 0;
  let unknown_sec = 0;
  let uptime_sec = 0;

  const partialStart = rangeEndFullDays;
  const partialEnd = rangeEnd;
  const output = monitors.map((monitor) => {
    const rollupTotals = rollupByMonitorId.get(monitor.id) ?? {
      total_sec: 0,
      downtime_sec: 0,
      unknown_sec: 0,
      uptime_sec: 0,
    };
    const partialTotals =
      partialEnd > partialStart && runtimeByMonitorId
        ? materializeMonitorRuntimeTotals(runtimeByMonitorId.get(monitor.id)!, partialEnd)
        : { total_sec: 0, downtime_sec: 0, unknown_sec: 0, uptime_sec: 0, uptime_pct: null };

    const totals = {
      total_sec: rollupTotals.total_sec + partialTotals.total_sec,
      downtime_sec: rollupTotals.downtime_sec + partialTotals.downtime_sec,
      unknown_sec: rollupTotals.unknown_sec + partialTotals.unknown_sec,
      uptime_sec: rollupTotals.uptime_sec + partialTotals.uptime_sec,
    };

    total_sec += totals.total_sec;
    downtime_sec += totals.downtime_sec;
    unknown_sec += totals.unknown_sec;
    uptime_sec += totals.uptime_sec;

    return {
      id: monitor.id,
      name: monitor.name,
      type: monitor.type,
      total_sec: totals.total_sec,
      downtime_sec: totals.downtime_sec,
      unknown_sec: totals.unknown_sec,
      uptime_sec: totals.uptime_sec,
      uptime_pct: totals.total_sec === 0 ? 0 : (totals.uptime_sec / totals.total_sec) * 100,
    };
  });

  return withVisibilityAwareCaching(
    c.json({
      generated_at: now,
      range,
      range_start_at: rangeStart,
      range_end_at: rangeEnd,
      overall: {
        total_sec,
        downtime_sec,
        unknown_sec,
        uptime_sec,
        uptime_pct: total_sec === 0 ? 0 : (uptime_sec / total_sec) * 100,
      },
      monitors: output,
    }),
    includeHiddenMonitors,
  );
});

publicUiRoutes.get('/monitors/:id/uptime', async (c) => {
  const includeHiddenMonitors = isAuthorizedStatusAdminRequest(c);
  const id = z.coerce.number().int().positive().parse(c.req.param('id'));
  const range = uptimeRangeSchema.optional().default('24h').parse(c.req.query('range'));

  const monitor = await c.env.DB
    .prepare(
      `
        SELECT m.id, m.name, m.interval_sec, m.created_at, s.last_checked_at
        FROM monitors m
        LEFT JOIN monitor_state s ON s.monitor_id = m.id
        WHERE m.id = ?1 AND m.is_active = 1
          AND ${monitorVisibilityPredicate(includeHiddenMonitors, 'm')}
      `,
    )
    .bind(id)
    .first<{
      id: number;
      name: string;
      interval_sec: number;
      created_at: number;
      last_checked_at: number | null;
    }>();
  if (!monitor) {
    throw new AppError(404, 'NOT_FOUND', 'Monitor not found');
  }

  const now = Math.floor(Date.now() / 1000);
  const rangeEnd = Math.floor(now / 60) * 60;
  const requestedRangeStart = rangeEnd - rangeToSeconds(range);
  const rangeStart = Math.max(requestedRangeStart, monitor.created_at);
  const effectiveRangeStart = await resolveUptimeRangeStartFromDb({
    db: c.env.DB,
    monitorId: id,
    rangeStart,
    rangeEnd,
    monitorCreatedAt: monitor.created_at,
    lastCheckedAt: monitor.last_checked_at,
  });
  const rangeStartAt = effectiveRangeStart ?? rangeStart;
  if (effectiveRangeStart === null || rangeEnd <= effectiveRangeStart) {
    return withVisibilityAwareCaching(
      c.json({
        monitor: { id: monitor.id, name: monitor.name },
        range,
        range_start_at: rangeStartAt,
        range_end_at: rangeEnd,
        total_sec: 0,
        downtime_sec: 0,
        unknown_sec: 0,
        uptime_sec: 0,
        uptime_pct: 0,
      }),
      includeHiddenMonitors,
    );
  }

  const totals = {
    total_sec: 0,
    downtime_sec: 0,
    unknown_sec: 0,
    uptime_sec: 0,
  };
  const startDay = utcDayStart(effectiveRangeStart);
  const endDay = utcDayStart(rangeEnd);

  if (startDay === endDay) {
    addUptimeTotals(
      totals,
      await computePartialUptimeTotals(
        c.env.DB,
        monitor.id,
        monitor.interval_sec,
        monitor.created_at,
        monitor.last_checked_at,
        effectiveRangeStart,
        rangeEnd,
      ),
    );
  } else {
    const startPartialEnd = Math.min(rangeEnd, startDay + 86400);
    if (effectiveRangeStart < startPartialEnd) {
      addUptimeTotals(
        totals,
        await computePartialUptimeTotals(
          c.env.DB,
          monitor.id,
          monitor.interval_sec,
          monitor.created_at,
          monitor.last_checked_at,
          effectiveRangeStart,
          startPartialEnd,
        ),
      );
    }

    const fullDaysStart = Math.max(startDay + 86400, effectiveRangeStart);
    const fullDaysEnd = endDay;
    if (fullDaysStart < fullDaysEnd) {
      const rollup = await c.env.DB
        .prepare(
          `
            SELECT
              SUM(total_sec) AS total_sec,
              SUM(downtime_sec) AS downtime_sec,
              SUM(unknown_sec) AS unknown_sec,
              SUM(uptime_sec) AS uptime_sec
            FROM monitor_daily_rollups
            WHERE monitor_id = ?1
              AND day_start_at >= ?2
              AND day_start_at < ?3
          `,
        )
        .bind(monitor.id, fullDaysStart, fullDaysEnd)
        .first<{
          total_sec: number | null;
          downtime_sec: number | null;
          unknown_sec: number | null;
          uptime_sec: number | null;
        }>();

      addUptimeTotals(totals, {
        total_sec: rollup?.total_sec ?? 0,
        downtime_sec: rollup?.downtime_sec ?? 0,
        unknown_sec: rollup?.unknown_sec ?? 0,
        uptime_sec: rollup?.uptime_sec ?? 0,
      });
    }

    if (endDay < rangeEnd) {
      const runtimeEntry = await readPublicMonitorRuntimeEntry({
        db: c.env.DB,
        now: rangeEnd,
        monitorId: monitor.id,
      });

      if (runtimeEntry) {
        addUptimeTotals(totals, materializeMonitorRuntimeTotals(runtimeEntry, rangeEnd));
      } else {
        addUptimeTotals(
          totals,
          await computePartialUptimeTotals(
            c.env.DB,
            monitor.id,
            monitor.interval_sec,
            monitor.created_at,
            monitor.last_checked_at,
            endDay,
            rangeEnd,
          ),
        );
      }
    }
  }

  return withVisibilityAwareCaching(
    c.json({
      monitor: { id: monitor.id, name: monitor.name },
      range,
      range_start_at: rangeStartAt,
      range_end_at: rangeEnd,
      total_sec: totals.total_sec,
      downtime_sec: totals.downtime_sec,
      unknown_sec: totals.unknown_sec,
      uptime_sec: totals.uptime_sec,
      uptime_pct: totals.total_sec === 0 ? 0 : (totals.uptime_sec / totals.total_sec) * 100,
    }),
    includeHiddenMonitors,
  );
});
