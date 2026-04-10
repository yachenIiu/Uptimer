import type { PublicHomepageResponse } from '../schemas/public-homepage';
import type { PublicStatusResponse } from '../schemas/public-status';

import {
  buildPublicStatusBanner,
  computeTodayPartialUptimeBatch,
  listIncidentMonitorIdsByIncidentId,
  listMaintenanceWindowMonitorIdsByWindowId,
  listVisibleActiveIncidents,
  listVisibleMaintenanceWindows,
  readPublicSiteSettings,
  toIncidentImpact,
  toIncidentStatus,
  toMonitorStatus,
  toUptimePct,
  utcDayStart,
  type IncidentRow,
  type MaintenanceWindowRow,
  type UptimeWindowTotals,
} from './data';
import {
  buildNumberedPlaceholders,
  chunkPositiveIntegerIds,
  filterStatusPageScopedMonitorIds,
  incidentStatusPageVisibilityPredicate,
  listStatusPageVisibleMonitorIds,
  maintenanceWindowStatusPageVisibilityPredicate,
  monitorVisibilityPredicate,
  shouldIncludeStatusPageScopedItem,
} from './visibility';

const PREVIEW_BATCH_LIMIT = 50;
const UPTIME_DAYS = 30;
const HEARTBEAT_POINTS = 60;

type IncidentSummary = PublicHomepageResponse['active_incidents'][number];
type MaintenancePreview = NonNullable<PublicHomepageResponse['maintenance_history_preview']>;
type HomepageMonitorCard = PublicHomepageResponse['monitors'][number];
type HomepageMonitorStatus = HomepageMonitorCard['status'];

type HomepageMonitorRow = {
  id: number;
  name: string;
  type: string;
  group_name: string | null;
  interval_sec: number;
  created_at: number;
  state_status: string | null;
  last_checked_at: number | null;
};

type HomepageHeartbeatRow = {
  monitor_id: number;
  checked_at: number;
  status: string;
  latency_ms: number | null;
};

type HomepageRollupRow = {
  monitor_id: number;
  day_start_at: number;
  total_sec: number;
  downtime_sec: number;
  unknown_sec: number;
  uptime_sec: number;
};

type HomepageMonitorDataOptions = {
  cardLimit?: number;
  uptimeRatingLevel?: 1 | 2 | 3 | 4 | 5;
};

function toHeartbeatStatusCode(status: string | null | undefined): string {
  switch (status) {
    case 'up':
      return 'u';
    case 'down':
      return 'd';
    case 'maintenance':
      return 'm';
    case 'unknown':
    default:
      return 'x';
  }
}

function toIncidentSummary(row: IncidentRow): IncidentSummary {
  return {
    id: row.id,
    title: row.title,
    status: toIncidentStatus(row.status),
    impact: toIncidentImpact(row.impact),
    message: row.message,
    started_at: row.started_at,
    resolved_at: row.resolved_at,
  };
}

function incidentSummaryFromStatusIncident(
  incident: PublicStatusResponse['active_incidents'][number],
): IncidentSummary {
  return {
    id: incident.id,
    title: incident.title,
    status: incident.status,
    impact: incident.impact,
    message: incident.message,
    started_at: incident.started_at,
    resolved_at: incident.resolved_at,
  };
}

function toMaintenancePreview(
  row: MaintenanceWindowRow,
  monitorIds: number[],
): MaintenancePreview {
  return {
    id: row.id,
    title: row.title,
    message: row.message,
    starts_at: row.starts_at,
    ends_at: row.ends_at,
    monitor_ids: monitorIds,
  };
}

function maintenancePreviewFromStatusWindow(
  window: PublicStatusResponse['maintenance_windows']['active'][number],
): MaintenancePreview {
  return {
    id: window.id,
    title: window.title,
    message: window.message,
    starts_at: window.starts_at,
    ends_at: window.ends_at,
    monitor_ids: window.monitor_ids,
  };
}

async function readHomepageUptimeRatingLevel(db: D1Database): Promise<1 | 2 | 3 | 4 | 5> {
  const row = await db
    .prepare('SELECT value FROM settings WHERE key = ?1')
    .bind('uptime_rating_level')
    .first<{ value: string }>();

  const raw = row?.value ?? '';
  const parsed = Number.parseInt(raw, 10);
  if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 5) {
    return parsed as 1 | 2 | 3 | 4 | 5;
  }
  return 3;
}

