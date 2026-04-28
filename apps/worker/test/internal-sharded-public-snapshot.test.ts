import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../src/env';
import worker from '../src/index';
import {
  buildHomepageEnvelopeFragmentWrite,
  buildHomepageMonitorFragmentWrites,
  buildStatusEnvelopeFragmentWrite,
  buildStatusMonitorFragmentWrites,
  HOMEPAGE_ENVELOPE_FRAGMENT_KEY,
  HOMEPAGE_MONITOR_FRAGMENTS_KEY,
  STATUS_ENVELOPE_FRAGMENT_KEY,
  STATUS_MONITOR_FRAGMENTS_KEY,
} from '../src/snapshots/public-monitor-fragments';
import { createFakeD1Database } from './helpers/fake-d1';

function toRow(write: {
  fragmentKey: string;
  generatedAt: number;
  bodyJson: string;
  updatedAt: number;
}) {
  return {
    fragment_key: write.fragmentKey,
    generated_at: write.generatedAt,
    body_json: write.bodyJson,
    updated_at: write.updatedAt,
  };
}

function statusPayload() {
  return {
    generated_at: 1_700_000_000,
    site_title: 'Uptimer',
    site_description: '',
    site_locale: 'auto' as const,
    site_timezone: 'UTC',
    uptime_rating_level: 4 as const,
    overall_status: 'up' as const,
    banner: {
      source: 'monitors' as const,
      status: 'operational' as const,
      title: 'All Systems Operational',
      down_ratio: null,
    },
    summary: { up: 1, down: 0, maintenance: 0, paused: 0, unknown: 0 },
    monitors: [
      {
        id: 1,
        name: 'API',
        type: 'http' as const,
        group_name: null,
        group_sort_order: 0,
        sort_order: 1,
        uptime_rating_level: 4 as const,
        status: 'up' as const,
        is_stale: false,
        last_checked_at: 1_700_000_000,
        last_latency_ms: 42,
        heartbeats: [{ checked_at: 1_700_000_000, status: 'up' as const, latency_ms: 42 }],
        uptime_30d: {
          range_start_at: 1_697_408_000,
          range_end_at: 1_700_000_000,
          total_sec: 2_592_000,
          downtime_sec: 0,
          unknown_sec: 0,
          uptime_sec: 2_592_000,
          uptime_pct: 100,
        },
        uptime_days: [
          {
            day_start_at: 1_699_920_000,
            total_sec: 86_400,
            downtime_sec: 0,
            unknown_sec: 0,
            uptime_sec: 86_400,
            uptime_pct: 100,
          },
        ],
      },
    ],
    active_incidents: [],
    maintenance_windows: { active: [], upcoming: [] },
  };
}

function homepagePayload() {
  return {
    generated_at: 1_700_000_000,
    bootstrap_mode: 'full' as const,
    monitor_count_total: 1,
    site_title: 'Uptimer',
    site_description: '',
    site_locale: 'auto' as const,
    site_timezone: 'UTC',
    uptime_rating_level: 4 as const,
    overall_status: 'up' as const,
    banner: {
      source: 'monitors' as const,
      status: 'operational' as const,
      title: 'All Systems Operational',
      down_ratio: null,
    },
    summary: { up: 1, down: 0, maintenance: 0, paused: 0, unknown: 0 },
    monitors: [
      {
        id: 1,
        name: 'API',
        type: 'http' as const,
        group_name: null,
        status: 'up' as const,
        is_stale: false,
        last_checked_at: 1_700_000_000,
        heartbeat_strip: {
          checked_at: [1_700_000_000],
          status_codes: 'u',
          latency_ms: [42],
        },
        uptime_30d: { uptime_pct: 100 },
        uptime_day_strip: {
          day_start_at: [1_699_920_000],
          downtime_sec: [0],
          unknown_sec: [0],
          uptime_pct_milli: [100_000],
        },
      },
    ],
    active_incidents: [],
    maintenance_windows: { active: [], upcoming: [] },
    resolved_incident_preview: null,
    maintenance_history_preview: null,
  };
}

