import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';

export const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/reservations';

const dbDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../db');

/** DESTRUCTIVE: drops everything in the public schema, then applies schema.sql + seed.sql. */
export async function resetDatabase(pool: Pool): Promise<void> {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await pool.query(readFileSync(path.join(dbDir, 'schema.sql'), 'utf8'));
  await pool.query(readFileSync(path.join(dbDir, 'seed.sql'), 'utf8'));
}
