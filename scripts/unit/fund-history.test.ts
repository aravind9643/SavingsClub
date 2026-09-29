import { buildFundHistory, interestShare } from '../../src/lib/fundHistory.ts';

let fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) { fail++; console.log(`FAIL ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); }
};

const h = buildFundHistory({
  openings: [{ member_id: 'A', opening_balance_paise: 100000 }, { member_id: 'B', opening_balance_paise: null }],
  contributions: [
    { member_id: 'A', amount_paise: 50000, late_fee_paise: 0, paid_on: '2026-06-05' },
    { member_id: 'B', amount_paise: 50000, late_fee_paise: 2500, paid_on: '2026-06-20' },
    { member_id: 'B', amount_paise: 50000, late_fee_paise: 0, paid_on: '2026-08-03' },
  ],
  repayments: [{ interest_paise: 1000, penalty_paise: 333, paid_on: '2026-08-15' }],
  expenses: [
    { amount_paise: 7000, status: 'paid', paid_on: '2026-08-10' },
    { amount_paise: 9999, status: 'approved', paid_on: null },      // not left the fund
    { amount_paise: 5000, status: 'paid', paid_on: '2026-06-01' },
    { amount_paise: -2000, status: 'paid', paid_on: '2026-08-11' }, // write-off recovery (0031)
  ],
  payouts: [{ amount_paise: 10000, paid_on: '2026-09-01' }],
}, '2026-10');

// June: 100000 + 50000 + 52500 - 5000 = 197500
// July: quiet month, flat
// Aug:  +50000 - 7000 + 2000 = 242500 capital, 1333 interest
// Sep:  -10000 payout = 232500
// Oct:  quiet, carried to "now"
eq('points', h.points, [
  { month: '2026-06', capital: 197500, interest: 0 },
  { month: '2026-07', capital: 197500, interest: 0 },
  { month: '2026-08', capital: 242500, interest: 1333 },
  { month: '2026-09', capital: 232500, interest: 1333 },
  { month: '2026-10', capital: 232500, interest: 1333 },
]);
eq('total', h.total, 233833);

// Stakes: A = 100000 + 50000 = 150000; B = 52500 + 50000 = 102500; all 252500.
// A: floor(1333 * 150000 / 252500) = floor(791.88) = 791; B: floor(541.1) = 541
eq('share A', interestShare(h, 'A'), 791);
eq('share B', interestShare(h, 'B'), 541);
eq('shares never exceed interest', interestShare(h, 'A') + interestShare(h, 'B') <= 1333, true);
eq('unknown member', interestShare(h, 'Z'), 0);

// Year rollover
const y = buildFundHistory({ openings: [], contributions: [
  { member_id: 'A', amount_paise: 100, late_fee_paise: 0, paid_on: '2025-11-30' },
  { member_id: 'A', amount_paise: 100, late_fee_paise: 0, paid_on: '2026-01-02' },
], repayments: [], expenses: [], payouts: [] }, '2026-01');
eq('year rollover months', y.points.map((p) => p.month), ['2025-11', '2025-12', '2026-01']);

// Empty ledger
eq('empty', buildFundHistory({ openings: [], contributions: [], repayments: [], expenses: [], payouts: [] }, '2026-09').points, []);

// Large figures: 5e8 paise fund, interest x stake beyond 2^53 still exact
const big = buildFundHistory({ openings: [], contributions: [
  { member_id: 'A', amount_paise: 300000000, late_fee_paise: 0, paid_on: '2026-01-01' },
  { member_id: 'B', amount_paise: 200000000, late_fee_paise: 0, paid_on: '2026-01-01' },
], repayments: [{ interest_paise: 90000001, penalty_paise: 0, paid_on: '2026-02-01' }], expenses: [], payouts: [] }, '2026-02');
eq('big share A', interestShare(big, 'A'), 54000000); // floor(90000001*3/5) = 54000000.6 -> 54000000

console.log(fail ? `${fail} FAILED` : 'ALL PASSED');
process.exit(fail ? 1 : 0);
