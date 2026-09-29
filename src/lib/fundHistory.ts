/**
 * The fund month by month, from the ledger itself.
 *
 * The Home chart used to be drawn from today's total times a straight-line
 * fraction, with "interest" set to a flat 5% of that. It was a smooth curve
 * the group never had, on the screen members open most.
 *
 * This rebuilds the fund from the same five parts fn_fund_total_paise() sums
 * (0037), each dated by when the money actually moved:
 *
 *   opening balances           the base -- they belong to no month (0028)
 *   + contributions            amount + late fee, by paid_on
 *   + interest received        interest + penalty, by loan_repayments.paid_on
 *   - expenses paid            status 'paid' only, by paid_on
 *   - payouts                  by paid_on
 *
 * and returns the running total at each month end. The caller must check the
 * last point against the server's own total_fund_paise before drawing it:
 * if they differ, one of these definitions has drifted from the SQL, and a
 * chart that disagrees with the headline figure above it is worse than none.
 */

export interface LedgerRows {
  openings: { member_id: string; opening_balance_paise: number | null }[];
  contributions: { member_id: string; amount_paise: number; late_fee_paise: number; paid_on: string }[];
  repayments: { interest_paise: number; penalty_paise: number; paid_on: string }[];
  expenses: { amount_paise: number; status: string; paid_on: string | null }[];
  payouts: { amount_paise: number; paid_on: string }[];
}

export interface HistoryPoint {
  /** YYYY-MM */
  month: string;
  /** Opening + contributions - expenses - payouts, cumulative. */
  capital: number;
  /** Interest and penalties received, cumulative. */
  interest: number;
}

export interface FundHistory {
  points: HistoryPoint[];
  /** capital + interest at the end: must equal total_fund_paise. */
  total: number;
  /** Every member's stake -- contributions (with late fees) + opening -- for
      the pro-rata split of interest, the same rule as member_share_paise(). */
  stakes: Map<string, number>;
  totalInterest: number;
}

const n = (v: number | string | null | undefined) => Number(v ?? 0);
const monthOf = (d: string) => d.slice(0, 7);

function add(map: Map<string, number>, ym: string, v: number): void {
  map.set(ym, (map.get(ym) ?? 0) + v);
}

function nextMonth(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

export function buildFundHistory(rows: LedgerRows, thisMonth: string): FundHistory {
  const capitalDelta = new Map<string, number>();
  const interestDelta = new Map<string, number>();

  const stakes = new Map<string, number>();
  const stake = (id: string, v: number) => stakes.set(id, (stakes.get(id) ?? 0) + v);

  let opening = 0;
  for (const o of rows.openings) {
    const v = n(o.opening_balance_paise);
    opening += v;
    if (v) stake(o.member_id, v);
  }
  for (const c of rows.contributions) {
    const v = n(c.amount_paise) + n(c.late_fee_paise);
    add(capitalDelta, monthOf(c.paid_on), v);
    stake(c.member_id, v);
  }
  let totalInterest = 0;
  for (const r of rows.repayments) {
    const v = n(r.interest_paise) + n(r.penalty_paise);
    if (!v) continue;
    add(interestDelta, monthOf(r.paid_on), v);
    totalInterest += v;
  }
  for (const e of rows.expenses) {
    // An expense that is approved but not paid has not left the fund.
    if (e.status !== 'paid' || !e.paid_on) continue;
    add(capitalDelta, monthOf(e.paid_on), -n(e.amount_paise));
  }
  for (const p of rows.payouts) add(capitalDelta, monthOf(p.paid_on), -n(p.amount_paise));

  // A fresh array, so sorting it in place touches nothing else.
  // oxlint-disable-next-line unicorn/no-array-sort
  const months = [...capitalDelta.keys(), ...interestDelta.keys()].sort();
  const points: HistoryPoint[] = [];
  let capital = opening;
  let interest = 0;
  if (months.length) {
    // Every month from the first movement to now, including quiet ones: a
    // month with no activity is a flat step, not a gap the line skips over.
    const last = thisMonth > months[months.length - 1] ? thisMonth : months[months.length - 1];
    for (let ym = months[0]; ym <= last; ym = nextMonth(ym)) {
      capital += capitalDelta.get(ym) ?? 0;
      interest += interestDelta.get(ym) ?? 0;
      points.push({ month: ym, capital, interest });
    }
  }
  return { points, total: capital + interest, stakes, totalInterest };
}

/**
 * This member's slice of the interest earned, by the pro-rata rule the group
 * can check by hand: interest x (their stake / everyone's stake). BigInt
 * because interest x stake can pass 2^53 in a large group, and truncation
 * rounds toward the fund -- the group is never short by a rounding rule.
 */
export function interestShare(history: FundHistory, memberId: string): number {
  const all = [...history.stakes.values()].reduce((s, v) => s + v, 0);
  const mine = history.stakes.get(memberId) ?? 0;
  if (all <= 0 || mine <= 0 || history.totalInterest <= 0) return 0;
  return Number((BigInt(history.totalInterest) * BigInt(mine)) / BigInt(all));
}