async function listHomepageMaintenanceMonitorIds(
  db: D1Database,
  at: number,
  monitorIds: number[],
): Promise<Set<number>> {
  const activeMonitorIds = new Set<number>();

  for (const ids of chunkPositiveIntegerIds(monitorIds)) {
    const placeholders = buildNumberedPlaceholders(ids.length, 2);
    const sql = `
      SELECT DISTINCT mwm.monitor_id
      FROM maintenance_window_monitors mwm
      JOIN maintenance_windows mw ON mw.id = mwm.maintenance_window_id
      WHERE mw.starts_at <= ?1 AND mw.ends_at > ?1
        AND mwm.monitor_id IN (${placeholders})
    `;

    const { results } = await db
      .prepare(sql)
      .bind(at, ...ids)
      .all<{ monitor_id: number }>();
    for (const row of results ?? []) {
      activeMonitorIds.add(row.monitor_id);
    }
  }

  return activeMonitorIds;
}

function computeOverallStatus(summary: PublicHomepageResponse['summary']): HomepageMonitorStatus {
  if (summary.down > 0) return 'down';
  if (summary.unknown > 0) return 'unknown';
  if (summary.maintenance > 0) return 'maintenance';
  if (summary.up > 0) return 'up';
  if (summary.paused > 0) return 'paused';
  return 'unknown';
}

function toHomepageMonitorType(value: string): HomepageMonitorCard['type'] {
  return value === 'tcp' ? 'tcp' : 'http';
}

function computeHomepageMonitorPresentation(
  row: Pick<HomepageMonitorRow, 'id' | 'interval_sec' | 'last_checked_at' | 'state_status'>,
  now: number,
  maintenanceMonitorIds: ReadonlySet<number>,
): Pick<HomepageMonitorCard, 'status' | 'is_stale'> {
  const isInMaintenance = maintenanceMonitorIds.has(row.id);
  const stateStatus = toMonitorStatus(row.state_status);
  const isStale =
    isInMaintenance || stateStatus === 'paused' || stateStatus === 'maintenance'
      ? false
      : row.last_checked_at === null
        ? true
        : now - row.last_checked_at > row.interval_sec * 2;

  return {
    status: isInMaintenance ? 'maintenance' : isStale ? 'unknown' : stateStatus,
    is_stale: isStale,
  };
}

function toHomepageMonitorCard(
  row: HomepageMonitorRow,
  now: number,
  maintenanceMonitorIds: ReadonlySet<number>,
): HomepageMonitorCard {
  const presentation = computeHomepageMonitorPresentation(row, now, maintenanceMonitorIds);

  return {
    id: row.id,
    name: row.name,
    type: toHomepageMonitorType(row.type),
    group_name: row.group_name?.trim() ? row.group_name.trim() : null,
    status: presentation.status,
    is_stale: presentation.is_stale,
    last_checked_at: row.last_checked_at,
    heartbeat_strip: {
      checked_at: [],
      status_codes: '',
      latency_ms: [],
    },
    uptime_30d: null,
    uptime_day_strip: {
      day_start_at: [],
      downtime_sec: [],
      unknown_sec: [],
      uptime_pct_milli: [],
    },
  };
}

function addUptimeDay(
  monitor: HomepageMonitorCard,
  totals: { totalSec: number; uptimeSec: number },
  dayStartAt: number,
  uptime: UptimeWindowTotals,
): void {
  monitor.uptime_day_strip.day_start_at.push(dayStartAt);
  monitor.uptime_day_strip.downtime_sec.push(uptime.downtime_sec);
  monitor.uptime_day_strip.unknown_sec.push(uptime.unknown_sec);
  monitor.uptime_day_strip.uptime_pct_milli.push(
    uptime.uptime_pct === null ? null : Math.round(uptime.uptime_pct * 1000),
  );
  totals.totalSec += uptime.total_sec;
  totals.uptimeSec += uptime.uptime_sec;
}

