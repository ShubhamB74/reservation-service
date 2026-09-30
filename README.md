# Reservation endpoint

`POST /reservations` — Node.js + TypeScript (Fastify, `pg`) + PostgreSQL.

## Setup, run, test

Requires Node 20+ and Docker (or any PostgreSQL 13+ you can reach).

```bash
docker compose up -d          # PostgreSQL 16 on localhost:5432
npm install
npm run db:reset              # applies db/schema.sql + db/seed.sql
npm start                     
npm test                      
npm run typecheck
```

`DATABASE_URL` overrides the default `postgres://postgres:postgres@localhost:5432/reservations`.
Use a throwaway database: both `db:reset` and the tests wipe the `public` schema.

```bash
curl -i -X POST localhost:3000/reservations \
  -H 'Authorization: Bearer test-token-a' -H 'Content-Type: application/json' \
  -d '{"externalBookingId":"BROKER-1001","operatorId":"operator-a","vehicleGroup":"economy",
       "pickupLocation":"airport","dropoffLocation":"airport",
       "pickupAt":"2030-06-10T10:00:00Z","dropoffAt":"2030-06-12T10:00:00Z",
       "customer":{"name":"Alex Example","email":"alex@example.com"}}'
```

## Design

Correctness lives in the database, not in application checks. `reservations` has
(1) `UNIQUE (operator_id, external_booking_id)` — the durable idempotency key, and
(2) `EXCLUDE USING gist (pool_id WITH =, tstzrange(pickup_at, dropoff_at, '[)') WITH &&)` —
no two reservations on one pool can overlap; `[)` makes back-to-back rentals legal.
Each seeded pool has exactly one vehicle, so "pool" == "vehicle". Each request runs in one
transaction (`src/reservations.ts`): validate inventory → take a per-key advisory lock →
look up the key → compare payload (replay / conflict) → otherwise INSERT.
The operator always comes from the token; the body's `operatorId` is only checked against it.

## Required explanations

**Where competing requests wait / conflict / retry**

- *Same `(operator, externalBookingId)`* (`runInTransaction`, step 2): `pg_advisory_xact_lock(hashtextextended(key))`
  makes the second request block until the first commits or rolls back. It then sees the committed row
  in step 3 and answers 200 (identical) or `IDEMPOTENCY_CONFLICT` (different). This is what makes
  "economy vs compact with the same ID" resolve deterministically even though the two requests touch
  different pools. The lock is released automatically at COMMIT/ROLLBACK. A hash collision between two
  different keys only causes harmless extra waiting.
- *Different keys, same pool, overlapping period* (step 4): the `reservations_no_overlap` exclusion
  constraint. The second INSERT blocks on the first's uncommitted row; if the first commits, PostgreSQL
  raises `23P01`, which is mapped to `NO_AVAILABILITY`; if the first rolls back, the second proceeds.
- *Backstop*: the unique constraint on `(operator_id, external_booking_id)` is the last line of defence.
  If a unique violation (`23505`) ever occurs, `createReservation` retries the whole transaction once,
  and the second run takes the replay/conflict path. With the advisory lock in place this should not
  normally trigger.
- There is no "SELECT to check availability, then INSERT" anywhere.

**DB commits but the broker never receives the response**
The row is durable. The broker retries with the same `(operator, externalBookingId)` and identical
payload, hits step 3, and gets `200` with the original `reservationId`, even though the vehicle is now
occupied by that very reservation (the key lookup happens before any availability logic).

**Process stops before commit**
PostgreSQL aborts the open transaction when the connection drops: no row is persisted and the advisory
lock is released. The booking key is not reserved, so a retry is treated as a brand-new request. The same
holds for any rejected request (validation, `NO_AVAILABILITY`, `IDEMPOTENCY_CONFLICT`): everything is
rolled back. If the crash happens *during* `COMMIT`, the client cannot know the outcome; the retry path
above resolves it.

**One plausible implementation mistake, and how I checked for it**
*Mistake:* enforcing availability in application code (`SELECT` overlapping rows, then `INSERT` if none)
instead of in the database. Two concurrent requests both see "free" and both insert, overselling the vehicle.

