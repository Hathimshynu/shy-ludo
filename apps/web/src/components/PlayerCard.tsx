import { memo } from 'react';
import type { PlayerState } from '@ludo/shared-types';
import { type ArmCount, createBoard, finishProgress } from '@ludo/game-engine';
import { PLAYER_HEX } from '../game/layout';
import { ORDINAL } from '../game/director';
import { Avatar } from './Avatar';

interface Props {
  player: PlayerState;
  armCount: number;
  isTurn: boolean;
  isMe: boolean;
  connected: boolean;
  /** 0..1 of the turn timer remaining, or null when no timer. */
  timeLeft: number | null;
  emote?: string | undefined;
  /** Smaller row for side panels. */
  compact?: boolean;
  /** Minimal avatar chip for the portrait player strip. */
  chip?: boolean;
}

const EMOTE_GLYPH: Record<string, string> = {
  wave: '👋',
  laugh: '😂',
  wow: '😮',
  angry: '😠',
  gg: '🤝',
  thumbs: '👍',
  fire: '🔥',
  cry: '😢',
};

export const PlayerCard = memo(function PlayerCard({ player, armCount, isTurn, isMe, connected, timeLeft, emote, compact, chip }: Props) {
  const finish = finishProgress(createBoard(armCount as ArmCount));
  const home = player.tokens.filter((t) => t >= finish).length;
  const base = player.tokens.filter((t) => t < 0).length;
  const color = PLAYER_HEX[player.color];
  const out = player.status === 'forfeited';
  const classes = ['player-card', compact && 'is-compact', chip && 'is-chip', isTurn && 'is-turn', isMe && 'is-me', !connected && 'is-offline', out && 'is-out']
    .filter(Boolean)
    .join(' ');
  const ring = timeLeft !== null && isTurn ? timeLeft : null;
  if (chip) {
    return (
      <span className={classes} style={{ ['--pc' as string]: color }} title={player.name}>
        <span className="pc-avatar">
          <Avatar id={player.avatar} size={30} ring={color} />
          {emote && <span className="pc-emote">{EMOTE_GLYPH[emote] ?? '✨'}</span>}
        </span>
        <span className="pc-chip-meta">
          {player.rank !== null && player.status === 'finished' ? (
            ORDINAL[player.rank - 1]
          ) : out ? (
            'Left'
          ) : !connected ? (
            'Off'
          ) : (
            // Keyed on the count so a token reaching home replays a short pop.
            <span key={home} className={home > 0 ? 'pc-home' : undefined} title={`${home} of ${player.tokens.length} tokens home`}>
              ★{home}
            </span>
          )}
        </span>
      </span>
    );
  }
  return (
    <div className={classes} style={{ ['--pc' as string]: color }} aria-current={isTurn ? 'true' : undefined}>
      <div className="pc-avatar">
        {ring !== null && (
          <svg className="pc-timer" viewBox="0 0 52 52" aria-hidden="true">
            <circle cx="26" cy="26" r="24" pathLength={1} strokeDasharray={`${ring} 1`} />
          </svg>
        )}
        <Avatar id={player.avatar} size={38} ring={color} />
        {emote && <span className="pc-emote">{EMOTE_GLYPH[emote] ?? '✨'}</span>}
      </div>
      <div className="pc-body">
        <div className="pc-name">
          <span className="pc-dot" />
          <span className="pc-name-text">{player.name}</span>
          {isMe && <em className="pc-tag">You</em>}
          {player.kind === 'bot' && <em className="pc-tag">AI</em>}
        </div>
        <div className="pc-meta">
          {player.rank !== null && player.status === 'finished' ? (
            <span className="pc-rank">{ORDINAL[player.rank - 1]}</span>
          ) : out ? (
            <span className="pc-status">Left</span>
          ) : !connected ? (
            <span className="pc-status">Offline</span>
          ) : (
            <>
              <span key={home} className={home > 0 ? 'pc-home' : undefined} title="Tokens home">
                ★ Home {home}/{player.tokens.length}
              </span>
              <span title="Tokens in base">Base {base}</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
});

export { EMOTE_GLYPH };
