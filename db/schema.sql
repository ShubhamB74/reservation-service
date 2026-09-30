-- Needed so an exclusion constraint can combine integer equality with range overlap.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- One row per bookable pool. Each pool holds exactly one vehicle, so a pool
-- can be rented by at most one reservation at any instant.
CREATE TABLE vehicle_pools (
  id            integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  operator_id   text NOT NULL,
  vehicle_group text NOT NULL,
  location      text NOT NULL,
  UNIQUE (operator_id, vehicle_group, location)
);

CREATE TABLE reservations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id         text        NOT NULL,
  external_booking_id text        NOT NULL,
  pool_id             integer     NOT NULL REFERENCES vehicle_pools(id),
  vehicle_group       text        NOT NULL,
  pickup_location     text        NOT NULL,
  dropoff_location    text        NOT NULL,
  pickup_at           timestamptz NOT NULL,
  dropoff_at          timestamptz NOT NULL,
  customer_name       text        NOT NULL,
  customer_email      text        NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),

  CHECK (pickup_at < dropoff_at),

  -- Durable booking identity: the idempotency key.
  CONSTRAINT reservations_booking_key UNIQUE (operator_id, external_booking_id),

  -- No overlapping periods on one pool. '[)' => back-to-back rentals are allowed.
  CONSTRAINT reservations_no_overlap
    EXCLUDE USING gist (
      pool_id WITH =,
      tstzrange(pickup_at, dropoff_at, '[)') WITH &&
    )
);
