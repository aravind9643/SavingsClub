/**
 * How the row editor reads and writes a column. Pure functions, kept out of
 * the component so they can be tested on their own -- this is where a typed
 * "10.10" becomes 1010 paise, and getting that wrong is a wrong balance.
 *
 * The kind is worked out from the column name first, because this schema is
 * consistent about it: `_paise` is integer money, `_bp` is basis points, `_on`
 * is a calendar date, `is_` is a flag. The value alone is not enough -- a null
 * says nothing about its type.
 */

export type Kind = 'readonly' | 'json' | 'paise' | 'bp' | 'int' | 'bool' | 'date' | 'text';

const READONLY_COLS = new Set(['group_id', 'created_at']);
const INT_SUFFIXES = ['_count', '_months', '_hours', '_day'];

export function kindOf(col: string, value: unknown, pk: string, editable: boolean): Kind {
  if (!editable || col === pk || READONLY_COLS.has(col)) return 'readonly';
  if (value !== null && typeof value === 'object') return 'json';
  if (col.endsWith('_paise')) return 'paise';
  if (col.endsWith('_bp')) return 'bp';
  if (typeof value === 'boolean' || col.startsWith('is_') || col.startsWith('has_')) return 'bool';
  if (typeof value === 'number' || INT_SUFFIXES.some((s) => col.endsWith(s))) return 'int';
  if (col.endsWith('_on') || col.endsWith('_date') || (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value))) {
    return 'date';
  }
  return 'text';
}

/** What the input shows for a stored value. */
export function toInput(kind: Kind, value: unknown): string {
  if (value === null || value === undefined) return '';
  if (kind === 'paise') {
    // Exact: split the integer rather than divide, so 1050 shows "10.50".
    const p = Number(value);
    const sign = p < 0 ? '-' : '';
    const abs = Math.abs(p);
    const r = Math.floor(abs / 100);
    const c = abs % 100;
    return c === 0 ? `${sign}${r}` : `${sign}${r}.${String(c).padStart(2, '0')}`;
  }
  if (kind === 'date') return String(value).slice(0, 10);
  if (kind === 'json') return JSON.stringify(value, null, 2);
  return String(value);
}

/**
 * What gets stored for what was typed. Throws a sentence on bad input rather
 * than guessing: the app's rupeesToPaise() turns "abc" into 0, which in an
 * editor would silently zero a balance.
 */
export function fromInput(kind: Kind, col: string, text: string): unknown {
  const t = text.trim();
  if (t === '') return null;
  switch (kind) {
    case 'paise': {
      const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(t.replace(/,/g, ''));
      if (!m) throw new Error(`${col}: enter rupees like 1500 or 1500.50`);
      // Integer arithmetic only -- 10.10 * 100 is 1009.9999999999999.
      const paise = Number(m[2]) * 100 + Number((m[3] ?? '').padEnd(2, '0'));
      if (!Number.isSafeInteger(paise)) throw new Error(`${col}: amount is too large`);
      return m[1] ? -paise : paise;
    }
    case 'bp':
    case 'int': {
      if (!/^-?\d+$/.test(t)) throw new Error(`${col}: must be a whole number`);
      const n = Number(t);
      if (!Number.isSafeInteger(n)) throw new Error(`${col}: number is too large`);
      return n;
    }
    case 'bool':
      return t === 'true';
    default:
      return t;
  }
}