async function listHomepageMonitorRows(
  db: D1Database,
  includeHiddenMonitors: boolean,
  limit?: number,
): Promise<HomepageMonitorRow[]> {
  const limitClause = limit === undefined ? '' : '\n      LIMIT ?1';
  const stmt = db.prepare(
    `
      SELECT
        m.id,
        m.name,
        m.type,
        m.group_name,
        m.interval_sec,
        m.created_at,
        s.status AS state_status,
        s.last_checked_at
      FROM monitors m
      LEFT JOIN monitor_state s ON s.monitor_id = m.id
      WHERE m.is_active = 1
        AND ${monitorVisibilityPredicate(includeHiddenMonitors, 'm')}
      ORDER BY
        m.group_sort_order ASC,
        lower(
          CASE
            WHEN m.group_name IS NULL OR trim(m.group_name) = '' THEN 'Ungrouped'
            ELSE trim(m.group_name)
          END
        ) ASC,
        m.sort_order ASC,
        m.id ASC${limitClause}
    `,
  );

  const result =
    limit === undefined
      ? await stmt.all<HomepageMonitorRow>()
      : await stmt.bind(limit).all<HomepageMonitorRow>();

  return result.results ?? [];
}

async function readHomepageMonitorSummary(
  db: D1Database,
  now: number,
  includeHiddenMonitors: boolean,
): Promise<{
  monitorCountTotal: number;
  summary: PublicHomepageResponse['summary'];
  overallStatus: HomepageMonitorStatus;
}> {
  const row = await db
    .prepare(
      `
      WITH active_maintenance AS (
        SELECT DISTINCT mwm.monitor_id
        FROM maintenance_window_monitors mwm
        JOIN maintenance_windows mw ON mw.id = mwm.maintenance_window_id
        WHERE mw.starts_at <= ?1 AND mw.ends_at > ?1
      ),
      visible_monitors AS (
        SELECT
          m.interval_sec,
          COALESCE(s.status, 'unknown') AS normalized_status,
          s.last_checked_at,
          CASE WHEN am.monitor_id IS NULL THEN 0 ELSE 1 END AS in_maintenance
        FROM monitors m
        LEFT JOIN monitor_state s ON s.monitor_id = m.id
        LEFT JOIN active_maintenance am ON am.monitor_id = m.id
        WHERE m.is_active = 1
          AND ${monitorVisibilityPredicate(includeHiddenMonitors, 'm')}
      )
      SELECT
        COUNT(*) AS monitor_count_total,
        SUM(
          CASE
            WHEN in_maintenance = 1 OR normalized_status = 'maintenance' THEN 1
            ELSE 0
          END
        ) AS maintenance,
        SUM(
          CASE
            WHEN in_maintenance = 0 AND normalized_status = 'paused' THEN 1
            ELSE 0
          END
        ) AS paused,
        SUM(
          CASE
            WHEN
              in_maintenance = 0
              AND normalized_status = 'down'
              AND last_checked_at IS NOT NULL
              AND ?1 - last_checked_at <= interval_sec * 2
            THEN 1
            ELSE 0
          END
        ) AS down,
        SUM(
          CASE
            WHEN
              in_maintenance = 0
              AND normalized_status = 'up'
              AND last_checked_at IS NOT NULL
              AND ?1 - last_checked_at <= interval_sec * 2
            THEN 1
            ELSE 0
          END
        ) AS up,
        SUM(
          CASE
            WHEN
              in_maintenance = 1
              OR normalized_status = 'maintenance'
              OR (in_maintenance = 0 AND normalized_status = 'paused')
              OR (
                in_maintenance = 0
                AND normalized_status = 'down'
                AND last_checked_at IS NOT NULL
                AND ?1 - last_checked_at <= interval_sec * 2
              )
              OR (
                in_maintenance = 0
                AND normalized_status = 'up'
                AND last_checked_at IS NOT NULL
                AND ?1 - last_checked_at <= interval_sec * 2
              )
            THEN 0
            ELSE 1
          END
        ) AS unknown
      FROM visible_monitors
    `,
    )
    .bind(now)
    .first<{
      monitor_count_total: number | null;
      up: number | null;
      down: number | null;
      maintenance: number | null;
      paused: number | null;
      unknown: number | null;
    }>();

  const summary: PublicHomepageResponse['summary'] = {
    up: row?.up ?? 0,
    down: row?.down ?? 0,
    maintenance: row?.maintenance ?? 0,
    paused: row?.paused ?? 0,
    unknown: row?.unknown ?? 0,
  };

  return {
    monitorCountTotal: row?.monitor_count_total ?? 0,
    summary,
    overallStatus: computeOverallStatus(summary),
  };
}

