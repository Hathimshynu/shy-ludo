import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/** Public, indexable routes. Private game/room routes are excluded and disallowed. */
const PUBLIC_ROUTES = ['/', '/play', '/how-to-play', '/leaderboard', '/solo', '/login', '/register'];
const PRIVATE_PREFIXES = ['/game/', '/room/', '/solo/game', '/profile', '/settings', '/api/'];

function seoFiles(siteUrl: string): Plugin {
  const base = siteUrl.replace(/\/$/, '');
  return {
    name: 'ludo-seo-files',
    apply: 'build',
    generateBundle() {
      const today = new Date().toISOString().slice(0, 10);
      const urls = PUBLIC_ROUTES.map(
        (r) => `  <url><loc>${base}${r}</loc><lastmod>${today}</lastmod><changefreq>weekly</changefreq></url>`,
      ).join('\n');
      this.emitFile({
        type: 'asset',
        fileName: 'sitemap.xml',
        source: `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`,
      });
      this.emitFile({
        type: 'asset',
        fileName: 'robots.txt',
        source: `User-agent: *\nAllow: /\n${PRIVATE_PREFIXES.map((p) => `Disallow: ${p}`).join('\n')}\n\nSitemap: ${base}/sitemap.xml\n`,
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  // .env lives at the repository root; only VITE_* variables reach the browser bundle.
  const env = loadEnv(mode, '../../', 'VITE_');
  const target = env.VITE_DEV_API_TARGET || 'http://localhost:4000';
  return {
    envDir: '../../',
    plugins: [react(), seoFiles(env.VITE_SITE_URL || 'http://localhost:5173')],
    server: {
      port: 5173,
      proxy: {
        '/api': { target, changeOrigin: true },
        '/socket.io': { target, ws: true, changeOrigin: true },
      },
    },
    preview: { port: 4173 },
    worker: { format: 'es' },
    build: {
      target: 'es2022',
      sourcemap: false,
      chunkSizeWarningLimit: 1400,
    },
  };
});
