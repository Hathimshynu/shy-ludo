import type { CSSProperties } from 'react';

/** Original vector avatars — one cosmic glyph per id. */
const GLYPHS: Record<string, { bg: [string, string]; path: string }> = {
  comet: { bg: ['#ff8a3d', '#ff4d5e'], path: 'M30 34a8 8 0 1 1-16 0 8 8 0 0 1 16 0Zm-2-6 16-14M24 24l14-16M30 30l16-6' },
  nebula: { bg: ['#a66bff', '#ff5fc8'], path: 'M14 32c4-10 18-14 24-6s-2 18-12 16-10-14 0-14 8 8 2 10' },
  orbit: { bg: ['#3d8bff', '#2fe0e8'], path: 'M32 32m-6 0a6 6 0 1 0 12 0a6 6 0 1 0-12 0M12 40c8-14 32-28 40-24s-20 26-36 28' },
  pulsar: { bg: ['#2fe0e8', '#2ee59d'], path: 'M32 32m-5 0a5 5 0 1 0 10 0a5 5 0 1 0-10 0M32 10v10M32 44v10M10 32h10M44 32h10' },
  quasar: { bg: ['#ffd23f', '#ff8a3d'], path: 'M32 12l5 15 15 5-15 5-5 15-5-15-15-5 15-5z' },
  rocket: { bg: ['#ff5fc8', '#a66bff'], path: 'M32 10c8 6 10 16 8 26H24c-2-10 0-20 8-26Zm-8 26-6 8h8m14-8 6 8h-8M32 22a3 3 0 1 0 0 6 3 3 0 0 0 0-6M28 44l4 8 4-8' },
  saturn: { bg: ['#ffc94d', '#ff6fb5'], path: 'M32 32m-9 0a9 9 0 1 0 18 0a9 9 0 1 0-18 0M10 38c6 4 38-6 44-14' },
  star: { bg: ['#ffd23f', '#2ee59d'], path: 'M32 12l6 13 14 2-10 10 2 14-12-7-12 7 2-14-10-10 14-2z' },
  meteor: { bg: ['#ff4d5e', '#a66bff'], path: 'M40 40a7 7 0 1 1-14 0 7 7 0 0 1 14 0ZM28 32 12 16M34 28 22 12M36 34 26 20' },
  galaxy: { bg: ['#7c84ff', '#2fe0e8'], path: 'M32 32c0-6 8-8 12-4s2 14-8 16-16-6-14-16 14-14 22-10' },
  aurora: { bg: ['#2ee59d', '#3d8bff'], path: 'M10 44c8-16 14-22 22-10s14 6 22-10M10 36c8-12 14-16 22-6s14 4 22-8' },
  eclipse: { bg: ['#1b1442', '#a66bff'], path: 'M32 32m-12 0a12 12 0 1 0 24 0a12 12 0 1 0-24 0M36 26a9 9 0 1 1-8 14' },
};

interface AvatarProps {
  id: string;
  size?: number;
  ring?: string;
  className?: string;
  label?: string;
  style?: CSSProperties;
}

export function Avatar({ id, size = 44, ring, className, label, style }: AvatarProps) {
  const g = GLYPHS[id] ?? GLYPHS.comet!;
  const gid = `av-${id}`;
  return (
    <span
      className={`avatar ${className ?? ''}`}
      style={{ width: size, height: size, boxShadow: ring ? `0 0 0 3px ${ring}, 0 0 18px ${ring}66` : undefined, ...style }}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <svg viewBox="0 0 64 64" width={size} height={size}>
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor={g.bg[0]} />
            <stop offset="1" stopColor={g.bg[1]} />
          </linearGradient>
        </defs>
        <circle cx="32" cy="32" r="32" fill={`url(#${gid})`} />
        <circle cx="32" cy="32" r="30" fill="none" stroke="rgba(255,255,255,0.25)" strokeWidth="2" />
        <path d={g.path} fill="none" stroke="#fff" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

export const AVATAR_IDS = Object.keys(GLYPHS);
