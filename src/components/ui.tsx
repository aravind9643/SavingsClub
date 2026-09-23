import {
  useEffect, useRef, useState, type ReactNode, type ButtonHTMLAttributes,
} from 'react';
import { createPortal } from 'react-dom';
import { formatPaise } from '../lib/money';
import { IconChevron, IconClose } from './icons';

export type Tone = 'mint' | 'coral' | 'amber' | 'violet';

/* ------------------------------------------------------------------ money -- */

/** Counts up to a figure, settling without overshoot. Money shouldn't bounce. */
function useCountUp(target: number, ms = 800): number {
  const [value, setValue] = useState(target);
  const from = useRef(target);
  const raf = useRef(0);

  useEffect(() => {
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduced || from.current === target) {
      setValue(target);
      from.current = target;
      return;
    }
    const start = performance.now();
    const a = from.current;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / ms);
      const eased = 1 - (1 - t) ** 3;
      setValue(Math.round(a + (target - a) * eased));
      if (t < 1) raf.current = requestAnimationFrame(tick);
      else from.current = target;
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [target, ms]);

  return value;
}

export function Amount({
  paise, count,
}: { paise: number | string | null | undefined; count?: boolean }) {
  const n = typeof paise === 'string' ? Number(paise) : (paise ?? 0);
  const shown = useCountUp(count ? n : n, count ? 800 : 0);
  return <span className="amount">{formatPaise(count ? shown : n)}</span>;
}

/* ------------------------------------------------------------------- hero -- */

export function Hero({
  label, paise, meta, meter,
}: {
  label: string;
  paise: number;
  meta?: ReactNode;
  meter?: { value: number; limit: number };
}) {
  const shown = useCountUp(paise);
  const pct = meter && meter.limit > 0
    ? Math.min(100, (meter.value / meter.limit) * 100)
    : 0;
  // An empty track carries no information — drop it until there is something
  // to measure.
  const showMeter = Boolean(meter && meter.limit > 0);

  return (
    <div className="hero">
      <div className="hero-label">{label}</div>
      <div className="hero-amount">{formatPaise(shown)}</div>
      {meta ? <div className="hero-meta">{meta}</div> : null}
      {meter && showMeter ? (
        <div
          className={`meter${meter.value > meter.limit ? ' over' : ''}`}
          role="progressbar"
          aria-valuenow={Math.round(pct)}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <i style={{ width: `${pct}%` }} />
        </div>
      ) : null}
    </div>
  );
}

export function Chip({
  tone, children,
}: { tone?: Tone; children: ReactNode }) {
  return <span className={`chip${tone ? ` ${tone}` : ''}`}>{children}</span>;
}

export function Tag({ tone, children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`tag${tone ? ` ${tone}` : ''}`}>{children}</span>;
}

/* ------------------------------------------------------------------ rows -- */

export function List({ children }: { children: ReactNode }) {
  return <div className="list">{children}</div>;
}

export function Row({
  icon, iconTone, title, sub, amount, amountTone, note, onClick, chevron,
}: {
  icon?: ReactNode;
  iconTone?: Tone;
  title: ReactNode;
  sub?: ReactNode;
  amount?: ReactNode;
  amountTone?: 'mint' | 'coral';
  note?: ReactNode;
  onClick?: () => void;
  chevron?: boolean;
}) {
  const inner = (
    <>
      {icon !== undefined && (
        <span className={`row-ico${iconTone ? ` ${iconTone}` : ''}`}>{icon}</span>
      )}
      <span className="row-main">
        <span className="row-title">{title}</span>
        {sub ? <span className="row-sub">{sub}</span> : null}
      </span>
      {(amount !== undefined || note) && (
        <span className="row-right">
          {amount !== undefined && (
            <span className={`row-amt${amountTone ? ` ${amountTone}` : ''}`}>{amount}</span>
          )}
          {note ? <span className="row-note">{note}</span> : null}
        </span>
      )}
      {chevron ? <IconChevron width={16} height={16} style={{ color: 'var(--text-3)', flex: 'none' }} /> : null}
    </>
  );

  if (!onClick) return <div className="row static">{inner}</div>;
  return <button type="button" className="row" onClick={onClick}>{inner}</button>;
}

