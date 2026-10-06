import { z } from 'zod';
import { LIMITS } from '@ludo/config';
import { type AppError, appError } from '@ludo/shared-types';

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export const usernameSchema = z
  .string()
  .trim()
  .min(LIMITS.usernameMin, `Use at least ${LIMITS.usernameMin} characters`)
  .max(LIMITS.usernameMax, `Use at most ${LIMITS.usernameMax} characters`)
  .regex(/^[a-zA-Z0-9_]+$/, 'Letters, numbers and underscores only');

export const displayNameSchema = z
  .string()
  .trim()
  .min(1, 'Required')
  .max(LIMITS.displayNameMax, `Use at most ${LIMITS.displayNameMax} characters`)
  // Printable characters only; rendering is XSS-safe regardless (React escapes text).
  .regex(/^[^\p{C}<>]+$/u, 'Contains unsupported characters');

export const passwordSchema = z
  .string()
  .min(LIMITS.passwordMin, `Use at least ${LIMITS.passwordMin} characters`)
  .max(LIMITS.passwordMax, `Use at most ${LIMITS.passwordMax} characters`);

export const emailSchema = z.string().trim().toLowerCase().email('Enter a valid email').max(254);

export const avatarSchema = z.enum(LIMITS.avatars);

export const idSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);

export const roomCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .length(LIMITS.roomCodeLength, `Room codes have ${LIMITS.roomCodeLength} characters`)
  .refine((code) => [...code].every((c) => LIMITS.roomCodeAlphabet.includes(c)), 'Invalid room code');

export const aiDifficultySchema = z.enum(['easy', 'medium', 'hard', 'expert']);

// ---------------------------------------------------------------------------
// REST bodies
// ---------------------------------------------------------------------------

export const registerSchema = z.object({
  username: usernameSchema,
  email: emailSchema.optional(),
  password: passwordSchema,
  displayName: displayNameSchema.optional(),
});

export const loginSchema = z.object({
  login: z.string().trim().min(1, 'Required').max(254),
  password: z.string().min(1, 'Required').max(LIMITS.passwordMax),
});

export const friendRequestSchema = z.object({
  username: z.string().trim().min(1, 'Enter a username').max(LIMITS.usernameMax + 10),
});

export const guestSchema = z.object({
  displayName: displayNameSchema.optional(),
});

export const profileUpdateSchema = z
  .object({
    displayName: displayNameSchema.optional(),
    avatar: avatarSchema.optional(),
  })
  .refine((v) => v.displayName !== undefined || v.avatar !== undefined, 'Nothing to update');

export const leaderboardQuerySchema = z.object({
  category: z.enum(['wins', 'games', 'captures', 'rating']).default('wins'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

// ---------------------------------------------------------------------------
// Rooms & socket payloads
// ---------------------------------------------------------------------------

export const ruleVariantsSchema = z.object({
  requireSixToStart: z.boolean(),
  extraTurnOnSix: z.boolean(),
  extraTurnOnCapture: z.boolean(),
  extraTurnOnHome: z.boolean(),
  threeSixPenalty: z.boolean(),
  exactHomeEntry: z.boolean(),
  allowBlockades: z.boolean(),
  continueAfterWinner: z.boolean(),
});

export const roomSettingsSchema = z.object({
  maxPlayers: z.number().int().min(LIMITS.minPlayers).max(LIMITS.maxPlayers),
  turnTimeSeconds: z
    .number()
    .int()
    .refine((v) => (LIMITS.turnTimeOptions as readonly number[]).includes(v), 'Unsupported timer'),
  tokensPerPlayer: z.number().int().min(1).max(4),
  variants: ruleVariantsSchema,
});

const empty = z.object({}).strip();

export const actionBaseSchema = z.object({
  gameId: idSchema,
  actionId: z.string().uuid(),
  expectedSeq: z.number().int().min(0),
});

export const socketSchemas = {
  'room:create': z.object({ settings: roomSettingsSchema }),
  'room:join': z.object({ code: roomCodeSchema }),
  'room:leave': empty,
  'room:kick': z.object({ userId: idSchema }),
  'room:settings': z.object({ settings: roomSettingsSchema }),
  'room:addBot': z.object({ difficulty: aiDifficultySchema }),
  'room:removeBot': z.object({ botId: idSchema }),
  'player:ready': z.object({ ready: z.boolean() }),
  'game:start': empty,
  'matchmaking:join': z.object({
    playerCount: z
      .number()
      .int()
      .refine((v) => (LIMITS.matchmakingSizes as readonly number[]).includes(v), 'Unsupported table size'),
  }),
  'matchmaking:leave': empty,
  // Game actions are strict: the client never sends a dice value, player id, position or
  // anything else — a payload carrying extra fields is a forgery and is rejected outright.
  'dice:roll': actionBaseSchema.strict(),
  'token:move': actionBaseSchema.extend({ tokenIndex: z.number().int().min(0).max(3) }).strict(),
  'game:sync': z.object({ gameId: idSchema }),
  'game:leave': z.object({ gameId: idSchema }),
  'game:emote': z.object({ gameId: idSchema, emote: z.enum(LIMITS.emotes) }),
  'time:ping': z.object({ clientTime: z.number().finite() }),
  'friend:invite': z.object({ userId: idSchema }),
} as const;

export type SocketEventName = keyof typeof socketSchemas;
export type SocketPayload<E extends SocketEventName> = z.infer<(typeof socketSchemas)[E]>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export type ParseResult<T> = { ok: true; data: T } | { ok: false; error: AppError & { fields?: Record<string, string> } };

export function parseWith<S extends z.ZodTypeAny>(schema: S, input: unknown): ParseResult<z.infer<S>> {
  const result = schema.safeParse(input ?? {});
  if (result.success) return { ok: true, data: result.data };
  const fields: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const key = issue.path.join('.') || '_';
    if (!fields[key]) fields[key] = issue.message;
  }
  return { ok: false, error: { ...appError('VALIDATION'), fields } };
}

export { z };