async function buildHomepageMonitorCardsFromRows(
  db: D1Database,
  now: number,
  rows: HomepageMonitorRow[],
  maintenanceMonitorIds: ReadonlySet<number>,
): Promise<HomepageMonitorCard[]> {
  if (rows.length === 0) {
    return [];
  }

  const earliestCreatedAt = rows.reduce(
    (acc, monitor) => Math.min(acc, monitor.created_at),
    Number.POSITIVE_INFINITY,
  );
  const rangeEndFullDays = utcDayStart(now);
  const rangeEnd = now;
  const rangeStart = Number.isFinite(earliestCreatedAt)
    ? Math.max(rangeEnd - UPTIME_DAYS * 86400, earliestCreatedAt)
    : rangeEnd - UPTIME_DAYS * 86400;
  const selectedIds = rows.map((monitor) => monitor.id);
  const placeholders = buildNumberedPlaceholders(selectedIds.length);
  const todayStartAt = utcDayStart(now);
  const needsToday = rangeEnd > rangeEndFullDays && todayStartAt >= rangeStart;
  const monitors = rows.map((row) => toHomepageMonitorCard(row, now, maintenanceMonitorIds));
  const monitorIndexById = new Map<number, number>();
  for (let index = 0; index < monitors.length; index += 1) {
    const monitor = monitors[index];
    if (!monitor) continue;
    monitorIndexById.set(monitor.id, index);
  }

  const heartbeatRowsPromise = db
    .prepare(
      `
      SELECT monitor_id, checked_at, status, latency_ms
      FROM (
        SELECT
          id,
          monitor_id,
          checked_at,
          status,
          latency_ms,
          ROW_NUMBER() OVER (
            PARTITION BY monitor_id
            ORDER BY checked_at DESC, id DESC
          ) AS rn
        FROM check_results
        WHERE monitor_id IN (${placeholders})
      )
      WHERE rn <= ?${selectedIds.length + 1}
      ORDER BY monitor_id, checked_at DESC, id DESC
    `,
    )
    .bind(...selectedIds, HEARTBEAT_POINTS)
    .all<HomepageHeartbeatRow>()
    .then(({ results }) => results ?? []);

  const rollupRowsPromise = db
    .prepare(
      `
      SELECT monitor_id, day_start_at, total_sec, downtime_sec, unknown_sec, uptime_sec
      FROM monitor_daily_rollups
      WHERE monitor_id IN (${placeholders})
        AND day_start_at >= ?${selectedIds.length + 1}
        AND day_start_at < ?${selectedIds.length + 2}
      ORDER BY monitor_id, day_start_at
    `,
    )
    .bind(...selectedIds, rangeStart, rangeEndFullDays)
    .all<HomepageRollupRow>()
    .then(({ results }) => results ?? []);

  const todayByMonitorIdPromise: Promise<Map<number, UptimeWindowTotals>> = needsToday
    ? computeTodayPartialUptimeBatch(
        db,
        rows.map((monitor) => ({
          id: monitor.id,
          interval_sec: monitor.interval_sec,
          created_at: monitor.created_at,
          last_checked_at: monitor.last_checked_at,
        })),
        Math.max(todayStartAt, rangeStart),
        rangeEnd,
      )
    : Promise.resolve(new Map<number, UptimeWindowTotals>());

  const [heartbeatRows, rollupRows, todayByMonitorId] = await Promise.all([
    heartbeatRowsPromise,
    rollupRowsPromise,
    todayByMonitorIdPromise,
  ]);

  const heartbeatStatusCodes = Array.from({ length: monitors.length }, () => [] as string[]);
  for (const row of heartbeatRows) {
    const index = monitorIndexById.get(row.monitor_id);
    if (index === undefined) continue;

    const monitor = monitors[index];
    const statusCodes = heartbeatStatusCodes[index];
    if (!monitor || !statusCodes) continue;

    monitor.heartbeat_strip.checked_at.push(row.checked_at);
    monitor.heartbeat_strip.latency_ms.push(row.latency_ms);
    statusCodes.push(toHeartbeatStatusCode(row.status));
  }

  const totalsByMonitor = Array.from({ length: monitors.length }, () => ({
    totalSec: 0,
    uptimeSec: 0,
  }));
  for (const row of rollupRows) {
    const index = monitorIndexById.get(row.monitor_id);
    if (index === undefined) continue;

    const monitor = monitors[index];
    const totals = totalsByMonitor[index];
    if (!monitor || !totals) continue;

    addUptimeDay(monitor, totals, row.day_start_at, {
      total_sec: row.total_sec ?? 0,
      downtime_sec: row.downtime_sec ?? 0,
      unknown_sec: row.unknown_sec ?? 0,
      uptime_sec: row.uptime_sec ?? 0,
      uptime_pct: toUptimePct(row.total_sec ?? 0, row.uptime_sec ?? 0),
    });
  }

  if (needsToday) {
    for (const [monitorId, today] of todayByMonitorId) {
      const index = monitorIndexById.get(monitorId);
      if (index === undefined) continue;
      const monitor = monitors[index];
      const totals = totalsByMonitor[index];
      if (!monitor || !totals) continue;
      addUptimeDay(monitor, totals, todayStartAt, today);
    }
  }

  for (let index = 0; index < monitors.length; index += 1) {
    const monitor = monitors[index];
    const statusCodes = heartbeatStatusCodes[index];
    const totals = totalsByMonitor[index];
    if (!monitor || !statusCodes || !totals) continue;

    monitor.heartbeat_strip.status_codes = statusCodes.join('');
    monitor.uptime_30d =
      totals.totalSec === 0
        ? null
        : {
            uptime_pct: (totals.uptimeSec / totals.totalSec) * 100,
          };
  }

  return monitors;
}

