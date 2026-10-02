#!/usr/bin/env node
/**
 * Renders the original Ludo Nova app icons from an SVG master (no third-party art).
 *
 *   node scripts/generate-icons.mjs
 *
 * Output: apps/web/public/icons/
 *   icon-192.png, icon-512.png         purpose "any"   (rounded tile, transparent corners)
 *   maskable-192.png, maskable-512.png purpose "maskable" (full bleed, logo inside the 80% safe zone)
 *   apple-touch-icon.png               180×180, opaque (iOS applies its own mask)
 *   favicon-32.png
 * Requires Playwright's Chromium (`npx playwright install chromium`).
 */
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('@playwright/test');
const OUT = resolve(process.cwd(), 'apps/web/public/icons');
mkdirSync(OUT, { recursive: true });

/** The nova emblem: four player-coloured points around a glowing core, inside an orbit. */
function emblem(scale) {
  return `
  <g transform="translate(256 256) scale(${scale}) translate(-256 -256)">
    <circle cx="256" cy="256" r="196" fill="none" stroke="url(#orbit)" stroke-width="10" opacity="0.9"/>
    <path d="M256 40 L294 214 L256 256 L218 214 Z" fill="url(#g-green)"/>
    <path d="M472 256 L298 294 L256 256 L298 218 Z" fill="url(#g-yellow)"/>
    <path d="M256 472 L218 298 L256 256 L294 298 Z" fill="url(#g-red)"/>
    <path d="M40 256 L214 218 L256 256 L214 294 Z" fill="url(#g-blue)"/>
    <circle cx="256" cy="256" r="74" fill="url(#core)"/>
    <circle cx="256" cy="256" r="30" fill="#fffaf0"/>
    <circle cx="398" cy="124" r="12" fill="#fff" opacity="0.85"/>
  </g>`;
}

function svg({ size, rounded, emblemScale }) {
  const tile = rounded
    ? '<rect x="16" y="16" width="480" height="480" rx="112" fill="url(#bg)"/>'
    : '<rect width="512" height="512" fill="url(#bg)"/>';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512">
  <defs>
    <radialGradient id="bg" cx="50%" cy="38%" r="75%">
      <stop offset="0" stop-color="#3a2a8f"/>
      <stop offset="0.55" stop-color="#1a1150"/>
      <stop offset="1" stop-color="#0b0820"/>
    </radialGradient>
    <radialGradient id="core" cx="50%" cy="50%" r="50%">
      <stop offset="0" stop-color="#fff7d6"/>
      <stop offset="0.45" stop-color="#ffc94d"/>
      <stop offset="1" stop-color="#ff7a3d" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="orbit" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#ff5fc8"/>
      <stop offset="0.5" stop-color="#a66bff"/>
      <stop offset="1" stop-color="#2fe0e8"/>
    </linearGradient>
    <linearGradient id="g-green" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7dffc6"/><stop offset="1" stop-color="#1fbf7f"/></linearGradient>
    <linearGradient id="g-yellow" x1="1" y1="0" x2="0" y2="0"><stop offset="0" stop-color="#ffe680"/><stop offset="1" stop-color="#f2b500"/></linearGradient>
    <linearGradient id="g-red" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#ff8090"/><stop offset="1" stop-color="#e2283c"/></linearGradient>
    <linearGradient id="g-blue" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#7fb4ff"/><stop offset="1" stop-color="#1f62e0"/></linearGradient>
  </defs>
  ${tile}
  ${emblem(emblemScale)}
</svg>`;
}

const targets = [
  { file: 'icon-192.png', size: 192, rounded: true, emblemScale: 0.8, transparent: true },
  { file: 'icon-512.png', size: 512, rounded: true, emblemScale: 0.8, transparent: true },
  // Maskable: keep the emblem inside the central 80% circle so any mask shape is safe.
  { file: 'maskable-192.png', size: 192, rounded: false, emblemScale: 0.62, transparent: false },
  { file: 'maskable-512.png', size: 512, rounded: false, emblemScale: 0.62, transparent: false },
  { file: 'apple-touch-icon.png', size: 180, rounded: false, emblemScale: 0.72, transparent: false },
  { file: 'favicon-32.png', size: 32, rounded: true, emblemScale: 0.9, transparent: true },
];

const browser = await chromium.launch();
for (const t of targets) {
  const page = await browser.newPage({ viewport: { width: t.size, height: t.size } });
  await page.setContent(
    `<html><body style="margin:0;background:${t.transparent ? 'transparent' : '#0b0820'}">${svg(t)}</body></html>`,
  );
  await page.screenshot({ path: resolve(OUT, t.file), omitBackground: t.transparent });
  await page.close();
  console.log('wrote', t.file);
}
await browser.close();
