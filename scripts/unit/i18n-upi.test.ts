import { readFileSync } from 'node:fs';
import { upiLink, looksLikeUpiRef } from '../../src/lib/upi.ts';

let fail = 0;
const eq = (n: string, g: unknown, w: unknown) => { if (JSON.stringify(g) !== JSON.stringify(w)) { fail++; console.log(`FAIL ${n}\n  got  ${JSON.stringify(g)}\n  want ${JSON.stringify(w)}`); } };

// --- UPI link ---------------------------------------------------------------
const u = new URL(upiLink('sangam.fund@okicici', 'Sangam Savings', 101010, 'Sangam September 2026 Ravi & Co'));
eq('scheme', u.protocol, 'upi:');
eq('pa', u.searchParams.get('pa'), 'sangam.fund@okicici');
eq('pn', u.searchParams.get('pn'), 'Sangam Savings');
eq('am exact from paise (1010.10)', u.searchParams.get('am'), '1010.10');
eq('cu', u.searchParams.get('cu'), 'INR');
eq('& in the note is escaped, not a new param', u.searchParams.get('tn'), 'Sangam September 2026 Ravi & Co');
eq('spaces as %20, never +', upiLink('a@b', 'A B', 100, 'x y').includes('+'), false);
eq('5 paise', new URL(upiLink('a@bk', 'x', 5, 'n')).searchParams.get('am'), '0.05');
eq('note capped at 50', new URL(upiLink('a@bk', 'x', 1, 'n'.repeat(80))).searchParams.get('tn')!.length, 50);
eq('12-digit UTR accepted', looksLikeUpiRef('426811234567'), true);
eq('too short refused', looksLikeUpiRef('12345'), false);
eq('spaces inside refused', looksLikeUpiRef('4268 1123 4567'), false);

// --- translations -----------------------------------------------------------
// Parse the two dictionaries out of the source (i18n.ts imports React).
const src = readFileSync(new URL('../../src/lib/i18n.ts', import.meta.url), 'utf8');
const block = (name: string) => {
  const start = src.indexOf(`const ${name}`);
  const open = src.indexOf('{', src.indexOf('=', start));
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error(name);
};
const parse = (b: string) => {
  const out: Record<string, string> = {};
  for (const m of b.matchAll(/'([a-z0-9.]+)':\s*(['"`])((?:\\.|(?!\2).)*)\2/g)) out[m[1]] = m[3];
  return out;
};
const EN = parse(block('EN'));
const TE = parse(block('TE'));
const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

eq('EN parsed', Object.keys(EN).length > 100, true);
const orphans = Object.keys(TE).filter((k) => !(k in EN));
eq('no Telugu key without an English one', orphans, []);
const mismatched = Object.keys(TE).filter((k) => vars(TE[k]) !== vars(EN[k]))
  .map((k) => `${k}: en {${vars(EN[k])}} te {${vars(TE[k])}}`);
eq('every Telugu string carries the same {placeholders} as its English', mismatched, []);
const untranslated = Object.keys(EN).filter((k) => !(k in TE));
eq('every string has a Telugu version', untranslated, []);
const latinOnly = Object.entries(TE).filter(([k, v]) => !/[\u0C00-\u0C7F]/.test(v) && !['pay.method.upi'].includes(k)).map(([k]) => k);
eq('every Telugu string is actually in Telugu script', latinOnly, []);

console.log(fail ? `${fail} FAILED` : `ALL PASSED (${Object.keys(EN).length} strings, ${Object.keys(TE).length} in Telugu)`);
process.exit(fail ? 1 : 0);
