import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { DATABASE_URL, resetDatabase } from '../src/db';

// Two apps, each with its own connection pool, stand in for two processes
// sharing one PostgreSQL (see README: not a true multi-process test).
let adminPool: Pool;
let pools: Pool[];
let apps: FastifyInstance[];

beforeAll(async () => {
  adminPool = new Pool({ connectionString: DATABASE_URL, max: 2 });
  await resetDatabase(adminPool);
  pools = [0, 1].map(() => new Pool({ connectionString: DATABASE_URL, max: 8 }));
  apps = pools.map((p) => buildApp(p));
});

beforeEach(async () => {
  await adminPool.query('TRUNCATE reservations');
});

afterAll(async () => {
  await Promise.all(apps.map((a) => a.close()));
  await Promise.all(pools.map((p) => p.end()));
  await adminPool.end();
});

const TOKEN_A = 'test-token-a';
const TOKEN_B = 'test-token-b';

const booking = (over: Record<string, unknown> = {}) => ({
  externalBookingId: 'BROKER-1001',
  operatorId: 'operator-a',
  vehicleGroup: 'economy',
  pickupLocation: 'airport',
  dropoffLocation: 'airport',
  pickupAt: '2030-06-10T10:00:00Z',
  dropoffAt: '2030-06-12T10:00:00Z',
  customer: { name: 'Alex Example', email: 'alex@example.com' },
  ...over,
});

function post(app: FastifyInstance, token: string | null, body: unknown, raw = false) {
  return app.inject({
    method: 'POST',
    url: '/reservations',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    payload: raw ? (body as string) : JSON.stringify(body),
  });
}

const rows = async () => (await adminPool.query('SELECT * FROM reservations ORDER BY created_at')).rows;
const numeric = (a: number, b: number) => a - b;
const expectError = (res: { statusCode: number; json: () => any }, status: number, code: string) => {
  expect(res.statusCode).toBe(status);
  expect(res.json()).toEqual({ error: { code, message: expect.any(String) } });
};

describe('basic flow and retries', () => {
  it('creates a new booking: 201 and one committed row', async () => {
    const res = await post(apps[0], TOKEN_A, booking());
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      reservationId: expect.any(String),
      externalBookingId: 'BROKER-1001',
      operatorId: 'operator-a',
    });
    const r = await rows();
    expect(r).toHaveLength(1);
    expect(r[0].id).toBe(res.json().reservationId);
  });

  it('identical retry returns 200 with the original id (even though the vehicle is now occupied)', async () => {
    const first = await post(apps[0], TOKEN_A, booking());
    const retry = await post(apps[1], TOKEN_A, booking());
    expect(retry.statusCode).toBe(200);
    expect(retry.json().reservationId).toBe(first.json().reservationId);
    expect(await rows()).toHaveLength(1);
  });

  it('JSON property order and equivalent instants do not matter', async () => {
    const first = await post(apps[0], TOKEN_A, booking());
    const reordered = {
      customer: { email: 'alex@example.com', name: 'Alex Example' },
      dropoffAt: '2030-06-12T12:00:00+02:00', // same instant as ...T10:00:00Z
      pickupAt: '2030-06-10T12:00:00.000+02:00',
      dropoffLocation: 'airport',
      pickupLocation: 'airport',
      vehicleGroup: 'economy',
      operatorId: 'operator-a',
      externalBookingId: 'BROKER-1001',
    };
    const retry = await post(apps[0], TOKEN_A, reordered);
    expect(retry.statusCode).toBe(200);
    expect(retry.json().reservationId).toBe(first.json().reservationId);
  });

  it.each([
    ['customer email', { customer: { name: 'Alex Example', email: 'other@example.com' } }],
    ['customer name (exact compare)', { customer: { name: 'alex example', email: 'alex@example.com' } }],
    ['vehicle group', { vehicleGroup: 'compact' }],
    ['dropoff instant', { dropoffAt: '2030-06-12T10:00:01Z' }],
    ['overlapping own dates', { pickupAt: '2030-06-11T10:00:00Z' }],
  ])('same key, changed %s -> IDEMPOTENCY_CONFLICT, original unchanged', async (_label, change) => {
    const first = await post(apps[0], TOKEN_A, booking());
    const before = await rows();
    const res = await post(apps[1], TOKEN_A, booking(change));
    expectError(res, 409, 'IDEMPOTENCY_CONFLICT');
    expect(await rows()).toEqual(before);
    expect(before[0].id).toBe(first.json().reservationId);
  });

  it('a rejected request does not reserve its booking key', async () => {
    await post(apps[0], TOKEN_A, booking({ externalBookingId: 'HOLDER' }));
    const rejected = await post(apps[0], TOKEN_A, booking({ externalBookingId: 'LATER' }));
    expectError(rejected, 409, 'NO_AVAILABILITY');
    expect(await rows()).toHaveLength(1);

    // Same key, different (free) period: must be a fresh 201, not an idempotency conflict.
    const ok = await post(apps[0], TOKEN_A, booking({
      externalBookingId: 'LATER',
      pickupAt: '2030-07-01T10:00:00Z',
      dropoffAt: '2030-07-02T10:00:00Z',
    }));
    expect(ok.statusCode).toBe(201);
    expect(await rows()).toHaveLength(2);
  });
});