async function buildHomepageMonitorData(
  db: D1Database,
  now: number,
  includeHiddenMonitors: boolean,
  opts: HomepageMonitorDataOptions = {},
): Promise<{
  monitors: HomepageMonitorCard[];
  monitorCountTotal: number;
  summary: PublicHomepageResponse['summary'];
  overallStatus: HomepageMonitorStatus;
  uptimeRatingLevel: 1 | 2 | 3 | 4 | 5;
}> {
  const rawMonitors = await listHomepageMonitorRows(db, includeHiddenMonitors);
  const monitorCountTotal = rawMonitors.length;
  const ids = rawMonitors.map((monitor) => monitor.id);
  const selectedRows =
    opts.cardLimit === undefined ? rawMonitors : rawMonitors.slice(0, Math.max(0, opts.cardLimit));

  const [maintenanceMonitorIds, uptimeRatingLevel] = await Promise.all([
    listHomepageMaintenanceMonitorIds(db, now, ids),
    opts.uptimeRatingLevel === undefined
      ? readHomepageUptimeRatingLevel(db)
      : Promise.resolve(opts.uptimeRatingLevel),
  ]);

  const summary: PublicHomepageResponse['summary'] = {
    up: 0,
    down: 0,
    maintenance: 0,
    paused: 0,
    unknown: 0,
  };

  for (let index = 0; index < rawMonitors.length; index += 1) {
    const row = rawMonitors[index];
    if (!row) continue;

    const presentation = computeHomepageMonitorPresentation(row, now, maintenanceMonitorIds);
    summary[presentation.status] += 1;
  }

  if (selectedRows.length === 0) {
    return {
      monitors: [],
      monitorCountTotal,
      summary,
      overallStatus: computeOverallStatus(summary),
      uptimeRatingLevel,
    };
  }

  const monitors = await buildHomepageMonitorCardsFromRows(
    db,
    now,
    selectedRows,
    maintenanceMonitorIds,
  );

  return {
    monitors,
    monitorCountTotal,
    summary,
    overallStatus: computeOverallStatus(summary),
    uptimeRatingLevel,
  };
}

