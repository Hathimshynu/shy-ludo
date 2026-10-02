/**
 * Brand identity. Everything user-facing that names the product reads from here,
 * so the game can be rebranded by editing this single file (plus the favicon/OG image).
 */
export const BRAND = {
  name: 'Ludo Nova',
  shortName: 'Nova',
  tagline: 'Play. Roll. Conquer.',
  heroLines: ['PLAY.', 'ROLL.', 'CONQUER.'],
  description:
    'Ludo Nova is a free 3D Ludo game for 2–8 players. Play online with friends, join quick matches, or take on smart AI opponents — right in your browser.',
  keywords: ['ludo', 'online ludo', '3d ludo', 'multiplayer board game', 'play with friends'],
  themeColor: '#0b0820',
  accentColor: '#ffc94d',
} as const;

export type Brand = typeof BRAND;
