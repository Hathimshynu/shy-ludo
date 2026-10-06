/**
 * Dice seed for end-to-end runs. Game length with random dice varies about 4× (a 2-player,
 * 1-token game takes 21–90 actions), which made full-game tests time out at random. With a
 * seed every run plays the same games. 2216 was chosen by simulating the test
 * configurations with the real engine: 2 players ≈ 29 actions, 4 ≈ 50, 8 ≈ 163, solo ≈ 29,
 * each with at least one capture, and the solo human wins.
 *
 * Server: passed as DICE_SEED (refused in production). Browser (solo worker): read from
 * localStorage only in VITE_E2E builds.
 */
export const E2E_DICE_SEED = '2216';
export const E2E_DICE_SEED_KEY = 'ludo-nova:e2e-dice-seed';
