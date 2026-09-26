/**
 * A savings group, as a test writes it.
 *
 * Wraps the RPCs in the vocabulary the app uses out loud -- `cashier.pays(x)`
 * rather than `rpc('record_contribution', {...})` -- so a scenario reads like
 * a description of what the group did, and a failure says which step.
 *
 * Nothing here bypasses a rule. Every call is the same RPC the screen calls,
 * as the same signed-in person, so a scenario that passes has been through
 * every role check, cap and RLS policy on the way.
 */

import { makeDriver } from './driver.mjs';

export const rupees = (n) => Math.round(n * 100);
export const asRupees = (paise) => (Number(paise) / 100).toFixed(2);

/** Today, in local time. Never toISOString(): that converts to UTC first. */
export function today(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function monthStart(offsetMonths = 0) {
  const d = new Date();
  d.setMonth(d.getMonth() + offsetMonths, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

let counter = 0;
const uniq = () => `${Date.now().toString(36)}${(counter++).toString(36)}`;

/* -------------------------------------------------------------- the actor */

class Member {
  constructor(club, user, name) {
    this.club = club;
    this.user = user;
    this.name = name;
    this.memberId = null;
  }

  get driver() { return this.club.driver; }

  /** Call any RPC as this person. The escape hatch for anything unwrapped. */
  rpc(fn, args = {}) {
    return this.driver.rpc(this.user, this.club.groupId, fn, args);
  }

  read(from, opts) {
    return this.driver.select(this.user, this.club.groupId, from, opts);
  }

  /**
   * Run something that SHOULD be refused, and fail loudly if it is allowed.
   * A test that only proves the happy path proves half of what matters.
   */
  async cannot(what, fn) {
    try {
      await fn();
    } catch (e) {
      return e.message;
    }
    throw new Error(`Expected to be refused: ${what} -- but it was allowed.`);
  }

  async whoAmI() {
    this.memberId = await this.rpc('current_member_id');
    return this.memberId;
  }

  // --- officers -----------------------------------------------------------

  takesJob(role) { return this.rpc('assign_role', { p_member_id: this.memberId, p_role: role }); }
  givesJob(other, role) { return this.rpc('assign_role', { p_member_id: other.memberId, p_role: role }); }

  setsRules(rules) { return this.rpc('update_config', rules); }

  opensMonth(month = monthStart()) { return this.rpc('open_period', { p_month: month }); }
  closesMonth(periodId) { return this.rpc('close_period', { p_period_id: periodId }); }

  async invites({ uses = 10, days = 7 } = {}) {
    const inv = await this.rpc('create_invite', { p_max_uses: uses, p_days_valid: days });
    return typeof inv === 'string' ? inv : inv.code;
  }

  async approves(person) {
    const pending = await this.rpc('pending_members');
    const row = (pending ?? []).find((p) => p.full_name === person.name);
    if (!row) throw new Error(`${person.name} is not waiting for approval`);
    await this.rpc('approve_pending_member', { p_member_id: row.id });
    person.memberId = row.id;
    return row.id;
  }

  /** A member with no login -- the app supports these. */
  async addsMemberOnPaper(name) {
    const row = await this.rpc('add_member', { p_full_name: name });
    const m = new Member(this.club, null, name);
    m.memberId = row.id ?? row;
    this.club.members.push(m);
    return m;
  }

  // --- money in -----------------------------------------------------------

  takesPayment(from, paise, opts = {}) {
    return this.rpc('record_contribution', {
      p_period_id: opts.periodId ?? this.club.periodId,
      p_member_id: from.memberId,
      p_amount_paise: paise,
      p_paid_on: opts.on ?? today(),
      p_method: opts.method ?? 'bank',
    });
  }

  recordsCash(direction, paise, purpose, opts = {}) {
    return this.rpc('record_cash_movement', {
      p_direction: direction,
      p_amount_paise: paise,
      p_purpose: purpose,
      p_report_now: opts.reportNow ?? true,
    });
  }

  checksBank(closingPaise, opts = {}) {
    return this.rpc('record_bank_statement', {
      p_as_of: opts.on ?? today(),
      p_closing_balance_paise: closingPaise,
    });
  }

  // --- loans --------------------------------------------------------------

  asksToBorrow(paise, { from: guarantor, months = 6, why = 'test' }) {
    return this.rpc('request_loan', {
      p_guarantor_id: guarantor.memberId,
      p_principal_paise: paise,
      p_term_months: months,
      p_purpose: why,
    });
  }

  votesOnLoan(loanId, vote = 'approve') {
    return this.rpc('cast_loan_vote', { p_loan_id: loanId, p_vote: vote });
  }

  paysOutLoan(loanId, opts = {}) {
    return this.rpc('disburse_loan', {
      p_loan_id: loanId,
      p_disbursed_on: opts.on ?? today(),
      p_method: opts.method ?? 'bank',
    });
  }

  takesRepayment(loanId, { principal = 0, interest = 0, penalty = 0, on } = {}) {
    return this.rpc('record_repayment', {
      p_loan_id: loanId,
      p_principal_paise: principal,
      p_interest_paise: interest,
      p_penalty_paise: penalty,
      p_paid_on: on ?? today(),
    });
  }

  writesOffLoan(loanId, why = 'uncollectable') {
    return this.rpc('write_off_loan', { p_loan_id: loanId, p_reason: why });
  }

  recordsRecovery(loanId, { principal = 0, interest = 0, on } = {}) {
    return this.rpc('record_recovery', {
      p_loan_id: loanId,
      p_principal_paise: principal,
      p_interest_paise: interest,
      p_paid_on: on ?? today(),
    });
  }

  // --- spending -----------------------------------------------------------

  asksToSpend(paise, description, category = 'trip') {
    return this.rpc('propose_expense', {
      p_category: category,
      p_description: description,
      p_amount_paise: paise,
    });
  }

  votesOnExpense(expenseId, vote = 'approve') {
    return this.rpc('cast_expense_vote', { p_expense_id: expenseId, p_vote: vote });
  }

  // --- leaving, sharing out, meetings --------------------------------------

  paysOut(person, opts = {}) {
    return this.rpc('pay_out_member', {
      p_member_id: person.memberId,
      p_amount_paise: opts.paise ?? null,
      p_kind: opts.kind ?? 'exit',
    });
  }

  removes(person) { return this.rpc('remove_member', { p_member_id: person.memberId }); }

  proposesShareOut(kind = 'profit', paise = null) {
    return this.rpc('propose_distribution', { p_kind: kind, p_amount_paise: paise });
  }

  confirmsShareOut(id) { return this.rpc('confirm_distribution', { p_distribution_id: id }); }

  recordsMeeting(attendance, opts = {}) {
    const map = {};
    for (const [m, status] of attendance) map[m.memberId] = status;
    return this.rpc('record_meeting', {
      p_held_on: opts.on ?? today(),
      p_attendance: map,
      p_note: opts.note ?? null,
    });
  }

  // --- reading ------------------------------------------------------------

  async fund() {
    const [row] = await this.read('v_fund_summary');
    return row;
  }

  loans() { return this.read('v_loan_status'); }
  positions() { return this.read('v_member_positions'); }
  unpaid() { return this.read('v_unpaid_contributions'); }
  expenses() { return this.read('v_expense_status'); }
  reminders() { return this.read('v_reminders'); }

  exportsEverything() { return this.rpc('export_group_data'); }
}

/* ---------------------------------------------------------------- the club */

export class Club {
  constructor(driver) {
    this.driver = driver;
    this.groupId = null;
    this.periodId = null;
    this.members = [];
  }

  static async open(target, opts) {
    return new Club(await makeDriver(target, opts));
  }

  /** The founder creates the group and becomes its admin. */
  async founded(by, groupName = 'Test Group') {
    const email = `${by.toLowerCase().replace(/\W+/g, '')}.${uniq()}@test.invalid`;
    const user = await this.driver.createUser(email);
    const founder = new Member(this, user, by);

    const group = await this.driver.rpc(user, null, 'create_group', {
      p_group_name: groupName,
      p_full_name: by,
    });
    this.groupId = group.id ?? group;
    await founder.whoAmI();
    this.members.push(founder);
    return founder;
  }

  /** Someone joins with a code and waits for approval. */
  async joins(name, code) {
    const email = `${name.toLowerCase().replace(/\W+/g, '')}.${uniq()}@test.invalid`;
    const user = await this.driver.createUser(email);
    const m = new Member(this, user, name);
    await this.driver.rpc(user, null, 'join_group_with_code', {
      p_code: code,
      p_full_name: name,
    });
    this.members.push(m);
    return m;
  }

  /** Founder + n approved members with the two money offices filled. */
  async withMembers(names, { monthly = rupees(1000), ...rules } = {}) {
    const [first, ...rest] = names;
    const admin = await this.founded(first);
    const code = await admin.invites();

    const joined = [];
    for (const n of rest) {
      const m = await this.joins(n, code);
      await admin.approves(m);
      await m.whoAmI();
      joined.push(m);
    }

    if (joined[0]) await admin.givesJob(joined[0], 'cashier');
    if (joined[1]) await admin.givesJob(joined[1], 'accountant');

    await admin.setsRules({ p_monthly_contribution_paise: monthly, ...rules });
    return { admin, cashier: joined[0], accountant: joined[1], everyone: [admin, ...joined] };
  }

  async openMonth(officer, month = monthStart()) {
    const p = await officer.opensMonth(month);
    this.periodId = p.id ?? p;
    return this.periodId;
  }

  /** Local only: move a loan's dates back so arrears can be exercised. */
  age(loanId, days) {
    return this.driver.raw(
      `update loans
         set disbursed_on = current_date - $2::int,
             due_on = (current_date - $2::int + interval '6 months')::date,
             requested_at = now() - ($2::int + 1) * interval '1 day'
       where id = $1`,
      [loanId, days],
    ).then(() => this.driver.raw('select fn_build_loan_schedule($1)', [loanId]));
  }

  close() { return this.driver.close(); }
}

export { Member };
