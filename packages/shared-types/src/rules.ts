/**
 * Configurable rule set. Every variant behaviour of the engine is driven from here;
 * no other module hard-codes variant logic.
 */
export interface GameRules {
  /** Seats in the game (2–8). Also selects the board: ≤4 → 4 arms, ≤6 → 6 arms, else 8 arms. */
  maxPlayers: number;
  /** Tokens per player (1–4). */
  tokensPerPlayer: number;
  /** true: only a 6 releases a token from base. false: a 1 or a 6 releases. */
  requireSixToStart: boolean;
  extraTurnOnSix: boolean;
  extraTurnOnCapture: boolean;
  extraTurnOnHome: boolean;
  /** Third consecutive six in one turn voids the roll and ends the turn. */
  threeSixPenalty: boolean;
  /** Tokens must reach the centre with an exact count (no overshoot). */
  exactHomeEntry: boolean;
  /** Two or more tokens of one player on a non-safe track square block opponents. */
  allowBlockades: boolean;
  /** Server moves automatically when every legal move leads to the same result. */
  autoMoveSingleOption: boolean;
  /** Seconds per turn phase. 0 disables the timer (solo practice only). */
  turnTimeSeconds: number;
  /** Consecutive timeouts before the player forfeits. 0 disables. */
  maxConsecutiveTimeouts: number;
  /** Keep playing after the first winner until everyone is ranked. */
  continueAfterWinner: boolean;
}
