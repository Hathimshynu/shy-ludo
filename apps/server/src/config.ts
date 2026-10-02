import { z } from 'zod';

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    HOST: z.string().default('0.0.0.0'),
    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
    REDIS_URL: z.string().optional(),
    JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
    JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
    /** Comma-separated list of allowed browser origins. */
    CLIENT_URL: z.string().default('http://localhost:5173'),
    ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(900),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
    /** `none` is required when the web app calls the API cross-site without a proxy. */
    COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).optional(),
    COOKIE_DOMAIN: z.string().optional(),
    TRUST_PROXY: z.coerce.number().int().min(0).max(10).default(1),
    DISCONNECT_GRACE_SECONDS: z.coerce.number().int().min(5).max(3600).default(120),
    LOBBY_DISCONNECT_SECONDS: z.coerce.number().int().min(5).max(3600).default(60),
    BOT_DELAY_MS: z.coerce.number().int().min(0).max(10_000).default(900),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    /** Test-only deterministic dice seed. Refused in production. */
    DICE_SEED: z.coerce.number().int().optional(),
    /** Test-only override of the turn timer (seconds). Refused in production. */
    TEST_TURN_SECONDS: z.coerce.number().int().min(1).optional(),
    RATE_LIMIT_DISABLED: bool.default(false),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production') {
      if (env.DICE_SEED !== undefined) {
        ctx.addIssue({ code: 'custom', path: ['DICE_SEED'], message: 'DICE_SEED is not allowed in production' });
      }
      if (env.TEST_TURN_SECONDS !== undefined) {
        ctx.addIssue({ code: 'custom', path: ['TEST_TURN_SECONDS'], message: 'Not allowed in production' });
      }
      if (env.RATE_LIMIT_DISABLED) {
        ctx.addIssue({ code: 'custom', path: ['RATE_LIMIT_DISABLED'], message: 'Not allowed in production' });
      }
      if (env.JWT_SECRET === env.JWT_REFRESH_SECRET) {
        ctx.addIssue({ code: 'custom', path: ['JWT_REFRESH_SECRET'], message: 'Must differ from JWT_SECRET' });
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

export interface AppConfig extends Env {
  isProduction: boolean;
  allowedOrigins: string[];
  cookieSameSite: 'lax' | 'strict' | 'none';
  cookieSecure: boolean;
}

export function loadConfig(source: Record<string, string | undefined> = process.env): AppConfig {
  // Treat empty variables (e.g. `REDIS_URL=` in a dashboard) as unset.
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v.trim() !== ''));
  const parsed = envSchema.safeParse(cleaned);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid server configuration:\n${details}`);
  }
  const env = parsed.data;
  const isProduction = env.NODE_ENV === 'production';
  const allowedOrigins = env.CLIENT_URL.split(',')
    .map((o) => o.trim().replace(/\/$/, ''))
    .filter(Boolean);
  const cookieSameSite = env.COOKIE_SAMESITE ?? 'lax';
  return {
    ...env,
    isProduction,
    allowedOrigins,
    cookieSameSite,
    // SameSite=None requires Secure; production always uses Secure cookies.
    cookieSecure: isProduction || cookieSameSite === 'none',
  };
}
