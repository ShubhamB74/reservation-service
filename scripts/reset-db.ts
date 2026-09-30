import { Pool } from 'pg';
import { DATABASE_URL, resetDatabase } from '../src/db';

const pool = new Pool({ connectionString: DATABASE_URL });
await resetDatabase(pool);
await pool.end();
console.log('Database reset: schema + seed applied.');
