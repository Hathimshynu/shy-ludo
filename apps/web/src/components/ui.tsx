import { type InputHTMLAttributes, type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { BRAND } from '@ludo/config';
import { audio } from '../services/audio';
import { useBackGuard } from '../hooks/useBackGuard';
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

/**
 * Dialog that renders as a centred panel on desktop and as a bottom sheet on phones.
 * Escape, the close button, tapping the backdrop and the Android Back button all close it.
 */
export function Modal({
  title,
  children,
  onClose,
  actions,
  className,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  actions?: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useBackGuard(true, onClose);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('.modal-body button, .modal-body input, .modal-actions button, [tabindex]')?.focus();
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
    <div className="overlay" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal panel ${className ?? ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} ref={ref}>
        <span className="sheet-handle" aria-hidden="true" />
        <div className="modal-head">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="icon-btn modal-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
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

/**
 * Password input with a show/hide (eye) toggle. The toggle is a real button with an
 * accessible name and pressed state, sized as a 44 px touch target.
 */
export function PasswordInput(props: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  const [visible, setVisible] = useState(false);
  return (
    <span className="password-field">
      <input {...props} className={`input ${props.className ?? ''}`.trim()} type={visible ? 'text' : 'password'} />
      <button
        type="button"
        className="password-toggle"
        onClick={(e) => {
          e.preventDefault();
          setVisible((v) => !v);
        }}
        aria-label={visible ? 'Hide password' : 'Show password'}
        aria-pressed={visible}
      >
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" />
          <circle cx="12" cy="12" r="3" />
          {visible && <path d="M3 3l18 18" />}
        </svg>
      </button>
    </span>
  );
}
