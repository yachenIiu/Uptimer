import { AppError } from '../middleware/errors';

const SNAPSHOT_KEY = 'homepage';
const SNAPSHOT_ARTIFACT_KEY = 'homepage:artifact';
const MAX_AGE_SECONDS = 60;
const MAX_STALE_SECONDS = 10 * 60;
const SPLIT_SNAPSHOT_VERSION = 3;
const LEGACY_COMBINED_SNAPSHOT_VERSION = 2;

const READ_SNAPSHOT_SQL = `
  SELECT generated_at, body_json
  FROM public_snapshots
  WHERE key = ?1
`;

const readSnapshotStatementByDb = new WeakMap<D1Database, D1PreparedStatement>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function looksLikeHomepagePayload(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.generated_at === 'number' &&
    (value.bootstrap_mode === 'full' || value.bootstrap_mode === 'partial') &&
    typeof value.monitor_count_total === 'number' &&
    typeof value.site_title === 'string' &&
    Array.isArray(value.monitors) &&
    Array.isArray(value.active_incidents) &&
    isRecord(value.summary) &&
    isRecord(value.banner) &&
    isRecord(value.maintenance_windows)
  );
}

function looksLikeHomepageArtifact(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.generated_at === 'number' &&
    typeof value.preload_html === 'string' &&
    typeof value.meta_title === 'string' &&
    typeof value.meta_description === 'string' &&
    looksLikeHomepagePayload(value.snapshot)
  );
}

function looksLikeSerializedHomepageArtifact(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed.startsWith('{"generated_at":') &&
    trimmed.includes('"preload_html"') &&
    trimmed.includes('"meta_title"') &&
    trimmed.includes('"snapshot"')
  );
}

function looksLikeSerializedHomepagePayload(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed.startsWith('{"generated_at":') &&
    trimmed.includes('"bootstrap_mode"') &&
    trimmed.includes('"monitor_count_total"')
  );
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

async function readSnapshotRow(
  db: D1Database,
  key: string,
): Promise<{ generated_at: number; body_json: string } | null> {
  try {
    const cached = readSnapshotStatementByDb.get(db);
    const statement = cached ?? db.prepare(READ_SNAPSHOT_SQL);
    if (!cached) {
      readSnapshotStatementByDb.set(db, statement);
    }

    return await statement.bind(key).first<{ generated_at: number; body_json: string }>();
  } catch (err) {
    console.warn('homepage snapshot: read failed', err);
    return null;
  }
}

export async function readHomepageSnapshotGeneratedAt(db: D1Database): Promise<number | null> {
  const row = await readSnapshotRow(db, SNAPSHOT_KEY);
  return row?.generated_at ?? null;
}

export async function readHomepageArtifactSnapshotGeneratedAt(
  db: D1Database,
): Promise<number | null> {
  const row =
    (await readSnapshotRow(db, SNAPSHOT_ARTIFACT_KEY)) ?? (await readSnapshotRow(db, SNAPSHOT_KEY));
  return row?.generated_at ?? null;
}

export function applyHomepageCacheHeaders(res: Response, ageSeconds: number): void {
  const remaining = Math.max(0, MAX_AGE_SECONDS - ageSeconds);
  const maxAge = Math.min(30, remaining);
  const stale = Math.max(0, remaining - maxAge);

  res.headers.set(
    'Cache-Control',
    `public, max-age=${maxAge}, stale-while-revalidate=${stale}, stale-if-error=${stale}`,
  );
}

export async function readHomepageSnapshotJsonAnyAge(
  db: D1Database,
  now: number,
  maxStaleSeconds = MAX_STALE_SECONDS,
): Promise<{ bodyJson: string; age: number } | null> {
  const row = await readSnapshotRow(db, SNAPSHOT_KEY);
  if (!row) return null;

  const age = Math.max(0, now - row.generated_at);
  if (age > maxStaleSeconds) return null;

  if (looksLikeSerializedHomepagePayload(row.body_json)) {
    return { bodyJson: row.body_json, age };
  }

  const parsed = safeJsonParse(row.body_json);
  if (parsed === null) return null;

  if (looksLikeHomepagePayload(parsed)) {
    return { bodyJson: JSON.stringify(parsed), age };
  }

  if (isRecord(parsed)) {
    const version = parsed.version;
    if (version === SPLIT_SNAPSHOT_VERSION || version === LEGACY_COMBINED_SNAPSHOT_VERSION) {
      const data = parsed.data;
      if (looksLikeHomepagePayload(data)) {
        return { bodyJson: JSON.stringify(data), age };
      }
    }
  }

  console.warn('homepage snapshot: invalid payload');
  return null;
}

export async function readHomepageSnapshotJson(
  db: D1Database,
  now: number,
): Promise<{ bodyJson: string; age: number } | null> {
  return await readHomepageSnapshotJsonAnyAge(db, now, MAX_AGE_SECONDS);
}

export async function readHomepageSnapshotArtifactJson(
  db: D1Database,
  now: number,
): Promise<{ bodyJson: string; age: number } | null> {
  const row =
    (await readSnapshotRow(db, SNAPSHOT_ARTIFACT_KEY)) ?? (await readSnapshotRow(db, SNAPSHOT_KEY));
  if (!row) return null;

  const age = Math.max(0, now - row.generated_at);
  if (age > MAX_AGE_SECONDS) return null;

  // Fast-path: already-stored JSON (written by our own snapshot writer).
  if (looksLikeSerializedHomepageArtifact(row.body_json)) {
    return { bodyJson: row.body_json, age };
  }

  const parsed = safeJsonParse(row.body_json);
  if (parsed === null) return null;
  if (!looksLikeHomepageArtifact(parsed)) {
    console.warn('homepage snapshot: invalid artifact payload');
    return null;
  }

  return { bodyJson: JSON.stringify(parsed), age };
}

export async function readStaleHomepageSnapshotArtifactJson(
  db: D1Database,
  now: number,
): Promise<{ bodyJson: string; age: number } | null> {
  const row =
    (await readSnapshotRow(db, SNAPSHOT_ARTIFACT_KEY)) ?? (await readSnapshotRow(db, SNAPSHOT_KEY));
  if (!row) return null;

  const age = Math.max(0, now - row.generated_at);
  if (age > MAX_STALE_SECONDS) return null;

  if (looksLikeSerializedHomepageArtifact(row.body_json)) {
    return { bodyJson: row.body_json, age };
  }

  const parsed = safeJsonParse(row.body_json);
  if (parsed === null) return null;
  if (!looksLikeHomepageArtifact(parsed)) {
    console.warn('homepage snapshot: invalid stale artifact payload');
    return null;
  }

  return { bodyJson: JSON.stringify(parsed), age };
}

export function assertHomepageArtifactAvailable(): never {
  throw new AppError(503, 'UNAVAILABLE', 'Homepage artifact unavailable');
}