mutation test: I deleted the `reservations_no_overlap` exclusion constraint from `db/schema.sql`
and re-ran the suite. 7 of 40 tests failed (33 passed). In the 12-way race test
("different ids competing for one pool"), all 12 requests returned 201 instead of one 201 and eleven 409s.
I restored the constraint and the suite went back to 40/40. So the race test can actually detect an oversell,
and the constraint is what prevents it.

**Other mutation checks I ran** (each reverted afterwards; suite back to 40/40)
| Mutation | Result |
|---|---|
| `'[)'` → `'[]'` in the exclusion constraint | 2 failures: both back-to-back tests got 409 instead of 201 |
| Removed `customer_email` from the payload comparison | "changed customer email" got 200 instead of 409 |
| Unique key without `operator_id` | Tenant-isolation test failed (500) |
| Made the timezone group of the timestamp regex optional | "timestamp without timezone" test failed (500 instead of 400; the mutation crashed the parser rather than accepting the value) |
| Removed only the advisory lock | **No test failed.** The unique constraint plus the one-shot retry still yields one reservation and the right 200/409 |
| Removed the advisory lock and the retry | Concurrency tests failed with 500 instead of 409 |


## What is tested (real PostgreSQL, `test/reservations.test.ts`, 40 tests)

Assertions check HTTP status/body **and** persisted rows.

- New booking; identical replay (incl. property order and the same instant in a different UTC offset)
- Changed payload for an existing key (email, name exactness, group, instant, overlapping own dates) → conflict, row unchanged
- Changed-payload conflict beats availability; a rejected request leaves its key reusable
- Overlap boundaries: back-to-back on both sides OK; partial start/end, containment, containing, identical → `NO_AVAILABILITY`
- Concurrency: 12 different IDs on one pool; 8 identical requests; economy-vs-compact with one ID (15 rounds)
- Tenant isolation: same ID/dates for A and B; B's replay never returns A's row; 403 mismatch; B cannot book A's `compact`
- 401 (missing/unknown token, wins over malformed JSON), 400 for malformed JSON and a table of invalid inputs

**Not verified / limitations of the tests**
- "Separate processes" is simulated with two Fastify apps, each with its own `pg` pool (separate connections,
  same database). It is not a true multi-process run.
- The unexpected-infrastructure-failure path (5xx) is not tested (for example, killing the DB mid-request).
- No test kills a connection mid-transaction or between COMMIT and the HTTP response.
- Sub-millisecond timestamp precision is truncated to ms before comparison and storage.
- Passing concurrency tests show no failures in the runs I made; they are not a proof. The design argument above is the guarantee.

## Submission notes

- **Time spent:** Around 80 minutes including tests and documentation. Verification gap: concurrency is tested with two app instances and separate connection pools against one PostgreSQL, not with separate OS processes.
- **AI tools used:** Claude generated the initial scaffold. I reviewed, ran and verified them.
- **Concrete verification/correction:** The generated concurrency test expected the sorted status codes in the wrong order (`409`s before `201`; the sort is ascending). The failure output showed the service had actually returned one 201 and eleven 409s, so I corrected the assertion, not the service. I also ran a mutation check by removing the exclusion constraint (see above) to confirm the race test fails without it.

## Known limitations

- Capacity is fixed at one per pool. The exclusion constraint cannot express capacity N; that needs per-vehicle
  rows (one exclusion constraint per vehicle) with an allocation step, or a locked counter/slot table.
- Auth is a hardcoded token map; no lock/statement timeouts; no rate limiting; no structured request IDs.
- Fastify error handling maps all framework 4xx errors to `INVALID_REQUEST`.
- `vehicle_group` and `operator_id` on `reservations` are copied from the request rather than enforced against the pool by a foreign key.

## Top 3 production improvements

1. `SET LOCAL lock_timeout` / `statement_timeout`, with timeouts mapped to a retryable 503, so lock waits cannot pin pool connections.
2. A composite FK `(pool_id, operator_id, vehicle_group)` → `vehicle_pools`, a stored payload hash (or canonical column set) for idempotency comparison, and retention/expiry rules for keys.
3. A real multi-process test harness with fault injection (kill the connection before/after COMMIT), metrics on 409 rates, and a proper auth/tenant layer.
