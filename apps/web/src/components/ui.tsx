import { type ReactNode, useEffect, useId, useRef } from 'react';
import { BRAND } from '@ludo/config';
import { audio } from '../services/audio';
import { useUi } from '../store/uiStore';

export function Logo({ size = 34, withText = true }: { size?: number; withText?: boolean }) {
  return (
    <span className="logo">
      <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
        <defs>
          <radialGradient id="logo-core" cx="50%" cy="50%" r="50%">
            <stop offset="0" stopColor="#fff7d6" />
            <stop offset="0.5" stopColor="#ffc94d" />
            <stop offset="1" stopColor="#ff7a3d" stopOpacity="0" />
          </radialGradient>
        </defs>
        <path d="M32 4 L38 26 L32 32 L26 26 Z" fill="#2ee59d" />
        <path d="M60 32 L38 38 L32 32 L38 26 Z" fill="#ffd23f" />
        <path d="M32 60 L26 38 L32 32 L38 38 Z" fill="#ff4d5e" />
        <path d="M4 32 L26 26 L32 32 L26 38 Z" fill="#3d8bff" />
        <circle cx="32" cy="32" r="10" fill="url(#logo-core)" />
      </svg>
      {withText && (
        <span className="logo-text">
          {BRAND.name.split(' ')[0]}
          <b>{BRAND.name.split(' ').slice(1).join(' ')}</b>
        </span>
      )}
    </span>
  );
}

export function Toasts() {
  const toasts = useUi((s) => s.toasts);
  const dismiss = useUi((s) => s.dismiss);
  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map((t) => (
        <button key={t.id} className={`toast toast-${t.kind}`} onClick={() => dismiss(t.id)}>
          {t.message}
        </button>
      ))}
    </div>
  );
}

const CONNECTION_LABEL = {
  idle: 'Offline',
  connecting: 'Connecting',
  connected: 'Connected',
  reconnecting: 'Reconnecting',
  offline: 'Offline',
} as const;

export function ConnectionBadge({ compact = false }: { compact?: boolean }) {
  const status = useUi((s) => s.connection);
  const tone = status === 'connected' ? 'good' : status === 'reconnecting' || status === 'connecting' ? 'warn' : 'bad';
  return (
    <span className={`conn conn-${tone}`} title={CONNECTION_LABEL[status]} aria-label={`Connection: ${CONNECTION_LABEL[status]}`}>
      <i />
      {!compact && CONNECTION_LABEL[status]}
    </span>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="spinner-wrap" role="status">
      <span className="spinner" aria-hidden="true" />
      {label && <span>{label}</span>}
    </span>
  );
}

export function Modal({ title, children, onClose, actions }: { title: string; children: ReactNode; onClose: () => void; actions?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('button, input, select, [tabindex]')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal panel" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={ref}>
        <h2 id={titleId}>{title}</h2>
        <div className="modal-body">{children}</div>
        {actions && <div className="modal-actions">{actions}</div>}
      </div>
    </div>
  );
}

export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  label,
  disabled,
}: {
  value: T;
  options: Array<{ value: T; label: ReactNode }>;
  onChange: (v: T) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          className={`seg-option ${o.value === value ? 'is-active' : ''}`}
          disabled={disabled}
          onClick={() => {
            audio.play('click');
            onChange(o.value);
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <label className={`switch-row ${disabled ? 'is-disabled' : ''}`}>
      <span>
        <span className="switch-label">{label}</span>
        {hint && <span className="switch-hint">{hint}</span>}
      </span>
      <input
        type="checkbox"
        role="switch"
        className="switch"
        checked={checked}
        disabled={disabled}
        onChange={(e) => {
          audio.play('click');
          onChange(e.target.checked);
        }}
      />
    </label>
  );
}

export function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string | undefined;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {error && <span className="field-error">{error}</span>}
    </label>
  );
}