describe('overlap boundaries, [pickupAt, dropoffAt)', () => {
  // Existing: 2030-06-10T10:00Z .. 2030-06-12T10:00Z
  it.each([
    ['starts exactly when existing ends', '2030-06-12T10:00:00Z', '2030-06-13T10:00:00Z', 201],
    ['ends exactly when existing starts', '2030-06-09T10:00:00Z', '2030-06-10T10:00:00Z', 201],
    ['partial overlap at the start', '2030-06-09T10:00:00Z', '2030-06-10T10:00:01Z', 409],
    ['partial overlap at the end', '2030-06-12T09:59:59Z', '2030-06-13T10:00:00Z', 409],
    ['contained inside', '2030-06-11T00:00:00Z', '2030-06-11T12:00:00Z', 409],
    ['contains existing', '2030-06-01T00:00:00Z', '2030-06-30T00:00:00Z', 409],
    ['identical period, different id', '2030-06-10T10:00:00Z', '2030-06-12T10:00:00Z', 409],
  ])('%s -> %i', async (_label, pickupAt, dropoffAt, expected) => {
    await post(apps[0], TOKEN_A, booking());
    const res = await post(apps[0], TOKEN_A, booking({ externalBookingId: 'BROKER-2000', pickupAt, dropoffAt }));
    expect(res.statusCode).toBe(expected);
    if (expected === 409) expectError(res, 409, 'NO_AVAILABILITY');
    expect(await rows()).toHaveLength(expected === 201 ? 2 : 1);
  });

  it('changed-payload conflict wins over availability for an existing key', async () => {
    await post(apps[0], TOKEN_A, booking());
    // Overlaps the vehicle occupied by ITSELF; must still be IDEMPOTENCY_CONFLICT.
    const res = await post(apps[0], TOKEN_A, booking({ dropoffAt: '2030-06-13T10:00:00Z' }));
    expectError(res, 409, 'IDEMPOTENCY_CONFLICT');
  });
});

describe('concurrency', () => {
  it('different ids competing for one pool: exactly one 201, rest NO_AVAILABILITY, one row', async () => {
    const n = 12;
    const results = await Promise.all(
      Array.from({ length: n }, (_, i) =>
        post(apps[i % 2], TOKEN_A, booking({ externalBookingId: `RACE-${i}` })),
      ),
    );
    const statuses = results.map((r) => r.statusCode).sort(numeric);
    expect(statuses).toEqual([201, ...Array(n - 1).fill(409)]);
    for (const r of results.filter((r) => r.statusCode === 409)) expectError(r, 409, 'NO_AVAILABILITY');
    expect(await rows()).toHaveLength(1);
  });

  it('identical concurrent requests: one 201, others 200, same id, one row', async () => {
    const n = 8;
    const results = await Promise.all(
      Array.from({ length: n }, (_, i) => post(apps[i % 2], TOKEN_A, booking())),
    );
    expect(results.map((r) => r.statusCode).sort(numeric)).toEqual([...Array(n - 1).fill(200), 201]);
    expect(new Set(results.map((r) => r.json().reservationId)).size).toBe(1);
    expect(await rows()).toHaveLength(1);
  });

  it('same booking id concurrently for economy vs compact: one 201, one IDEMPOTENCY_CONFLICT, one row (x15 rounds)', async () => {
    for (let round = 0; round < 15; round++) {
      await adminPool.query('TRUNCATE reservations');
      const [x, y] = await Promise.all([
        post(apps[0], TOKEN_A, booking({ vehicleGroup: 'economy' })),
        post(apps[1], TOKEN_A, booking({ vehicleGroup: 'compact' })),
      ]);
      const sorted = [x, y].sort((a, b) => a.statusCode - b.statusCode);
      expect(sorted[0].statusCode).toBe(201);
      expectError(sorted[1], 409, 'IDEMPOTENCY_CONFLICT');
      expect(await rows()).toHaveLength(1);
    }
  });
});

