import type { RoomSettings, RuleVariants } from '@ludo/shared-types';
import { LIMITS } from '@ludo/config';
import { Segmented, Switch } from './ui';

const VARIANT_COPY: Array<{ key: keyof RuleVariants; label: string; hint: string }> = [
  { key: 'requireSixToStart', label: 'Six to start', hint: 'Off: a 1 or a 6 releases a token' },
  { key: 'extraTurnOnSix', label: 'Extra roll on a 6', hint: 'Classic bonus roll' },
  { key: 'extraTurnOnCapture', label: 'Extra roll on capture', hint: 'Reward aggressive play' },
  { key: 'extraTurnOnHome', label: 'Extra roll on reaching home', hint: '' },
  { key: 'threeSixPenalty', label: 'Three sixes penalty', hint: 'Third six in a row ends the turn' },
  { key: 'exactHomeEntry', label: 'Exact roll to finish', hint: 'No overshooting the centre' },
  { key: 'allowBlockades', label: 'Blockades', hint: 'Two of your tokens block a square' },
  { key: 'continueAfterWinner', label: 'Rank everyone', hint: 'Off: game ends at the first winner' },
];

export function RulesEditor({
  value,
  onChange,
  disabled,
  minPlayers = 2,
  showPlayers = true,
}: {
  value: RoomSettings;
  onChange: (v: RoomSettings) => void;
  disabled?: boolean;
  minPlayers?: number;
  showPlayers?: boolean;
}) {
  const set = (patch: Partial<RoomSettings>) => onChange({ ...value, ...patch });
  return (
    <div className="rules">
      {showPlayers && (
        <div className="rules-row">
          <span className="rules-label">Players</span>
          <Segmented
            label="Players"
            value={value.maxPlayers}
            disabled={disabled}
            onChange={(maxPlayers) => set({ maxPlayers })}
            options={[2, 3, 4, 5, 6, 7, 8]
              .filter((n) => n >= minPlayers)
              .map((n) => ({ value: n, label: n }))}
          />
        </div>
      )}
      <div className="rules-row">
        <span className="rules-label">Turn timer</span>
        <Segmented
          label="Turn timer"
          value={value.turnTimeSeconds}
          disabled={disabled}
          onChange={(turnTimeSeconds) => set({ turnTimeSeconds })}
          options={LIMITS.turnTimeOptions.map((s) => ({ value: s, label: `${s}s` }))}
        />
      </div>
      <div className="rules-row">
        <span className="rules-label">Tokens</span>
        <Segmented
          label="Tokens per player"
          value={value.tokensPerPlayer}
          disabled={disabled}
          onChange={(tokensPerPlayer) => set({ tokensPerPlayer })}
          options={[1, 2, 3, 4].map((n) => ({ value: n, label: n }))}
        />
      </div>
      <details className="rules-variants">
        <summary>Rule variants</summary>
        <div className="variants-grid">
          {VARIANT_COPY.map((v) => (
            <Switch
              key={v.key}
              label={v.label}
              hint={v.hint || undefined}
              checked={value.variants[v.key]}
              disabled={disabled}
              onChange={(checked) => set({ variants: { ...value.variants, [v.key]: checked } })}
            />
          ))}
        </div>
      </details>
    </div>
  );
}
