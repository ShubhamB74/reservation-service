import { ApiError } from './errors';

export interface ReservationInput {
  externalBookingId: string;
  operatorId: string;
  vehicleGroup: string;
  pickupLocation: string;
  dropoffLocation: string;
  pickupAt: Date;
  dropoffAt: Date;
  customer: { name: string; email: string };
}

const bad = (message: string) => new ApiError(400, 'INVALID_REQUEST', message);

const MAX_LEN = 255;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Explicit timezone (Z or +hh:mm / -hh:mm) is mandatory.
const ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;

function nonBlank(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw bad(`${field} must be a non-blank string.`);
  if (value.length > MAX_LEN) throw bad(`${field} is too long.`);
  return value; // stored and compared exactly as received
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function parseInstant(value: unknown, field: string): Date {
  if (typeof value !== 'string') throw bad(`${field} must be a string.`);
  const m = ISO.exec(value);
  if (!m) throw bad(`${field} must be an ISO-8601 timestamp with an explicit timezone.`);
  const [, y, mo, d, h, mi, s, frac, tz] = m;
  const Y = +y, M = +mo, D = +d, H = +h, MI = +mi, S = +s;
  if (Y < 1900 || M < 1 || M > 12 || D < 1 || D > daysInMonth(Y, M) || H > 23 || MI > 59 || S > 59) {
    throw bad(`${field} is not a valid date/time.`);
  }
  let offsetMinutes = 0;
  if (tz !== 'Z') {
    const sign = tz[0] === '-' ? -1 : 1;
    const oh = +tz.slice(1, 3), om = +tz.slice(4, 6);
    if (oh > 23 || om > 59) throw bad(`${field} has an invalid timezone offset.`);
    offsetMinutes = sign * (oh * 60 + om);
  }
  // Truncate fractional seconds to milliseconds (no float maths).
  const ms = frac ? Number(frac.padEnd(3, '0').slice(0, 3)) : 0;
  return new Date(Date.UTC(Y, M - 1, D, H, MI, S, ms) - offsetMinutes * 60_000);
}

export function parseReservation(body: unknown): ReservationInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw bad('Request body must be a JSON object.');
  }
  const b = body as Record<string, unknown>;

  const c = b.customer;
  if (typeof c !== 'object' || c === null || Array.isArray(c)) throw bad('customer must be an object.');
  const cust = c as Record<string, unknown>;
  const customer = {
    name: nonBlank(cust.name, 'customer.name'),
    email: nonBlank(cust.email, 'customer.email'),
  };
  if (!EMAIL.test(customer.email)) throw bad('customer.email is not a valid email address.');

  const input: ReservationInput = {
    externalBookingId: nonBlank(b.externalBookingId, 'externalBookingId'),
    operatorId: nonBlank(b.operatorId, 'operatorId'),
    vehicleGroup: nonBlank(b.vehicleGroup, 'vehicleGroup'),
    pickupLocation: nonBlank(b.pickupLocation, 'pickupLocation'),
    dropoffLocation: nonBlank(b.dropoffLocation, 'dropoffLocation'),
    pickupAt: parseInstant(b.pickupAt, 'pickupAt'),
    dropoffAt: parseInstant(b.dropoffAt, 'dropoffAt'),
    customer,
  };

  if (input.pickupLocation !== 'airport' || input.dropoffLocation !== 'airport') {
    throw bad('Only airport pickup and dropoff are supported.');
  }
  if (input.pickupAt.getTime() >= input.dropoffAt.getTime()) {
    throw bad('pickupAt must be before dropoffAt.');
  }
  return input;
}
