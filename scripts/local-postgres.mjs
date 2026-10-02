#!/usr/bin/env node
/**
 * Starts a local PostgreSQL server without Docker (embedded-postgres binaries).
 * Data persists in ./.local-pg. Stop with Ctrl+C.
 *
 *   npm run db:local
 *   DATABASE_URL=postgresql://ludo:ludo@localhost:5433/ludo
 */
import EmbeddedPostgres from 'embedded-postgres';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const port = Number(process.env.LOCAL_PG_PORT ?? 5433);
const dir = resolve(process.cwd(), '.local-pg');
const fresh = !existsSync(dir);

const pg = new EmbeddedPostgres({
  databaseDir: dir,
  user: 'ludo',
  password: 'ludo',
  port,
  persistent: true,
  onLog: () => {},
});

if (fresh) await pg.initialise();
await pg.start();
try {
  await pg.createDatabase('ludo');
} catch {
  // already exists
}
console.log(`\nLocal PostgreSQL ready.\nDATABASE_URL=postgresql://ludo:ludo@localhost:${port}/ludo\n`);

const stop = async () => {
  await pg.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
setInterval(() => {}, 1 << 30);