async function findLatestVisibleResolvedIncident(
  db: D1Database,
  includeHiddenMonitors: boolean,
): Promise<IncidentRow | null> {
  const incidentVisibilitySql = incidentStatusPageVisibilityPredicate(includeHiddenMonitors);
  let cursor: number | null = null;

  while (true) {
    const queryResult: { results: IncidentRow[] | undefined } = cursor
      ? await db
          .prepare(
            `
            SELECT id, title, status, impact, message, started_at, resolved_at
            FROM incidents
            WHERE status = 'resolved'
              AND ${incidentVisibilitySql}
              AND id < ?2
            ORDER BY id DESC
            LIMIT ?1
          `,
          )
          .bind(PREVIEW_BATCH_LIMIT, cursor)
          .all<IncidentRow>()
      : await db
          .prepare(
            `
            SELECT id, title, status, impact, message, started_at, resolved_at
            FROM incidents
            WHERE status = 'resolved'
              AND ${incidentVisibilitySql}
            ORDER BY id DESC
            LIMIT ?1
          `,
          )
          .bind(PREVIEW_BATCH_LIMIT)
          .all<IncidentRow>();

    const rows: IncidentRow[] = queryResult.results ?? [];
    if (rows.length === 0) return null;

    const monitorIdsByIncidentId = await listIncidentMonitorIdsByIncidentId(
      db,
      rows.map((row) => row.id),
    );
    const visibleMonitorIds = includeHiddenMonitors
      ? new Set<number>()
      : await listStatusPageVisibleMonitorIds(
          db,
          [...monitorIdsByIncidentId.values()].flat(),
        );

    for (const row of rows) {
      const originalMonitorIds = monitorIdsByIncidentId.get(row.id) ?? [];
      const filteredMonitorIds = filterStatusPageScopedMonitorIds(
        originalMonitorIds,
        visibleMonitorIds,
        includeHiddenMonitors,
      );

      if (shouldIncludeStatusPageScopedItem(originalMonitorIds, filteredMonitorIds)) {
        return row;
      }
    }

    if (rows.length < PREVIEW_BATCH_LIMIT) {
      return null;
    }

    cursor = rows[rows.length - 1]?.id ?? null;
  }
}

async function findLatestVisibleHistoricalMaintenanceWindow(
  db: D1Database,
  now: number,
  includeHiddenMonitors: boolean,
): Promise<{ row: MaintenanceWindowRow; monitorIds: number[] } | null> {
  const maintenanceVisibilitySql = maintenanceWindowStatusPageVisibilityPredicate(
    includeHiddenMonitors,
  );
  let cursor: number | null = null;

  while (true) {
    const queryResult: { results: MaintenanceWindowRow[] | undefined } = cursor
      ? await db
          .prepare(
            `
            SELECT id, title, message, starts_at, ends_at, created_at
            FROM maintenance_windows
            WHERE ends_at <= ?1
              AND ${maintenanceVisibilitySql}
              AND id < ?3
            ORDER BY id DESC
            LIMIT ?2
          `,
          )
          .bind(now, PREVIEW_BATCH_LIMIT, cursor)
          .all<MaintenanceWindowRow>()
      : await db
          .prepare(
            `
            SELECT id, title, message, starts_at, ends_at, created_at
            FROM maintenance_windows
            WHERE ends_at <= ?1
              AND ${maintenanceVisibilitySql}
            ORDER BY id DESC
            LIMIT ?2
          `,
          )
          .bind(now, PREVIEW_BATCH_LIMIT)
          .all<MaintenanceWindowRow>();

    const rows: MaintenanceWindowRow[] = queryResult.results ?? [];
    if (rows.length === 0) return null;

    const monitorIdsByWindowId = await listMaintenanceWindowMonitorIdsByWindowId(
      db,
      rows.map((row) => row.id),
    );
    const visibleMonitorIds = includeHiddenMonitors
      ? new Set<number>()
      : await listStatusPageVisibleMonitorIds(
          db,
          [...monitorIdsByWindowId.values()].flat(),
        );

    for (const row of rows) {
      const originalMonitorIds = monitorIdsByWindowId.get(row.id) ?? [];
      const filteredMonitorIds = filterStatusPageScopedMonitorIds(
        originalMonitorIds,
        visibleMonitorIds,
        includeHiddenMonitors,
      );

      if (shouldIncludeStatusPageScopedItem(originalMonitorIds, filteredMonitorIds)) {
        return { row, monitorIds: filteredMonitorIds };
      }
    }

    if (rows.length < PREVIEW_BATCH_LIMIT) {
      return null;
    }

    cursor = rows[rows.length - 1]?.id ?? null;
  }
}

