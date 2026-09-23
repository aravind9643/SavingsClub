-- 0023_plain_error_messages.sql
--
-- Error text is UI. These strings land in a red box in front of a member who
-- was just told "no", so they are the worst place to spend jargon -- and the
-- only copy in the app that was still written for whoever wrote the SQL.
--
-- Two things change:
--
--   1. The 'president' role now displays as "Admin" everywhere in the app.
--      The ENUM VALUE deliberately stays 'president' so the database still
--      matches the group's signed agreement, and so every policy, role check
--      and audit row keeps working untouched. Only what a person reads moves.
--
--   2. "office holder" and "guarantor" are replaced with what they mean. A
--      member who does not know those words cannot act on a message built
--      from them.
--
-- No behaviour changes here at all: same checks, same errcodes, same order.

-- ---------------------------------------------------------------------------
-- release_role
-- ---------------------------------------------------------------------------
create or replace function release_role(p_role role_enum) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_group uuid := current_group_id();
begin
  perform fn_assert_active_member();
  if current_role_of() not in ('cashier', 'accountant', 'president') then
    raise exception 'Only the cashier, accountant or admin may change who does what'
      using errcode = 'insufficient_privilege';
  end if;
  -- A group must never be left headless: the admin hands over, never simply
  -- resigns.
  if p_role = 'president' then
    raise exception 'Make someone else the admin instead of leaving the job empty'
      using errcode = 'check_violation';
  end if;

  update role_assignments set end_date = current_date
  where group_id = v_group and role = p_role
    and end_date is null and start_date < current_date;

  delete from role_assignments
  where group_id = v_group and role = p_role
    and end_date is null and start_date >= current_date;
end $$;

-- ---------------------------------------------------------------------------
-- remove_member
-- ---------------------------------------------------------------------------
create or replace function remove_member(
  p_member_id uuid,
  p_left_on date default current_date
) returns members
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_group uuid := current_group_id();
  v_owed  bigint;
  v_row   members;
begin
  perform fn_assert_active_member();
  if current_role_of() not in ('cashier', 'accountant', 'president') then
    raise exception 'Only the cashier, accountant or admin may remove a member'
      using errcode = 'insufficient_privilege';
  end if;

  if role_of(p_member_id) = 'president' then
    raise exception 'Make someone else the admin before removing this person'
      using errcode = 'check_violation';
  end if;

  v_owed := member_outstanding_paise(p_member_id);
  if v_owed > 0 then
    raise exception 'This member still owes Rs.% — the loan must be settled first',
      (v_owed::numeric / 100)::text using errcode = 'check_violation';
  end if;

  if exists (select 1 from loans
             where guarantor_id = p_member_id and group_id = v_group
               and status in ('approved', 'disbursed')) then
    raise exception 'This member vouched for a running loan — someone else must take that on first'
      using errcode = 'check_violation';
  end if;

  update role_assignments set end_date = p_left_on
  where member_id = p_member_id and group_id = v_group and end_date is null;

  update members set left_on = p_left_on, status = 'left'
  where id = p_member_id and group_id = v_group and left_on is null
  returning * into v_row;

  if v_row.id is null then
    raise exception 'Member not found or already left' using errcode = 'no_data_found';
  end if;

  return v_row;
end $$;

-- ---------------------------------------------------------------------------
-- The remaining "office holder" messages, reworded the same way.
-- ---------------------------------------------------------------------------
create or replace function assign_role(p_member_id uuid, p_role role_enum)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_group uuid := current_group_id();
  v_other role_enum;
begin
  perform fn_assert_active_member();
  if current_role_of() not in ('cashier', 'accountant', 'president') then
    raise exception 'Only the cashier, accountant or admin may change who does what'
      using errcode = 'insufficient_privilege';
  end if;
  if p_role = 'member' then
    raise exception 'To clear a job, choose Nobody instead'
      using errcode = 'check_violation';
  end if;
  if not exists (select 1 from members
                 where id = p_member_id and group_id = v_group
                   and left_on is null and status = 'active') then
    raise exception 'That person is not an active member of this group'
      using errcode = 'check_violation';
  end if;

  -- The one rule that cannot bend: the person who takes the money in must not
  -- also be the person who keeps the record of it.
  v_other := case when p_role = 'cashier' then 'accountant'
                  when p_role = 'accountant' then 'cashier' end;
  if v_other is not null and exists (
    select 1 from role_assignments
    where member_id = p_member_id and group_id = v_group
      and role = v_other and end_date is null
  ) then
    raise exception
      'The cashier and the accountant must be two different people — move the other job first'
      using errcode = 'check_violation';
  end if;

  update role_assignments set end_date = current_date
  where group_id = v_group and role = p_role
    and end_date is null and start_date < current_date;

  delete from role_assignments
  where group_id = v_group and role = p_role
    and end_date is null and start_date >= current_date;

  insert into role_assignments (group_id, member_id, role, start_date)
  values (v_group, p_member_id, p_role, current_date);
end $$;

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
  p_setup_complete boolean default null
) returns groups
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row groups;
begin
  perform fn_assert_active_member();
  if current_role_of() not in ('cashier', 'accountant', 'president') then
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
    setup_complete            = coalesce(p_setup_complete, setup_complete)
  where id = current_group_id()
  returning * into v_row;

  return v_row;
end $$;