function createFragmentEnv(): Env {
  const statusEnvelope = buildStatusEnvelopeFragmentWrite(statusPayload(), 1_700_000_005);
  const statusMonitors = buildStatusMonitorFragmentWrites(statusPayload(), 1_700_000_005);
  const homepageEnvelope = buildHomepageEnvelopeFragmentWrite(homepagePayload(), 1_700_000_005);
  const homepageMonitors = buildHomepageMonitorFragmentWrites(homepagePayload(), 1_700_000_005);

  return {
    DB: createFakeD1Database([
      {
        match: 'from public_snapshot_fragments',
        all: (args) => {
          switch (args[0]) {
            case STATUS_ENVELOPE_FRAGMENT_KEY:
              return [toRow(statusEnvelope)];
            case STATUS_MONITOR_FRAGMENTS_KEY:
              return statusMonitors.map(toRow);
            case HOMEPAGE_ENVELOPE_FRAGMENT_KEY:
              return [toRow(homepageEnvelope)];
            case HOMEPAGE_MONITOR_FRAGMENTS_KEY:
              return homepageMonitors.map(toRow);
            default:
              return [];
          }
        },
      },
    ]),
    ADMIN_TOKEN: 'test-admin-token',
    UPTIMER_PUBLIC_SHARDED_ASSEMBLER: '1',
  } as unknown as Env;
}

describe('internal sharded public snapshot assembler route', () => {
  it('is hidden unless the feature flag is enabled', async () => {
    const env = {
      DB: createFakeD1Database([]),
      ADMIN_TOKEN: 'test-admin-token',
    } as unknown as Env;

    const res = await worker.fetch(
      new Request('http://internal/api/v1/internal/assemble/sharded-public-snapshot', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-admin-token',
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({ kind: 'homepage' }),
      }),
      env,
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    );

    expect(res.status).toBe(404);
  });

  it('assembles homepage fragments and reports bounded metadata', async () => {
    const res = await worker.fetch(
      new Request('http://internal/api/v1/internal/assemble/sharded-public-snapshot', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-admin-token',
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({ kind: 'homepage', measure_body_bytes: true }),
      }),
      createFragmentEnv(),
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      assembled: true,
      kind: 'homepage',
      assembly: 'validated',
      generated_at: 1_700_000_000,
      monitor_count: 1,
      invalid_count: 0,
      stale_count: 0,
      body_bytes: expect.any(Number),
    });
  });

  it('assembles status fragments and reports bounded metadata', async () => {
    const res = await worker.fetch(
      new Request('http://internal/api/v1/internal/assemble/sharded-public-snapshot', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-admin-token',
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({ kind: 'status' }),
      }),
      createFragmentEnv(),
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      assembled: true,
      kind: 'status',
      assembly: 'validated',
      generated_at: 1_700_000_000,
      monitor_count: 1,
      invalid_count: 0,
      stale_count: 0,
    });
  });

  it('assembles fragment JSON without parsing every monitor when requested', async () => {
    const res = await worker.fetch(
      new Request('http://internal/api/v1/internal/assemble/sharded-public-snapshot', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-admin-token',
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({ kind: 'homepage', assembly: 'json', measure_body_bytes: true }),
      }),
      createFragmentEnv(),
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      assembled: true,
      kind: 'homepage',
      assembly: 'json',
      generated_at: 1_700_000_000,
      monitor_count: 1,
      invalid_count: 0,
      stale_count: 0,
      body_bytes: expect.any(Number),
    });
  });
});

