import { describe, expect, it } from 'vitest';
import { parseWith, registerSchema, roomCodeSchema, roomSettingsSchema, socketSchemas } from '../src';

describe('validation schemas', () => {
  it('normalises room codes and rejects ambiguous characters', () => {
    expect(roomCodeSchema.parse(' a7k9p2 ')).toBe('A7K9P2');
    expect(roomCodeSchema.safeParse('A7K9P').success).toBe(false);
    expect(roomCodeSchema.safeParse('A0K9P2').success).toBe(false); // 0 is not in the alphabet
    expect(roomCodeSchema.safeParse('AIK9P2').success).toBe(false); // I is not in the alphabet
  });

  it('rejects client-supplied dice values, player ids and positions on game actions', () => {
    const base = { gameId: 'game_1', actionId: '0d9c2a4e-9a5b-4b8e-9d0f-2f1f6e3a1c11', expectedSeq: 4 };
    expect(socketSchemas['dice:roll'].parse(base)).toEqual(base);
    for (const forged of [{ value: 6 }, { value: '6' }, { value: 0 }, { value: 7 }, { value: -1 }, { value: 999 }, { dice: 6 }, { playerId: 'someone-else' }, { userId: 'x' }]) {
      expect(socketSchemas['dice:roll'].safeParse({ ...base, ...forged }).success).toBe(false);
    }
    expect(socketSchemas['token:move'].safeParse({ ...base, tokenIndex: 1 }).success).toBe(true);
    expect(socketSchemas['token:move'].safeParse({ ...base, tokenIndex: 1, playerId: 'p2' }).success).toBe(false);
    expect(socketSchemas['token:move'].safeParse({ ...base, tokenIndex: 1, to: 56 }).success).toBe(false);
  });

  it('rejects malformed moves', () => {
    const base = { gameId: 'g', actionId: '0d9c2a4e-9a5b-4b8e-9d0f-2f1f6e3a1c11', expectedSeq: 0 };
    expect(socketSchemas['token:move'].safeParse({ ...base, tokenIndex: 4 }).success).toBe(false);
    expect(socketSchemas['token:move'].safeParse({ ...base, tokenIndex: -1 }).success).toBe(false);
    expect(socketSchemas['token:move'].safeParse({ ...base, tokenIndex: '1' }).success).toBe(false);
    expect(socketSchemas['token:move'].safeParse({ ...base, actionId: 'nope', tokenIndex: 1 }).success).toBe(false);
    expect(socketSchemas['token:move'].safeParse({ ...base, gameId: '../etc', tokenIndex: 1 }).success).toBe(false);
  });

  it('only accepts supported table sizes and timers', () => {
    expect(socketSchemas['matchmaking:join'].safeParse({ playerCount: 4 }).success).toBe(true);
    expect(socketSchemas['matchmaking:join'].safeParse({ playerCount: 5 }).success).toBe(false);
    const settings = {
      maxPlayers: 8,
      turnTimeSeconds: 45,
      tokensPerPlayer: 4,
      variants: {
        requireSixToStart: true,
        extraTurnOnSix: true,
        extraTurnOnCapture: true,
        extraTurnOnHome: true,
        threeSixPenalty: true,
        exactHomeEntry: true,
        allowBlockades: false,
        continueAfterWinner: true,
      },
    };
    expect(roomSettingsSchema.safeParse(settings).success).toBe(true);
    expect(roomSettingsSchema.safeParse({ ...settings, maxPlayers: 9 }).success).toBe(false);
    expect(roomSettingsSchema.safeParse({ ...settings, turnTimeSeconds: 31 }).success).toBe(false);
  });

  it('reports field errors in a friendly shape', () => {
    const r = parseWith(registerSchema, { username: 'a', password: 'short' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('VALIDATION');
      expect(Object.keys(r.error.fields ?? {})).toEqual(expect.arrayContaining(['username', 'password']));
    }
  });

  it('rejects markup in display names', () => {
    expect(parseWith(registerSchema, { username: 'neo', password: 'password123', displayName: '<script>' }).ok).toBe(
      false,
    );
  });
});
