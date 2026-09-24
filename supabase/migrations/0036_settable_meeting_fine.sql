-- 0036_settable_meeting_fine.sql
--
-- 0030 added a meeting fine that nothing could ever set.
--
-- groups.meeting_absent_fee_paise was created with a default of 0, and writes
-- to `groups` are RPC-only -- correctly. But update_config() was never given a
-- parameter for it, so the column could only ever hold its default. The
-- feature was unreachable from the app: every meeting would record a fine of
-- zero, forever, with no way to say otherwise.
--
-- Found by running the migrations rather than reading them. The fixture tried
-- `update groups set meeting_absent_fee_paise = ...` and was refused -- which
-- is the RPC-only rule working exactly as designed, and is precisely what made
-- the missing parameter visible.
--
-- ADDING A PARAMETER IS SAFE HERE, WITH ONE CAVEAT
--
-- Every argument has a default, so existing callers are unaffected. But
-- CREATE OR REPLACE FUNCTION matches on (name, argument types), and adding an
-- argument makes a NEW function rather than replacing the old one -- leaving
-- two overloads, and ambiguity for any caller using named arguments. The old
-- signature is therefore dropped first, explicitly.

drop function if exists update_config(
  text, bigint, int, int, bigint, int, int, int, int, int, int, int, int,
  bigint, int, boolean
);

create or replace function update_config(
  p_group_name text default null,
  p_monthly_contribution_paise bigint default null,
  p_due_day int default null,
  p_grace_day int default null,
  p_late_fee_paise bigint default null,
  p_loan_rate_bp int default null,
  p_overdue_rate_bp int default null,
  p_max_loan_months int default null,
  p_max_loan_pct_bp int default null,
  p_reserve_pct_bp int default null,
  p_loan_required_approvals int default null,
  p_expense_required_approvals int default null,
  p_expense_annual_pct_bp int default null,
  p_cash_float_limit_paise bigint default null,
  p_cash_report_hours int default null,
  p_setup_complete boolean default null,
  p_meeting_absent_fee_paise bigint default null
) returns groups
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row groups;
begin
  perform fn_assert_active_member();
  if current_role_of() not in ('cashier', 'accountant', 'admin') then
    raise exception 'Only the cashier, accountant or admin may change the group rules'
      using errcode = 'insufficient_privilege';
  end if;

  if p_monthly_contribution_paise is not null and p_monthly_contribution_paise <= 0 then
    raise exception 'The monthly amount must be more than zero'
      using errcode = 'check_violation';
  end if;
  if p_due_day is not null and p_due_day not between 1 and 28 then
    raise exception 'The pay-by day must be between 1 and 28'
      using errcode = 'check_violation';
  end if;
  if p_grace_day is not null and p_grace_day not between 1 and 28 then
    raise exception 'The late-after day must be between 1 and 28'
      using errcode = 'check_violation';
  end if;
  if p_late_fee_paise is not null and p_late_fee_paise < 0 then
    raise exception 'The late fee cannot be less than zero'
      using errcode = 'check_violation';
  end if;
  if p_loan_rate_bp is not null and p_loan_rate_bp < 0 then
    raise exception 'The interest rate cannot be less than zero'
      using errcode = 'check_violation';
  end if;
  if p_overdue_rate_bp is not null and p_overdue_rate_bp < 0 then
    raise exception 'The late interest rate cannot be less than zero'
      using errcode = 'check_violation';
  end if;
  if p_max_loan_months is not null and p_max_loan_months < 1 then
    raise exception 'A loan must run for at least one month'
      using errcode = 'check_violation';
  end if;
  if p_cash_report_hours is not null and p_cash_report_hours < 1 then
    raise exception 'The group must be told within at least one hour'
      using errcode = 'check_violation';
  end if;
  if p_cash_float_limit_paise is not null and p_cash_float_limit_paise < 0 then
    raise exception 'The cash limit cannot be less than zero'
      using errcode = 'check_violation';
  end if;
  if p_meeting_absent_fee_paise is not null and p_meeting_absent_fee_paise < 0 then
    raise exception 'The meeting fine cannot be less than zero'
      using errcode = 'check_violation';
  end if;
  if p_loan_required_approvals is not null and p_loan_required_approvals < 0 then
    raise exception 'The number of yes votes cannot be less than zero'
      using errcode = 'check_violation';
  end if;
  if p_expense_required_approvals is not null and p_expense_required_approvals < 0 then
    raise exception 'The number of yes votes cannot be less than zero'
      using errcode = 'check_violation';
  end if;

  update groups set
    name = coalesce(nullif(btrim(p_group_name), ''), name),
    monthly_contribution_paise =
      coalesce(p_monthly_contribution_paise, monthly_contribution_paise),
    due_day                   = coalesce(p_due_day, due_day),
    grace_day                 = coalesce(p_grace_day, grace_day),
    late_fee_paise            = coalesce(p_late_fee_paise, late_fee_paise),
    loan_rate_bp              = coalesce(p_loan_rate_bp, loan_rate_bp),
    overdue_rate_bp           = coalesce(p_overdue_rate_bp, overdue_rate_bp),
    max_loan_months           = coalesce(p_max_loan_months, max_loan_months),
    max_loan_pct_bp           = coalesce(p_max_loan_pct_bp, max_loan_pct_bp),
    reserve_pct_bp            = coalesce(p_reserve_pct_bp, reserve_pct_bp),
    loan_required_approvals   =
      coalesce(p_loan_required_approvals, loan_required_approvals),
    expense_required_approvals =
      coalesce(p_expense_required_approvals, expense_required_approvals),
    expense_annual_pct_bp     = coalesce(p_expense_annual_pct_bp, expense_annual_pct_bp),
    cash_float_limit_paise    = coalesce(p_cash_float_limit_paise, cash_float_limit_paise),
    cash_report_hours         = coalesce(p_cash_report_hours, cash_report_hours),
    setup_complete            = coalesce(p_setup_complete, setup_complete),
    meeting_absent_fee_paise  =
      coalesce(p_meeting_absent_fee_paise, meeting_absent_fee_paise)
  where id = current_group_id()
  returning * into v_row;

  return v_row;
end $$;