/* ---------------------------------------------------------------- notices -- */

export function Notice({
  tone = 'good', children, onClick,
}: {
  tone?: 'good' | 'warn' | 'danger';
  children: ReactNode;
  onClick?: () => void;
}) {
  const body = (
    <>
      <span className="dot" />
      <span style={{ minWidth: 0, flex: 1 }}>{children}</span>
      {onClick ? <IconChevron width={16} height={16} className="chev" /> : null}
    </>
  );
  if (!onClick) return <div className={`notice ${tone}`}>{body}</div>;
  return (
    <button
      type="button"
      className={`notice ${tone}`}
      onClick={onClick}
    >
      {body}
    </button>
  );
}

/* ----------------------------------------------------------------- panels -- */

export function Panel({
  title, action, children, flush,
}: { title?: ReactNode; action?: ReactNode; children: ReactNode; flush?: boolean }) {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {(title || action) && (
        <div className="sec-head">
          {title ? <h2>{title}</h2> : <span style={{ marginRight: 'auto' }} />}
          {action}
        </div>
      )}
      <div className={`panel${flush ? ' flush' : ''}`}>{children}</div>
    </section>
  );
}

export function Stat({
  k, v, s, tone,
}: { k: string; v: ReactNode; s?: ReactNode; tone?: 'mint' | 'coral' | 'amber' }) {
  return (
    <div className={`stat${tone ? ` ${tone}` : ''}`}>
      <span className="k">{k}</span>
      <span className="v">{v}</span>
      {s ? <span className="s">{s}</span> : null}
    </div>
  );
}

/* ---------------------------------------------------------- bottom sheet -- */

/**
 * Forms live in a sheet that rises from the bottom, the way a payment app asks
 * for input. On a wide screen it becomes a centred dialog instead.
 *
 * Escape closes it, the scrim closes it, and the page behind is locked from
 * scrolling while it is open.
 */
let activeSheetsCount = 0;

/** Unconditionally unlock body scroll, used during navigation or route changes. */
export function resetScrollLock(): void {
  activeSheetsCount = 0;
  if (typeof document !== 'undefined') {
    document.body.style.overflow = '';
  }
}

export function Sheet({
  open, title, onClose, children, footer,
}: {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    activeSheetsCount++;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      activeSheetsCount = Math.max(0, activeSheetsCount - 1);
      if (activeSheetsCount === 0) {
        document.body.style.overflow = '';
      }
    };
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <>
      <div className="scrim" onClick={onClose} />
      <div className="sheet" role="dialog" aria-modal="true" aria-label={String(title)}>
        <div className="sheet-grab" />
        <div className="sheet-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <IconClose />
          </button>
        </div>
        <div className="sheet-body">
          {children}
          {footer}
        </div>
      </div>
    </>,
    document.body,
  );
}

/* ------------------------------------------------------------------ forms -- */

export function Field({
  label, children, hint,
}: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {hint ? <div className="field-hint">{hint}</div> : null}
    </div>
  );
}

/** The oversized rupee input a payment app uses for the main amount. */
export function AmountField({
  value, onChange, autoFocus,
}: { value: string; onChange: (v: string) => void; autoFocus?: boolean }) {
  return (
    <div className="amount-input">
      <span>₹</span>
      <input
        inputMode="decimal"
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value.replace(/[^\d.]/g, ''))}
        placeholder="0"
        aria-label="Amount in rupees"
      />
    </div>
  );
}

