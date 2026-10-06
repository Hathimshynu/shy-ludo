import { Router, type Request, type Response } from 'express';
import type { PrismaClient } from '@prisma/client';
import {
  friendRequestSchema,
  guestSchema,
  leaderboardQuerySchema,
  loginSchema,
  parseWith,
  profileUpdateSchema,
  registerSchema,
  idSchema,
} from '@ludo/validation';
import type { AuthResponse } from '@ludo/shared-types';
import type { AppConfig } from '../config';
import { HttpError } from '../errors';
import type { AuthResult, AuthService } from '../auth/authService';
import { csrfGuard, limiter, optionalAuth, requireAuth, validateBody } from '../middleware/http';
import type { ProfileService } from '../services/profileService';
import type { FriendService } from '../services/friendService';
import type { GameRepository } from '../services/gameRepository';

export const REFRESH_COOKIE = 'ln_rt';

export interface ApiDeps {
  config: AppConfig;
  prisma: PrismaClient;
  auth: AuthService;
  profiles: ProfileService;
  friends: FriendService;
  games: GameRepository;
  healthChecks: Array<() => Promise<void>>;
}

function meta(req: Request) {
  return { ip: req.ip, userAgent: req.header('user-agent') };
}

export function healthRouter(deps: Pick<ApiDeps, 'healthChecks'>): Router {
  const router = Router();
  router.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });
  router.get('/health/ready', async (_req, res) => {
    try {
      await Promise.all(deps.healthChecks.map((check) => check()));
      res.json({ status: 'ok' });
    } catch {
      res.status(503).json({ status: 'unavailable' });
    }
  });
  return router;
}

export function apiRouter(deps: ApiDeps): Router {
  const { config, auth, profiles, friends, games } = deps;
  const router = Router();

  const setRefreshCookie = (res: Response, result: AuthResult) => {
    res.cookie(REFRESH_COOKIE, result.tokens.refreshToken, {
      httpOnly: true,
      secure: config.cookieSecure,
      sameSite: config.cookieSameSite,
      path: '/api/auth',
      expires: result.tokens.refreshExpiresAt,
      ...(config.COOKIE_DOMAIN ? { domain: config.COOKIE_DOMAIN } : {}),
    });
  };
  const clearRefreshCookie = (res: Response) => {
    res.clearCookie(REFRESH_COOKIE, {
      httpOnly: true,
      secure: config.cookieSecure,
      sameSite: config.cookieSameSite,
      path: '/api/auth',
      ...(config.COOKIE_DOMAIN ? { domain: config.COOKIE_DOMAIN } : {}),
    });
  };
  const respond = (res: Response, result: AuthResult, status = 200) => {
    setRefreshCookie(res, result);
    const body: AuthResponse = {
      user: result.user,
      accessToken: result.tokens.accessToken,
      expiresIn: result.tokens.expiresIn,
    };
    res.status(status).json(body);
  };

  // ---- Auth -----------------------------------------------------------------
  router.post(
    '/auth/register',
    limiter(config, 10 * 60_000, 10),
    optionalAuth(config),
    validateBody(registerSchema),
    async (req, res) => {
      respond(res, await auth.register(req.body, req.isGuest ? (req.userId ?? null) : null, meta(req)), 201);
    },
  );

  router.post('/auth/login', limiter(config, 10 * 60_000, 20), validateBody(loginSchema), async (req, res) => {
    respond(res, await auth.login(req.body, meta(req)));
  });

  router.post('/auth/guest', limiter(config, 60 * 60_000, 30), validateBody(guestSchema), async (req, res) => {
    respond(res, await auth.guest(req.body, meta(req)), 201);
  });

  router.post('/auth/refresh', limiter(config, 10 * 60_000, 120), csrfGuard(config), async (req, res) => {
    const token = req.cookies?.[REFRESH_COOKIE] as string | undefined;
    if (!token) throw new HttpError('UNAUTHORIZED', 'No active session.');
    try {
      respond(res, await auth.refresh(token, meta(req)));
    } catch (err) {
      clearRefreshCookie(res);
      throw err;
    }
  });

  router.post('/auth/logout', csrfGuard(config), async (req, res) => {
    await auth.logout(req.cookies?.[REFRESH_COOKIE] as string | undefined);
    clearRefreshCookie(res);
    res.status(204).end();
  });

  router.get('/auth/me', requireAuth(config), async (req, res) => {
    const user = await auth.getUser(req.userId!);
    if (!user) throw new HttpError('UNAUTHORIZED');
    res.json({ user });
  });

  // ---- Profile ----------------------------------------------------------------
  router.get('/profile/me', requireAuth(config), async (req, res) => {
    res.json(await profiles.getProfile(req.userId!));
  });

  router.patch('/profile/me', requireAuth(config), validateBody(profileUpdateSchema), async (req, res) => {
    res.json(await profiles.updateProfile(req.userId!, req.body));
  });

  router.get('/profile/me/history', requireAuth(config), async (req, res) => {
    res.json({ games: await profiles.history(req.userId!) });
  });

  router.get('/profile/:userId', optionalAuth(config), async (req, res) => {
    const id = parseWith(idSchema, req.params.userId);
    if (!id.ok) throw new HttpError('NOT_FOUND', 'Player not found.');
    res.json(await profiles.getProfile(id.data));
  });

  // ---- Leaderboard --------------------------------------------------------------
  router.get('/leaderboard', limiter(config, 60_000, 60), optionalAuth(config), async (req, res) => {
    const query = parseWith(leaderboardQuerySchema, req.query);
    if (!query.ok) throw new HttpError('VALIDATION', query.error.message, query.error.fields);
    res.json(await profiles.leaderboard(query.data.category, query.data.limit, req.userId ?? null));
  });

  // ---- Friends (registered players only; identity always from the access token) -------
  const userParam = (raw: unknown) => {
    const id = parseWith(idSchema, raw);
    if (!id.ok) throw new HttpError('NOT_FOUND', 'Player not found.');
    return id.data;
  };
  router.get('/friends', requireAuth(config), async (req, res) => {
    res.json(await friends.list(req.userId!));
  });
  router.post('/friends/requests', requireAuth(config), limiter(config, 10 * 60_000, 30), validateBody(friendRequestSchema), async (req, res) => {
    res.status(201).json(await friends.request(req.userId!, req.isGuest === true, (req.body as { username: string }).username));
  });
  router.post('/friends/requests/:userId/accept', requireAuth(config), async (req, res) => {
    await friends.accept(req.userId!, userParam(req.params.userId));
    res.status(204).end();
  });
  router.post('/friends/requests/:userId/reject', requireAuth(config), async (req, res) => {
    await friends.reject(req.userId!, userParam(req.params.userId));
    res.status(204).end();
  });
  router.delete('/friends/:userId', requireAuth(config), async (req, res) => {
    await friends.remove(req.userId!, userParam(req.params.userId));
    res.status(204).end();
  });

  // ---- Replays --------------------------------------------------------------------
  router.get('/games/:gameId/replay', requireAuth(config), async (req, res) => {
    const id = parseWith(idSchema, req.params.gameId);
    if (!id.ok) throw new HttpError('GAME_NOT_FOUND');
    const replay = await games.loadReplay(id.data);
    if (!replay) throw new HttpError('GAME_NOT_FOUND');
    // Live games are only visible to their participants.
    if (replay.status === 'ACTIVE' && !(await games.isParticipant(id.data, req.userId!))) {
      throw new HttpError('FORBIDDEN');
    }
    res.json(replay);
  });

  return router;
}
