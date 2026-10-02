import type { GameRules, RoomSettings, RuleVariants } from '@ludo/shared-types';

export const DEFAULT_RULES: Readonly<GameRules> = Object.freeze({
  maxPlayers: 4,
  tokensPerPlayer: 4,
  requireSixToStart: true,
  extraTurnOnSix: true,
  extraTurnOnCapture: true,
  extraTurnOnHome: true,
  threeSixPenalty: true,
  exactHomeEntry: true,
  allowBlockades: false,
  autoMoveSingleOption: true,
  turnTimeSeconds: 30,
  maxConsecutiveTimeouts: 3,
  continueAfterWinner: true,
});

export const DEFAULT_VARIANTS: Readonly<RuleVariants> = Object.freeze({
  requireSixToStart: DEFAULT_RULES.requireSixToStart,
  extraTurnOnSix: DEFAULT_RULES.extraTurnOnSix,
  extraTurnOnCapture: DEFAULT_RULES.extraTurnOnCapture,
  extraTurnOnHome: DEFAULT_RULES.extraTurnOnHome,
  threeSixPenalty: DEFAULT_RULES.threeSixPenalty,
  exactHomeEntry: DEFAULT_RULES.exactHomeEntry,
  allowBlockades: DEFAULT_RULES.allowBlockades,
  continueAfterWinner: DEFAULT_RULES.continueAfterWinner,
});

export function defaultRoomSettings(maxPlayers = 4): RoomSettings {
  return {
    maxPlayers,
    turnTimeSeconds: DEFAULT_RULES.turnTimeSeconds,
    tokensPerPlayer: DEFAULT_RULES.tokensPerPlayer,
    variants: { ...DEFAULT_VARIANTS },
  };
}

/** Rules used by quick-match queues. Large tables end at the first winner to keep games reasonable. */
export function quickMatchRules(playerCount: number): GameRules {
  return normalizeRules({
    maxPlayers: playerCount,
    continueAfterWinner: playerCount <= 4,
  });
}

const clampInt = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Math.round(Number.isFinite(value) ? value : min)));

/** Fill defaults and clamp numeric ranges. Always returns a complete, valid rule set. */
export function normalizeRules(partial: Partial<GameRules> = {}): GameRules {
  const merged: GameRules = { ...DEFAULT_RULES, ...partial };
  return {
    ...merged,
    maxPlayers: clampInt(merged.maxPlayers, 2, 8),
    tokensPerPlayer: clampInt(merged.tokensPerPlayer, 1, 4),
    turnTimeSeconds: clampInt(merged.turnTimeSeconds, 0, 300),
    maxConsecutiveTimeouts: clampInt(merged.maxConsecutiveTimeouts, 0, 20),
  };
}

/** Dice values that release a token from base under these rules. */
export function releaseValues(rules: GameRules): readonly number[] {
  return rules.requireSixToStart ? [6] : [1, 6];
}

export function canRelease(rules: GameRules, dice: number): boolean {
  return releaseValues(rules).includes(dice);
}
