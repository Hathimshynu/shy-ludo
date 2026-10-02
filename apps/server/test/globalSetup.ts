import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    pgAdminUrl: string;
    pgTemplate: string;
  }
}

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.listen(0, () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => res(port));
    });
    srv.on('error', rej);
  });
}

/**
 * Starts a throw-away PostgreSQL, creates a migrated template database, and lets each
 * test file clone it (CREATE DATABASE … TEMPLATE) for full isolation.
 * Set TEST_DATABASE_ADMIN_URL to use an existing server instead (e.g. in CI).
 */
export default async function setup(project: TestProject) {
  const template = 'ludo_template';
  let adminBase = process.env.TEST_DATABASE_ADMIN_URL;
  let pg: EmbeddedPostgres | null = null;
  let dir: string | null = null;

  if (!adminBase) {
    const port = await freePort();
    dir = mkdtempSync(join(tmpdir(), 'ludo-pg-'));
    pg = new EmbeddedPostgres({ databaseDir: dir, user: 'ludo', password: 'ludo', port, persistent: false, onLog: () => {} });
    await pg.initialise();
    await pg.start();
    adminBase = `postgresql://ludo:ludo@localhost:${port}`;
  }

  const admin = new URL(adminBase);
  admin.pathname = '/postgres';
  const templateUrl = new URL(adminBase);
  templateUrl.pathname = `/${template}`;

  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient({ datasources: { db: { url: admin.toString() } } });
  await prisma.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${template}`);
  await prisma.$executeRawUnsafe(`CREATE DATABASE ${template}`);
  await prisma.$disconnect();

  const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');
  execSync('npx prisma migrate deploy --schema prisma/schema.prisma', {
    cwd: root,
    env: { ...process.env, DATABASE_URL: templateUrl.toString() },
    stdio: 'pipe',
  });

  project.provide('pgAdminUrl', admin.toString());
  project.provide('pgTemplate', template);

  return async () => {
    if (pg) await pg.stop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  };
}