export async function readHomepageHistoryPreviews(
  db: D1Database,
  now: number,
): Promise<{
  resolvedIncidentPreview: IncidentSummary | null;
  maintenanceHistoryPreview: MaintenancePreview | null;
}> {
  const includeHiddenMonitors = false;
  const [resolvedIncidentPreview, maintenanceHistoryPreview] = await Promise.all([
    findLatestVisibleResolvedIncident(db, includeHiddenMonitors),
    findLatestVisibleHistoricalMaintenanceWindow(db, now, includeHiddenMonitors),
  ]);

  return {
    resolvedIncidentPreview: resolvedIncidentPreview
      ? toIncidentSummary(resolvedIncidentPreview)
      : null,
    maintenanceHistoryPreview: maintenanceHistoryPreview
      ? toMaintenancePreview(maintenanceHistoryPreview.row, maintenanceHistoryPreview.monitorIds)
      : null,
  };
}

export function homepageFromStatusPayload(
  status: PublicStatusResponse,
  previews: {
    resolvedIncidentPreview?: IncidentSummary | null;
    maintenanceHistoryPreview?: MaintenancePreview | null;
  } = {},
): PublicHomepageResponse {
  return {
    generated_at: status.generated_at,
    bootstrap_mode: 'full',
    monitor_count_total: status.monitors.length,
    site_title: status.site_title,
    site_description: status.site_description,
    site_locale: status.site_locale,
    site_timezone: status.site_timezone,
    uptime_rating_level: status.uptime_rating_level,
    overall_status: status.overall_status,
    banner: status.banner,
    summary: status.summary,
    monitors: status.monitors.map((monitor) => ({
      id: monitor.id,
      name: monitor.name,
      type: monitor.type,
      group_name: monitor.group_name,
      status: monitor.status,
      is_stale: monitor.is_stale,
      last_checked_at: monitor.last_checked_at,
      heartbeat_strip: {
        checked_at: monitor.heartbeats.map((heartbeat) => heartbeat.checked_at),
        status_codes: monitor.heartbeats
          .map((heartbeat) => toHeartbeatStatusCode(heartbeat.status))
          .join(''),
        latency_ms: monitor.heartbeats.map((heartbeat) => heartbeat.latency_ms),
      },
      uptime_30d: monitor.uptime_30d ? { uptime_pct: monitor.uptime_30d.uptime_pct } : null,
      uptime_day_strip: {
        day_start_at: monitor.uptime_days.map((day) => day.day_start_at),
        downtime_sec: monitor.uptime_days.map((day) => day.downtime_sec),
        unknown_sec: monitor.uptime_days.map((day) => day.unknown_sec),
        uptime_pct_milli: monitor.uptime_days.map((day) =>
          day.uptime_pct === null ? null : Math.round(day.uptime_pct * 1000),
        ),
      },
    })),
    active_incidents: status.active_incidents.map(incidentSummaryFromStatusIncident),
    maintenance_windows: {
      active: status.maintenance_windows.active.map(maintenancePreviewFromStatusWindow),
      upcoming: status.maintenance_windows.upcoming.map(maintenancePreviewFromStatusWindow),
    },
    resolved_incident_preview: previews.resolvedIncidentPreview ?? null,
    maintenance_history_preview: previews.maintenanceHistoryPreview ?? null,
  };
}

