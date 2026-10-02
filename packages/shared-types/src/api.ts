import type { PlayerColor } from './game';

export interface PublicUser {
  id: string;
  username: string;
  displayName: string;
  avatar: string;
  isGuest: boolean;
}

export interface AuthResponse {
  user: PublicUser;
  accessToken: string;
  /** Seconds until the access token expires. */
  expiresIn: number;
}

export interface ProfileStats {
  gamesPlayed: number;
  gamesWon: number;
  winRate: number;
  captures: number;
  timesCaptured: number;
  tokensFinished: number;
  sixesRolled: number;
  rating: number;
  bestRank: number | null;
}

export interface AchievementView {
  key: string;
  name: string;
  description: string;
  unlockedAt: string | null;
}

export interface ProfileView {
  user: PublicUser;
  stats: ProfileStats;
  achievements: AchievementView[];
  memberSince: string;
}

export type LeaderboardCategory = 'wins' | 'games' | 'captures' | 'rating';

export interface LeaderboardEntry {
  rank: number;
  user: PublicUser;
  value: number;
  gamesPlayed: number;
}

export interface LeaderboardResponse {
  category: LeaderboardCategory;
  entries: LeaderboardEntry[];
  me: LeaderboardEntry | null;
}

export interface GameHistoryEntry {
  gameId: string;
  finishedAt: string | null;
  playerCount: number;
  rank: number | null;
  color: PlayerColor;
  captures: number;
  ratingDelta: number;
}

export interface ApiErrorBody {
  error: { code: string; message: string; fields?: Record<string, string> };
  requestId?: string;
}
