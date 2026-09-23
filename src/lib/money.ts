/**
 * Money is integer paise everywhere -- in the database, over the wire, and in
 * this app. It is never a float and never a partial rupee.
 *
 * Rs.50 lakh is 5e8 paise, eight orders of magnitude below Number.MAX_SAFE_INTEGER,
 * so integer arithmetic in JS is exact at this scale. `assertSafe` exists to make
 * that assumption fail loudly rather than silently if it ever stops holding.
 */

export type Paise = number;

export function assertSafe(p: number): Paise {
  if (!Number.isFinite(p) || !Number.isSafeInteger(p)) {
    throw new Error(`Money value is not a safe integer: ${p}`);
  }
  return p;
}

/** Supabase returns bigint columns as number or string depending on size. */
export function toPaise(value: number | string | null | undefined): Paise {
  if (value === null || value === undefined || value === '') return 0;
  const n = typeof value === 'string' ? Number(value) : value;
  return assertSafe(n);
}

/** Rupees typed by a human -> paise. Rounds half-up at 2 decimals. */
export function rupeesToPaise(rupees: number | string): Paise {
  const n = typeof rupees === 'string' ? Number(rupees.replace(/,/g, '')) : rupees;
  if (!Number.isFinite(n)) return 0;
  return assertSafe(Math.round(n * 100));
}

export function paiseToRupees(p: Paise): number {
  return toPaise(p) / 100;
}

const INR = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});

const INR_PRECISE = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Display form. Whole rupees unless there are paise to show. */
export function formatPaise(value: number | string | null | undefined): string {
  const p = toPaise(value);
  return p % 100 === 0 ? INR.format(p / 100) : INR_PRECISE.format(p / 100);
}

/** Compact form for dense tables: Rs.1.2L, Rs.45.5k */
export function formatPaiseShort(value: number | string | null | undefined): string {
  const r = paiseToRupees(toPaise(value));
  const abs = Math.abs(r);
  if (abs >= 1e7) return `₹${(r / 1e7).toFixed(2)}Cr`;
  if (abs >= 1e5) return `₹${(r / 1e5).toFixed(2)}L`;
  if (abs >= 1e3) return `₹${(r / 1e3).toFixed(1)}k`;
  return `₹${r.toFixed(0)}`;
}

/** Basis points (200 = 2.00%) -> display string. */
export function formatBp(bp: number): string {
  return `${(bp / 100).toFixed(bp % 100 === 0 ? 0 : 2)}%`;
}
