/** Shared limits used by both client-side forms and server-side validation. */
export const LIMITS = {
  minPlayers: 2,
  maxPlayers: 8,
  roomCodeLength: 6,
  /** Unambiguous alphabet for room codes (no 0/O, 1/I/L). */
  roomCodeAlphabet: 'ABCDEFGHJKMNPQRSTUVWXYZ23456789',
  usernameMin: 3,
  usernameMax: 20,
  displayNameMax: 24,
  passwordMin: 8,
  passwordMax: 128,
  turnTimeOptions: [15, 30, 45, 60] as const,
  matchmakingSizes: [2, 4, 6, 8] as const,
  emotes: ['wave', 'laugh', 'wow', 'angry', 'gg', 'thumbs', 'fire', 'cry'] as const,
  avatars: [
    'comet',
    'nebula',
    'orbit',
    'pulsar',
    'quasar',
    'rocket',
    'saturn',
    'star',
    'meteor',
    'galaxy',
    'aurora',
    'eclipse',
  ] as const,
} as const;

export type Emote = (typeof LIMITS.emotes)[number];
export type AvatarId = (typeof LIMITS.avatars)[number];
export type MatchmakingSize = (typeof LIMITS.matchmakingSizes)[number];
