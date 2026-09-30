import type { Pool, PoolClient } from 'pg';
import { ApiError } from './errors';
import type { ReservationInput } from './validation';

export interface CreateResult {
  created: boolean;
  reservationId: string;
}

const PG_UNIQUE_VIOLATION = '23505';
const PG_EXCLUSION_VIOLATION = '23P01';

const pgCode = (e: unknown): string | undefined =>
  typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : undefined;

type ExistingRow = {
  id: string;
  vehicle_group: string;
  pickup_location: string;
  dropoff_location: string;
  pickup_at: Date;
  dropoff_at: Date;
  customer_name: string;
  customer_email: string;
};

export async function createReservation(
  pool: Pool,
  operatorId: string,
  input: ReservationInput,
): Promise<CreateResult> {
  for (let attempt = 0; ; attempt++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await runInTransaction(client, operatorId, input);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      // Backstop only: the advisory lock below should make this unreachable.
      if (pgCode(err) === PG_UNIQUE_VIOLATION && attempt === 0) continue;
      throw err;
    } finally {
      client.release();
    }
  }
}

async function runInTransaction(
  client: PoolClient,
  operatorId: string,
  input: ReservationInput,
): Promise<CreateResult> {
  // 1. Supported inventory (400 wins over everything below).
  const pool = await client.query<{ id: number }>(
    `SELECT id FROM vehicle_pools WHERE operator_id = $1 AND vehicle_group = $2 AND location = $3`,
    [operatorId, input.vehicleGroup, input.pickupLocation],
  );
  if (pool.rows.length === 0) throw new ApiError(400, 'INVALID_REQUEST', 'Unsupported inventory.');
  const poolId = pool.rows[0].id;

  // 2. Serialize all requests for the same (operator, externalBookingId), whatever
  //    vehicle group/dates they carry. Released automatically at COMMIT/ROLLBACK.
  const lockKey = `${operatorId.length}:${operatorId}:${input.externalBookingId}`;
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [lockKey]);

  // 3. Existing key? Idempotency decision comes BEFORE availability.
  const existing = await client.query<ExistingRow>(
    `SELECT id, vehicle_group, pickup_location, dropoff_location, pickup_at, dropoff_at,
            customer_name, customer_email
       FROM reservations
      WHERE operator_id = $1 AND external_booking_id = $2`,
    [operatorId, input.externalBookingId],
  );
  if (existing.rows.length > 0) {
    const row = existing.rows[0];
    if (!isSamePayload(row, input)) {
      throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'This booking ID was already used with different details.');
    }
    return { created: false, reservationId: row.id };
  }

  // 4. New key: insert. The exclusion constraint is what actually prevents overlap;
  //    a concurrent overlapping insert blocks here until the other tx ends.
  try {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO reservations
         (operator_id, external_booking_id, pool_id, vehicle_group, pickup_location,
          dropoff_location, pickup_at, dropoff_at, customer_name, customer_email)
       VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz, $9, $10)
       RETURNING id`,
      [
        operatorId,
        input.externalBookingId,
        poolId,
        input.vehicleGroup,
        input.pickupLocation,
        input.dropoffLocation,
        input.pickupAt.toISOString(),
        input.dropoffAt.toISOString(),
        input.customer.name,
        input.customer.email,
      ],
    );
    return { created: true, reservationId: inserted.rows[0].id };
  } catch (err) {
    if (pgCode(err) === PG_EXCLUSION_VIOLATION) {
      throw new ApiError(409, 'NO_AVAILABILITY', 'No vehicle is available for that period.');
    }
    throw err;
  }
}

// operatorId is equal by construction (it is part of the lookup key).
function isSamePayload(row: ExistingRow, i: ReservationInput): boolean {
  return (
    row.vehicle_group === i.vehicleGroup &&
    row.pickup_location === i.pickupLocation &&
    row.dropoff_location === i.dropoffLocation &&
    row.pickup_at.getTime() === i.pickupAt.getTime() &&
    row.dropoff_at.getTime() === i.dropoffAt.getTime() &&
    row.customer_name === i.customer.name &&
    row.customer_email === i.customer.email
  );
}
