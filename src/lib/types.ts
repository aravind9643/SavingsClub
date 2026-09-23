/** Shapes returned by the database views and RPCs. */

export type Role = 'member' | 'cashier' | 'accountant' | 'president';
export type Vote = 'approve' | 'reject' | 'abstain';
export type PaymentMethod = 'cash' | 'bank';
export type LoanStatus =
  | 'requested' | 'approved' | 'rejected' | 'disbursed' | 'closed' | 'written_off';
export type ExpenseStatus = 'proposed' | 'approved' | 'rejected' | 'paid';
export type ExpenseCategory =
  | 'trip' | 'party' | 'celebration' | 'bank_charge' | 'admin' | 'other';

export interface Member {
  id: string;
  auth_user_id: string | null;
  full_name: string;
  email: string | null;
  phone: string | null;
  joined_on: string;
  left_on: string | null;
  is_active: boolean;
  nominee_name: string | null;
  nominee_phone: string | null;
}

export type MemberStatus = 'pending' | 'active' | 'left';

/** A row of v_my_groups: one group this login belongs to. */
export interface MyGroup {
  id: string;
  name: string;
  setup_complete: boolean;
  member_id: string;
  role: Role;
  status: MemberStatus;
  is_current: boolean;
}

export interface GroupInvite {
  code: string;
  group_id: string;
  created_by: string;
  created_at: string;
  expires_at: string;
  max_uses: number | null;
  use_count: number;
  revoked_at: string | null;
}

export interface InvitePreview {
  group_name: string | null;
  member_count: number;
  valid: boolean;
  reason: string | null;
}

export interface PendingMember {
  id: string;
  full_name: string;
  email: string | null;
  joined_on: string;
}

export interface FundSummary {
  contributions_paise: number;
  interest_received_paise: number;
  expenses_paise: number;
  total_fund_paise: number;
  reserve_paise: number;
  lendable_paise: number;
  outstanding_paise: number;
  still_lendable_paise: number;
  per_member_cap_paise: number;
  cash_float_paise: number;
  cash_float_limit_paise: number;
  expected_bank_balance_paise: number;
  accrued_receivable_paise: number;
}

export interface MemberPosition {
  member_id: string;
  full_name: string;
  is_active: boolean;
  role: Role;
  contributed_paise: number;
  late_fees_paise: number;
  periods_paid: number;
  outstanding_paise: number;
  cap_paise: number;
  cap_breached: boolean;
  share_pct: number;
}

export interface LoanRow {
  id: string;
  borrower_id: string;
  borrower_name: string;
  guarantor_id: string;
  guarantor_name: string;
  principal_paise: number;
  purpose: string | null;
  rate_bp: number;
  overdue_rate_bp: number;
  term_months: number;
  status: LoanStatus;
  requested_at: string;
  disbursed_on: string | null;
  due_on: string | null;
  closed_on: string | null;
  required_approvals: number;
  eligible_voter_count: number;
  outstanding_principal_paise: number;
  accrued_interest_paise: number;
  accrued_penalty_paise: number;
  principal_paid_paise: number;
  interest_paid_paise: number;
  total_due_paise: number;
  days_overdue: number;
  is_overdue: boolean;
  approvals: number;
  rejections: number;
  can_i_vote: boolean;
  my_vote: Vote | null;
  /** True when the borrower withdrew, rather than the group refusing. */
  withdrawn_by_requester: boolean;
}

export interface ExpenseRow {
  id: string;
  category: ExpenseCategory;
  description: string;
  amount_paise: number;
  incurred_on: string;
  method: PaymentMethod;
  status: ExpenseStatus;
  requires_vote: boolean;
  required_approvals: number;
  eligible_voter_count: number;
  created_by: string;
  created_by_name: string;
  paid_on: string | null;
  approvals: number;
  rejections: number;
  can_i_vote: boolean;
  my_vote: Vote | null;
  /** True when the proposer withdrew, rather than the group refusing. */
  withdrawn_by_requester: boolean;
  is_loan_write_off: boolean;
}

export interface ContributionPeriod {
  id: string;
  period_month: string;
  due_date: string;
  grace_date: string;
  amount_paise: number;
  closed_at: string | null;
}

export interface Contribution {
  id: string;
  period_id: string;
  member_id: string;
  amount_paise: number;
  late_fee_paise: number;
  paid_on: string;
  method: PaymentMethod;
}

export interface UnpaidRow {
  period_id: string;
  period_month: string;
  due_date: string;
  grace_date: string;
  member_id: string;
  full_name: string;
  expected_paise: number;
  is_overdue: boolean;
}

export interface CashEntry {
  id: string;
  direction: 'in' | 'out';
  amount_paise: number;
  occurred_at: string;
  purpose: string;
  counterparty: string | null;
  reported_at: string | null;
  recorded_by: string;
}

export interface CashAlert extends CashEntry {
  recorded_by_name: string;
  reporting_breached: boolean;
  unreported: boolean;
}

export interface BankStatement {
  id: string;
  as_of: string;
  closing_balance_paise: number;
  expected_balance_paise: number;
  difference_paise: number;
  note: string | null;
  uploaded_by: string;
}

export interface AuditRow {
  id: number;
  occurred_at: string;
  actor_auth_id: string | null;
  actor_member_id: string | null;
  table_name: string;
  row_id: string;
  action: 'INSERT' | 'UPDATE' | 'DELETE';
  old_data: Record<string, unknown> | null;
  new_data: Record<string, unknown> | null;
  changed_keys: string[] | null;
}

/** A row of `groups`: the group's identity and its rule settings together. */
export interface AppConfig {
  id: string;
  name: string;
  created_at: string;
  archived_at: string | null;
  setup_complete: boolean;
  monthly_contribution_paise: number;
  due_day: number;
  grace_day: number;
  late_fee_paise: number;
  loan_rate_bp: number;
  overdue_rate_bp: number;
  max_loan_months: number;
  max_loan_pct_bp: number;
  reserve_pct_bp: number;
  loan_required_approvals: number;
  expense_required_approvals: number;
  expense_annual_pct_bp: number;
  cash_float_limit_paise: number;
  cash_report_hours: number;
}
