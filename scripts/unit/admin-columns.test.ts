import { kindOf, toInput, fromInput } from '../../src/pages/admin/columns.ts';

let fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = Object.is(got, want) || JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fail++; console.log(`FAIL ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
};
const throws = (name: string, f: () => unknown) => {
  try { f(); fail++; console.log(`FAIL ${name}: did not throw`); } catch { /* ok */ }
};

// paise: the float traps
eq('10.10', fromInput('paise', 'a', '10.10'), 1010);
eq('0.29', fromInput('paise', 'a', '0.29'), 29);
eq('1.005 rejected? (3 dp)', (() => { try { return fromInput('paise', 'a', '1.005'); } catch { return 'threw'; } })(), 'threw');
eq('10.1 -> 1010', fromInput('paise', 'a', '10.1'), 1010);
eq('1,50,000', fromInput('paise', 'a', '1,50,000'), 15000000);
eq('-250.50', fromInput('paise', 'a', '-250.50'), -25050);
eq('empty -> null', fromInput('paise', 'a', '  '), null);
throws('abc', () => fromInput('paise', 'a', 'abc'));
throws('1e5', () => fromInput('paise', 'a', '1e5'));
throws('.5', () => fromInput('paise', 'a', '.5'));

// round trip for every paise value 0..100000 and some large ones
for (const p of [...Array.from({ length: 100001 }, (_, i) => i), -1, -99, -100, -12345, 500000000, 900719925474099]) {
  const back = fromInput('paise', 'a', toInput('paise', p));
  if (back !== p) { fail++; console.log(`FAIL round trip ${p} -> ${toInput('paise', p)} -> ${back}`); break; }
}

// ints / bp
eq('int', fromInput('int', 'a', '12'), 12);
throws('int 1.5', () => fromInput('int', 'a', '1.5'));
throws('bp 2%', () => fromInput('bp', 'a', '2%'));

// kinds
eq('pk readonly', kindOf('id', 'x', 'id', true), 'readonly');
eq('group_id readonly', kindOf('group_id', 'x', 'id', true), 'readonly');
eq('null paise', kindOf('late_fee_paise', null, 'id', true), 'paise');
eq('null _on', kindOf('left_on', null, 'id', true), 'date');
eq('bool', kindOf('setup_complete', true, 'id', true), 'bool');
eq('is_ null', kindOf('is_outside_borrower', null, 'id', true), 'bool');
eq('number', kindOf('due_day', 10, 'id', true), 'int');
eq('json', kindOf('new_data', { a: 1 }, 'id', true), 'json');
eq('not editable', kindOf('amount_paise', 5, 'id', false), 'readonly');
eq('code pk', kindOf('code', 'ABCD', 'code', true), 'readonly');

console.log(fail ? `${fail} FAILED` : 'ALL PASSED');
process.exit(fail ? 1 : 0);