export async function computePublicHomepagePayload(
  db: D1Database,
  now: number,
): Promise<PublicHomepageResponse> {
  const includeHiddenMonitors = false;
  const settingsPromise = readPublicSiteSettings(db);

  const [
    settings,
    monitorData,
    activeIncidents,
    maintenanceWindows,
    historyPreviews,
  ] = await Promise.all([
    settingsPromise,
    settingsPromise.then((settings) =>
      buildHomepageMonitorData(db, now, includeHiddenMonitors, {
        uptimeRatingLevel: settings.uptime_rating_level,
      }),
    ),
    listVisibleActiveIncidents(db, includeHiddenMonitors),
    listVisibleMaintenanceWindows(db, now, includeHiddenMonitors),
    readHomepageHistoryPreviews(db, now),
  ]);

  const activeIncidentSummaries = new Array<IncidentSummary>(activeIncidents.length);
  for (let index = 0; index < activeIncidents.length; index += 1) {
    const incident = activeIncidents[index];
    if (!incident) continue;
    activeIncidentSummaries[index] = toIncidentSummary(incident.row);
  }

  const activeMaintenancePreview = new Array<MaintenancePreview>(maintenanceWindows.active.length);
  for (let index = 0; index < maintenanceWindows.active.length; index += 1) {
    const window = maintenanceWindows.active[index];
    if (!window) continue;
    activeMaintenancePreview[index] = toMaintenancePreview(window.row, window.monitorIds);
  }

  const upcomingMaintenancePreview = new Array<MaintenancePreview>(
    maintenanceWindows.upcoming.length,
  );
  for (let index = 0; index < maintenanceWindows.upcoming.length; index += 1) {
    const window = maintenanceWindows.upcoming[index];
    if (!window) continue;
    upcomingMaintenancePreview[index] = toMaintenancePreview(window.row, window.monitorIds);
  }

  return {
    generated_at: now,
    bootstrap_mode: 'full',
    monitor_count_total: monitorData.monitorCountTotal,
    site_title: settings.site_title,
    site_description: settings.site_description,
    site_locale: settings.site_locale,
    site_timezone: settings.site_timezone,
    uptime_rating_level: monitorData.uptimeRatingLevel,
    overall_status: monitorData.overallStatus,
    banner: buildPublicStatusBanner({
      counts: monitorData.summary,
      monitorCount: monitorData.monitors.length,
      activeIncidents,
      activeMaintenanceWindows: maintenanceWindows.active,
    }),
    summary: monitorData.summary,
    monitors: monitorData.monitors,
    active_incidents: activeIncidentSummaries,
    maintenance_windows: {
      active: activeMaintenancePreview,
      upcoming: upcomingMaintenancePreview,
    },
    resolved_incident_preview: historyPreviews.resolvedIncidentPreview,
    maintenance_history_preview: historyPreviews.maintenanceHistoryPreview,
  };
}

export async function computePublicHomepageArtifactPayload(
  db: D1Database,
  now: number,
): Promise<PublicHomepageResponse> {
  const includeHiddenMonitors = false;
  const settingsPromise = readPublicSiteSettings(db);
  const bootstrapRowsPromise = listHomepageMonitorRows(db, includeHiddenMonitors, 12);
  const [settings, summaryData, bootstrapRows, activeIncidents, maintenanceWindows, historyPreviews] =
    await Promise.all([
      settingsPromise,
      readHomepageMonitorSummary(db, now, includeHiddenMonitors),
      bootstrapRowsPromise,
      listVisibleActiveIncidents(db, includeHiddenMonitors),
      listVisibleMaintenanceWindows(db, now, includeHiddenMonitors),
      readHomepageHistoryPreviews(db, now),
    ]);
  const maintenanceMonitorIds = await listHomepageMaintenanceMonitorIds(
    db,
    now,
    bootstrapRows.map((row) => row.id),
  );
  const monitors = await buildHomepageMonitorCardsFromRows(
    db,
    now,
    bootstrapRows,
    maintenanceMonitorIds,
  );

  return {
    generated_at: now,
    bootstrap_mode: summaryData.monitorCountTotal > monitors.length ? 'partial' : 'full',
    monitor_count_total: summaryData.monitorCountTotal,
    site_title: settings.site_title,
    site_description: settings.site_description,
    site_locale: settings.site_locale,
    site_timezone: settings.site_timezone,
    uptime_rating_level: settings.uptime_rating_level,
    overall_status: summaryData.overallStatus,
    banner: buildPublicStatusBanner({
      counts: summaryData.summary,
      monitorCount: summaryData.monitorCountTotal,
      activeIncidents,
      activeMaintenanceWindows: maintenanceWindows.active,
    }),
    summary: summaryData.summary,
    monitors,
    active_incidents: activeIncidents.map(({ row }) => toIncidentSummary(row)),
    maintenance_windows: {
      active: maintenanceWindows.active.map(({ row, monitorIds }) =>
        toMaintenancePreview(row, monitorIds),
      ),
      upcoming: maintenanceWindows.upcoming.map(({ row, monitorIds }) =>
        toMaintenancePreview(row, monitorIds),
      ),
    },
    resolved_incident_preview: historyPreviews.resolvedIncidentPreview,
    maintenance_history_preview: historyPreviews.maintenanceHistoryPreview,
  };
}
