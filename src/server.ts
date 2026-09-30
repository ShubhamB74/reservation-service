import { Pool } from 'pg';
import { buildApp } from './app';
import { DATABASE_URL } from './db';

const pool = new Pool({ connectionString: DATABASE_URL });
pool.on('error', (err) => console.error('idle pg client error', err.message));

const app = buildApp(pool, { logger: true });

const shutdown = async () => {
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: Number(process.env.PORT ?? 3000), host: '0.0.0.0' });