export function Busy({
  pending, children, ...rest
}: { pending?: boolean; children: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button {...rest} disabled={rest.disabled || pending}>
      {pending ? <span className="spinner" /> : null}
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------ misc -- */

export function ErrorNote({ error }: { error: string | null | undefined }) {
  if (!error) return null;
  return <div className="error" role="alert">{error}</div>;
}

export function Empty({ icon, children }: { icon?: ReactNode; children: ReactNode }) {
  return (
    <div className="empty">
      {icon ? <div className="empty-ico">{icon}</div> : null}
      {children}
    </div>
  );
}

export function Loading({ what = 'Loading' }: { what?: string }) {
  return <div className="empty"><span className="spinner" />{what}…</div>;
}

export function SkeletonList({ rows = 4 }: { rows?: number }) {
  return (
    <div className="list" style={{ padding: 14, gap: 14 }}>
      {Array.from({ length: rows }, (_r, i) => (
        <div key={i} style={{ display: 'flex', gap: 12, alignItems: 'center', opacity: 1 - i * 0.16 }}>
          <div className="skeleton" style={{ width: 38, height: 38, borderRadius: 13, flex: 'none' }} />
          <div style={{ flex: 1, display: 'grid', gap: 6 }}>
            <div className="skeleton" style={{ height: 11, width: '55%' }} />
            <div className="skeleton" style={{ height: 9, width: '35%' }} />
          </div>
          <div className="skeleton" style={{ height: 12, width: 58 }} />
        </div>
      ))}
    </div>
  );
}

/** Horizontal filter chips. */
export function Segments<T extends string>({
  value, options, onChange,
}: {
  value: T;
  options: { value: T; label: string; count?: number }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="scroller">
      {options.map((o) => (
        <button
          key={o.value}
          className={`seg${o.value === value ? ' on' : ''}`}
          onClick={() => onChange(o.value)}
        >
          {o.label}
          {o.count !== undefined && o.count > 0 ? ` · ${o.count}` : ''}
        </button>
      ))}
    </div>
  );
}

/**
 * Two letters wherever possible: a single-word name falls back to its first
 * two characters rather than one lonely letter in a round avatar.
 */
export function initials(name: string | undefined | null): string {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * A role, written the way it is spoken.
 *
 * `role` arrives from the database as a lowercase enum -- 'cashier', 'admin'.
 * Six separate places were printing that value straight onto the screen, so a
 * member's own profile tag read "admin" in lower case while the Members page
 * listed "Admin" a few rows away. One helper means the spelling cannot drift
 * apart again.
 *
 * 'president' is still mapped: a token issued before migration 0024 can carry
 * the old label, and a stale client should show "Admin" rather than fall
 * through to the raw value.
 */
export function roleLabel(role: string | null | undefined): string {
  switch (role) {
    case 'cashier': return 'Cashier';
    case 'accountant': return 'Accountant';
    case 'admin': return 'Admin';
    case 'president': return 'Admin';
    case 'member': return 'Member';
    default: return role ? role.charAt(0).toUpperCase() + role.slice(1) : 'Member';
  }
}

export function toneForStatus(status: string, withdrawn = false): Tone {
  // A withdrawal is not a refusal: the requester changed their mind. Showing
  // it in the same alarming red as a rejection misreports what happened, and
  // it is the member's own record that carries the impression.
  if (withdrawn) return 'violet';
  switch (status) {
    case 'closed': case 'approved': case 'paid': return 'mint';
    case 'disbursed': case 'requested': case 'proposed': return 'amber';
    case 'rejected': case 'written_off': return 'coral';
    default: return 'violet';
  }
}

/** Display label for a status, distinguishing a withdrawal from a rejection. */
export function labelForStatus(status: string, withdrawn = false): string {
  if (withdrawn && status === 'rejected') return 'withdrawn';
  return status.replace(/_/g, ' ');
}

export function fmtDate(d: string | null | undefined): string {
  if (!d) return '—';
  // A bare YYYY-MM-DD is parsed as UTC midnight by spec, which renders as the
  // previous day for anyone behind Greenwich. Split the parts and build a
  // local date instead.
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  const date = m
    ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
    : new Date(d);
  return date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' });
}

export function fmtDateTime(d: string | null | undefined): string {
  if (!d) return '—';
  return new Date(d).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

/** "3 days ago" — friendlier than a timestamp in a feed. */
export function ago(iso: string | null | undefined): string {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 604800) return `${Math.floor(s / 86400)}d ago`;
  return fmtDate(iso);
}
