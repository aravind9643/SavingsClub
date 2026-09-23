-- 0017_allow_officers_open_period.sql
-- Allow president (in addition to cashier and accountant) to open contribution periods.

create or replace function open_period(p_month date)
returns contribution_periods
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_group uuid := current_group_id();
  v_cfg   groups;
  v_start date := date_trunc('month', p_month)::date;
  v_row   contribution_periods;
begin
  perform fn_assert_active_member();
  if current_role_of() not in ('cashier', 'accountant', 'president') then
    raise exception 'Only an officer may open a period'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_cfg from groups where id = v_group;

  insert into contribution_periods (group_id, period_month, due_date, grace_date, amount_paise)
  values (v_group, v_start, v_start + (v_cfg.due_day - 1),
          v_start + (v_cfg.grace_day - 1), v_cfg.monthly_contribution_paise)
  on conflict (group_id, period_month) do nothing
  returning * into v_row;

  if v_row.id is null then
    select * into v_row from contribution_periods
    where group_id = v_group and period_month = v_start;
  end if;
  return v_row;
end $$;