describe('internal sharded public snapshot continuation route', () => {
  it('is hidden unless the continuation flag is enabled', async () => {
    const env = {
      DB: createFakeD1Database([]),
      ADMIN_TOKEN: 'test-admin-token',
    } as unknown as Env;

    const res = await worker.fetch(
      new Request('http://internal/api/v1/internal/continue/sharded-public-snapshot', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-admin-token',
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({ step: 'assemble', kind: 'homepage' }),
      }),
      env,
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    );

    expect(res.status).toBe(404);
  });

  it('runs one bounded seed step and queues the next continuation', async () => {
    const writes: unknown[][] = [];
    const generatedAt = Math.floor(Date.now() / 1000);
    const payload = { ...statusPayload(), generated_at: generatedAt };
    const selfRequests: Request[] = [];
    const waitUntil = vi.fn();
    const continuationResponse = new Response(JSON.stringify({ ok: true }), { status: 200 });
    const continuationBodyRead = vi.spyOn(continuationResponse, 'text');
    const env = {
      DB: createFakeD1Database([
        {
          match: (sql) => sql.includes('from public_snapshots') && !sql.includes('body_json'),
          first: () => ({ generated_at: payload.generated_at, updated_at: payload.generated_at }),
        },
        {
          match: (sql) => sql.includes('from public_snapshots') && sql.includes('body_json'),
          first: () => ({
            generated_at: payload.generated_at,
            updated_at: payload.generated_at,
            body_json: JSON.stringify(payload),
          }),
        },
        {
          match: 'insert into public_snapshot_fragments',
          run: (args) => {
            writes.push(args);
            return 1;
          },
        },
      ]),
      ADMIN_TOKEN: 'test-admin-token',
      UPTIMER_SCHEDULED_SHARDED_CONTINUATION: '1',
      UPTIMER_PUBLIC_SHARDED_FRAGMENT_SEED: '1',
      UPTIMER_SCHEDULED_SHARDED_FRAGMENT_SEED: '1',
      SELF: {
        fetch: vi.fn(async (request: Request) => {
          selfRequests.push(request);
          return continuationResponse;
        }),
      },
    } as unknown as Env;

    const res = await worker.fetch(
      new Request('http://internal/api/v1/internal/continue/sharded-public-snapshot', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-admin-token',
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({
          step: 'seed',
          kind: 'status',
          part: 'monitors',
          monitor_offset: 0,
          monitor_limit: 1,
        }),
      }),
      env,
      { waitUntil } as unknown as ExecutionContext,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      step: 'seed',
      seeded: true,
      kind: 'status',
      part: 'monitors',
      monitor_count: 1,
      monitor_offset: 0,
      monitor_limit: 1,
      write_count: 1,
      continued: true,
      next_step: { step: 'assemble', kind: 'homepage' },
    });
    expect(writes).toHaveLength(1);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    await Promise.all(waitUntil.mock.calls.map((call) => call[0] as Promise<unknown>));
    expect(selfRequests).toHaveLength(1);
    expect(continuationBodyRead).toHaveBeenCalledTimes(1);
    expect(new URL(selfRequests[0]!.url).pathname).toBe(
      '/api/v1/internal/continue/sharded-public-snapshot',
    );
    await expect(selfRequests[0]!.json()).resolves.toEqual({
      step: 'assemble',
      kind: 'homepage',
    });
  });
});

describe('internal sharded public snapshot fragment seed route', () => {
  it('is hidden unless the seed flag is enabled', async () => {
    const env = {
      DB: createFakeD1Database([]),
      ADMIN_TOKEN: 'test-admin-token',
    } as unknown as Env;

    const res = await worker.fetch(
      new Request('http://internal/api/v1/internal/seed/sharded-public-snapshot', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-admin-token',
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({ kind: 'status', part: 'envelope' }),
      }),
      env,
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    );

    expect(res.status).toBe(404);
  });

  it('seeds bounded status fragments from the current static snapshot', async () => {
    const writes: unknown[][] = [];
    const generatedAt = Math.floor(Date.now() / 1000);
    const payload = { ...statusPayload(), generated_at: generatedAt };
    const env = {
      DB: createFakeD1Database([
        {
          match: (sql) => sql.includes('from public_snapshots') && !sql.includes('body_json'),
          first: () => ({ generated_at: payload.generated_at, updated_at: payload.generated_at }),
        },
        {
          match: (sql) => sql.includes('from public_snapshots') && sql.includes('body_json'),
          first: () => ({
            generated_at: payload.generated_at,
            updated_at: payload.generated_at,
            body_json: JSON.stringify(payload),
          }),
        },
        {
          match: 'insert into public_snapshot_fragments',
          run: (args) => {
            writes.push(args);
            return 1;
          },
        },
      ]),
      ADMIN_TOKEN: 'test-admin-token',
      UPTIMER_PUBLIC_SHARDED_FRAGMENT_SEED: '1',
    } as unknown as Env;

    const res = await worker.fetch(
      new Request('http://internal/api/v1/internal/seed/sharded-public-snapshot', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-admin-token',
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({
          kind: 'status',
          part: 'all',
          monitor_offset: 0,
          monitor_limit: 1,
        }),
      }),
      env,
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      seeded: true,
      kind: 'status',
      part: 'all',
      generated_at: payload.generated_at,
      monitor_count: 1,
      monitor_offset: 0,
      monitor_limit: 1,
      write_count: 2,
    });
    expect(writes).toHaveLength(2);
    expect(writes.map((args) => [args[0], args[1]])).toEqual([
      [STATUS_ENVELOPE_FRAGMENT_KEY, 'envelope'],
      [STATUS_MONITOR_FRAGMENTS_KEY, 'monitor:1'],
    ]);
  });
});