describe('tenant isolation', () => {
  it('same booking id and dates for two operators both succeed independently', async () => {
    const [a, b] = await Promise.all([
      post(apps[0], TOKEN_A, booking()),
      post(apps[1], TOKEN_B, booking({ operatorId: 'operator-b' })),
    ]);
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(a.json().reservationId).not.toBe(b.json().reservationId);
    expect(b.json().operatorId).toBe('operator-b');
    const r = await rows();
    expect(r.map((x) => x.operator_id).sort()).toEqual(['operator-a', 'operator-b']);
  });

  it("operator B's replay returns B's reservation, never A's", async () => {
    const a = await post(apps[0], TOKEN_A, booking());
    const b1 = await post(apps[0], TOKEN_B, booking({ operatorId: 'operator-b' }));
    const b2 = await post(apps[0], TOKEN_B, booking({ operatorId: 'operator-b' }));
    expect(b2.statusCode).toBe(200);
    expect(b2.json().reservationId).toBe(b1.json().reservationId);
    expect(b2.json().reservationId).not.toBe(a.json().reservationId);
  });

  it('token/body operator mismatch -> 403, nothing written', async () => {
    const res = await post(apps[0], TOKEN_B, booking({ operatorId: 'operator-a' }));
    expectError(res, 403, 'FORBIDDEN');
    expect(await rows()).toHaveLength(0);
  });

  it("operator B cannot book operator A's compact pool (not seeded for B)", async () => {
    const res = await post(apps[0], TOKEN_B, booking({ operatorId: 'operator-b', vehicleGroup: 'compact' }));
    expectError(res, 400, 'INVALID_REQUEST');
  });
});

describe('auth and validation', () => {
  it('401 for missing / unknown token', async () => {
    expectError(await post(apps[0], null, booking()), 401, 'UNAUTHORIZED');
    expectError(await post(apps[0], 'nope', booking()), 401, 'UNAUTHORIZED');
    expect(await rows()).toHaveLength(0);
  });

  it('401 wins over a malformed body', async () => {
    expectError(await post(apps[0], null, '{not json', true), 401, 'UNAUTHORIZED');
  });

  it('400 for malformed JSON', async () => {
    expectError(await post(apps[0], TOKEN_A, '{not json', true), 400, 'INVALID_REQUEST');
  });

  const { externalBookingId: _omit, ...missingId } = booking();
  it.each<[string, unknown]>([
    ['missing externalBookingId', missingId],
    ['blank externalBookingId', booking({ externalBookingId: '   ' })],
    ['non-string vehicleGroup', booking({ vehicleGroup: 5 })],
    ['missing customer', booking({ customer: undefined })],
    ['bad email', booking({ customer: { name: 'A', email: 'not-an-email' } })],
    ['timestamp without timezone', booking({ pickupAt: '2030-06-10T10:00:00' })],
    ['impossible date', booking({ pickupAt: '2030-02-30T10:00:00Z' })],
    ['pickup == dropoff', booking({ dropoffAt: '2030-06-10T10:00:00Z' })],
    ['pickup after dropoff', booking({ pickupAt: '2030-06-13T10:00:00Z' })],
    ['unsupported group', booking({ vehicleGroup: 'luxury' })],
    ['non-airport pickup', booking({ pickupLocation: 'downtown' })],
    ['non-airport dropoff', booking({ dropoffLocation: 'downtown' })],
    ['array body', []],
  ])('400 for %s, nothing written', async (_label, body) => {
    expectError(await post(apps[0], TOKEN_A, body), 400, 'INVALID_REQUEST');
    expect(await rows()).toHaveLength(0);
  });
});
