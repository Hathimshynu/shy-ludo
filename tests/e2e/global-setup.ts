import { type ChildProcess, execSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';

export const API_PORT = Number(process.env.E2E_API_PORT ?? 4100);
export const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 5199);
const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');

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

async function waitFor(url: string, timeoutMs = 90_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${url}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

function kill(child: ChildProcess | null): void {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    try {
      execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' });
    } catch {
      /* already gone */
    }
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
  }
}

/**
 * Boots a throw-away PostgreSQL, the real API server and the Vite dev server.
 * Set E2E_EXTERNAL=1 to test against servers you started yourself.
 */
export default async function globalSetup() {
  if (process.env.E2E_EXTERNAL) return async () => undefined;

  let pg: EmbeddedPostgres | null = null;
  let dir: string | null = null;
  let databaseUrl = process.env.E2E_DATABASE_URL;
  if (!databaseUrl) {
    const port = await freePort();
    dir = mkdtempSync(join(tmpdir(), 'ludo-e2e-pg-'));
    pg = new EmbeddedPostgres({ databaseDir: dir, user: 'ludo', password: 'ludo', port, persistent: false, onLog: () => {} });
    await pg.initialise();
    await pg.start();
    await pg.createDatabase('ludo_e2e');
    databaseUrl = `postgresql://ludo:ludo@localhost:${port}/ludo_e2e`;
  }
  execSync('npx prisma migrate deploy --schema prisma/schema.prisma', {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'ignore',
  });

  const detached = process.platform !== 'win32';
  const api = spawn('npx', ['tsx', 'apps/server/src/index.ts'], {
    cwd: ROOT,
    shell: true,
    detached,
    stdio: process.env.E2E_DEBUG ? 'inherit' : 'ignore',
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(API_PORT),
      HOST: '127.0.0.1',
      DATABASE_URL: databaseUrl,
      REDIS_URL: '',
      JWT_SECRET: 'e2e-access-secret-0123456789-0123456789',
      JWT_REFRESH_SECRET: 'e2e-refresh-secret-0123456789-0123456789',
      CLIENT_URL: `http://localhost:${WEB_PORT}`,
      BOT_DELAY_MS: '250',
      RATE_LIMIT_DISABLED: 'true',
      DISCONNECT_GRACE_SECONDS: '120',
      LOG_LEVEL: 'warn',
    },
  });
  const webEnv = {
    ...process.env,
    VITE_DEV_API_TARGET: `http://127.0.0.1:${API_PORT}`,
    VITE_E2E: 'true',
    VITE_SITE_URL: `http://localhost:${WEB_PORT}`,
  };
  // A production build (with the read-only E2E hook compiled in) loads much faster than the dev server.
  execSync('npx vite build --outDir dist-e2e --emptyOutDir', { cwd: join(ROOT, 'apps/web'), env: webEnv, stdio: 'ignore' });
  const web = spawn('npx', ['vite', 'preview', '--outDir', 'dist-e2e', '--port', String(WEB_PORT), '--strictPort'], {
    cwd: join(ROOT, 'apps/web'),
    shell: true,
    detached,
    stdio: process.env.E2E_DEBUG ? 'inherit' : 'ignore',
    env: webEnv,
  });

  await waitFor(`http://127.0.0.1:${API_PORT}/health`);
  await waitFor(`http://localhost:${WEB_PORT}/`);

  return async () => {
    kill(web);
    kill(api);
    if (pg) await pg.stop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  };
}
