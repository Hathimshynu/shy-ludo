import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

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

/**
 * Installable PWA. The service worker only precaches the versioned static build
 * (JS, CSS, fonts, icons, the solo-game worker) so the app shell and solo mode load
 * offline. It never caches /api, Socket.IO or any authenticated response: there is
 * no runtime caching at all, so those requests always go to the network.
 */
const pwa = VitePWA({
  registerType: 'prompt', // a new version waits for the player's OK (never mid-game)
  injectRegister: false, // registered from src/services/pwa.ts
  filename: 'sw.js',
  includeAssets: ['favicon.svg', 'icons/favicon-32.png', 'icons/apple-touch-icon.png'],
  manifest: {
    id: '/',
    name: 'Ludo Nova',
    short_name: 'Ludo Nova',
    description: '3D multiplayer Ludo for 2–8 players — online, with friends, or against AI.',
    lang: 'en',
    start_url: '/play?source=pwa',
    scope: '/',
    display: 'standalone',
    display_override: ['standalone', 'minimal-ui'],
    orientation: 'any',
    theme_color: '#0b0820',
    background_color: '#0b0820',
    categories: ['games', 'entertainment'],
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    shortcuts: [
      { name: 'Play vs AI', short_name: 'Solo', url: '/solo?source=pwa', icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }] },
      { name: 'Play Online', short_name: 'Online', url: '/online?source=pwa', icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }] },
      { name: 'Join Room', short_name: 'Join', url: '/friends?join=1&source=pwa', icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }] },
    ],
  },
  workbox: {
    globPatterns: ['**/*.{js,css,html,svg,png,woff2,webmanifest}'],
    // The social-preview image is not needed offline.
    globIgnores: ['og-image.png', 'robots.txt', 'sitemap.xml', '**/*cyrillic*', '**/*greek*', '**/*vietnamese*'],
    // The lazily loaded 3D chunk is ~0.9 MB; precache it so solo games work offline.
    maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
    navigateFallback: '/index.html',
    navigateFallbackDenylist: [/^\/api\//, /^\/socket\.io\//, /^\/health/, /^\/sw\.js$/, /^\/manifest\.webmanifest$/],
    cleanupOutdatedCaches: true,
    clientsClaim: false,
    skipWaiting: false,
    runtimeCaching: [],
  },
  devOptions: { enabled: false },
});

export default defineConfig(({ mode }) => {
  // .env lives at the repository root; only VITE_* variables reach the browser bundle.
  const env = loadEnv(mode, '../../', 'VITE_');
  const target = env.VITE_DEV_API_TARGET || 'http://localhost:4000';
  return {
    envDir: '../../',
    plugins: [react(), seoFiles(env.VITE_SITE_URL || 'http://localhost:5173'), pwa],
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
