-- 0032_reminders_and_export.sql
--
-- Two gaps that are about trust rather than arithmetic.
--
-- 1. NOTHING EVER REACHED THE MEMBER
--
-- There was no notification path of any kind. A member learned they owed money
-- by opening the app -- which most members of a group like this will not do.
-- They will read WhatsApp.
--
-- This migration does NOT add a message-sending service. Sending SMS or
-- WhatsApp needs a provider, credentials and per-message money, and choosing
-- those is the group's decision, not the app's. What it adds is the part that
-- has to live in the database either way: WHO should be told WHAT, computed
-- once, server-side, from the same figures the screens use.
--
-- The app can then render that as a WhatsApp message the cashier forwards by
-- hand -- which is what these groups already do, and which needs no provider,
-- no credentials and no monthly bill. If a sender is added later it reads the
-- same table.
--
-- 2. THE GROUP COULD NOT TAKE ITS OWN BOOKS WITH IT
--
-- Export existed per screen as CSV. There was no "give me everything" -- for a
-- group that wants to leave, or the treasurer who wants a copy before the AGM.
-- For an app holding a group's entire financial history that is a trust
-- problem, and the answer to "can we get our data out" must be yes without
-- anyone having to ask us.

create type reminder_kind_enum as enum (
  'contribution_due', 'contribution_overdue', 'loan_instalment_due',
  'loan_overdue', 'meeting'
);

-- ---------------------------------------------------------------------------
-- Who needs telling what, right now.
--
-- A view rather than a table: the answer is derivable from the ledger, and a
-- stored copy would be a second place for the truth to live. The app reads
-- this, formats it, and the cashier sends it.
-- ---------------------------------------------------------------------------
create or replace view v_reminders
with (security_invoker = true) as
-- Money owed for a month, including part payments -- the shortfall, not the
-- whole amount, because telling someone who has paid half that they owe the
-- full sum is how a group loses faith in the app.
select
  u.member_id,
  u.group_id,
  u.full_name,
  (case when u.is_overdue then 'contribution_overdue'
        else 'contribution_due' end)::reminder_kind_enum as kind,
  u.shortfall_paise                                       as amount_paise,
  u.grace_date                                            as due_on,
  to_char(u.period_month, 'Mon YYYY')                     as subject
from v_unpaid_contributions u

union all

-- Loan instalments. This is the reminder that could not exist at all before
-- there was a schedule to be behind on.
select
  l.borrower_id,
  l.group_id,
  l.borrower_name,
  (case when l.arrears_paise > 0 then 'loan_overdue'
        else 'loan_instalment_due' end)::reminder_kind_enum,
  (case when l.arrears_paise > 0 then l.arrears_paise
        else coalesce((select i.principal_paise from loan_instalments i
                       where i.loan_id = l.id and i.due_on > current_date
                       order by i.due_on limit 1), 0) end),
  coalesce(l.next_due_on, l.due_on),
  'Loan repayment'
from v_loan_status l
where l.status = 'disbursed'
  and (l.arrears_paise > 0
       or l.next_due_on is not null and l.next_due_on <= current_date + 7);

grant select on v_reminders to authenticated;
revoke all on v_reminders from anon;

-- ---------------------------------------------------------------------------
-- A phone number to send it to.
--
-- Nullable, because a group can adopt this app without collecting everyone's
-- number first, and refusing to add a member until they supply one would stop
-- the app being usable on day one.
-- ---------------------------------------------------------------------------
alter table members
  add column if not exists phone text
    check (phone is null or phone ~ '^[0-9+][0-9 ()-]{6,19}$');

comment on column members.phone is
  'For sending reminders. Visible to the group, like every other member '
  'detail here -- these people meet in person every month.';

-- ---------------------------------------------------------------------------
-- export_group_data: everything, in one call.
--
-- Returns the group's whole ledger as JSON. Any active member may run it --
-- not just officers -- because "can we see our own books" is not a privilege
-- a group should have to grant. It reads only the group's own rows.
-- ---------------------------------------------------------------------------
create or replace function export_group_data()
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_group uuid := current_group_id();
  v_out   jsonb;
begin
  perform fn_assert_active_member();

  select jsonb_build_object(
    'exported_at', now(),
    'group', (select to_jsonb(g) from groups g where g.id = v_group),
    'members', (select coalesce(jsonb_agg(to_jsonb(m) order by m.full_name), '[]'::jsonb)
                from members m where m.group_id = v_group),
    'roles', (select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb)
              from role_assignments r where r.group_id = v_group),
    'periods', (select coalesce(jsonb_agg(to_jsonb(p) order by p.period_month), '[]'::jsonb)
                from contribution_periods p where p.group_id = v_group),
    'contributions', (select coalesce(jsonb_agg(to_jsonb(c) order by c.paid_on), '[]'::jsonb)
                      from contributions c where c.group_id = v_group),
    'loans', (select coalesce(jsonb_agg(to_jsonb(l) order by l.requested_at), '[]'::jsonb)
              from loans l where l.group_id = v_group),
    'loan_instalments', (select coalesce(jsonb_agg(to_jsonb(i) order by i.due_on), '[]'::jsonb)
                         from loan_instalments i where i.group_id = v_group),
    'loan_votes', (select coalesce(jsonb_agg(to_jsonb(v)), '[]'::jsonb)
                   from loan_votes v where v.group_id = v_group),
    'loan_repayments', (select coalesce(jsonb_agg(to_jsonb(rp) order by rp.paid_on), '[]'::jsonb)
                        from loan_repayments rp where rp.group_id = v_group),
    'expenses', (select coalesce(jsonb_agg(to_jsonb(e) order by e.incurred_on), '[]'::jsonb)
                 from expenses e where e.group_id = v_group),
    'expense_votes', (select coalesce(jsonb_agg(to_jsonb(ev)), '[]'::jsonb)
                      from expense_votes ev where ev.group_id = v_group),
    'cash_ledger', (select coalesce(jsonb_agg(to_jsonb(cl) order by cl.occurred_at), '[]'::jsonb)
                    from cash_ledger cl where cl.group_id = v_group),
    'bank_statements', (select coalesce(jsonb_agg(to_jsonb(bs)), '[]'::jsonb)
                        from bank_statements bs where bs.group_id = v_group),
    'payouts', (select coalesce(jsonb_agg(to_jsonb(mp) order by mp.paid_on), '[]'::jsonb)
                from member_payouts mp where mp.group_id = v_group),
    'distributions', (select coalesce(jsonb_agg(to_jsonb(d) order by d.proposed_at), '[]'::jsonb)
                      from distributions d where d.group_id = v_group),
    'distribution_lines', (select coalesce(jsonb_agg(to_jsonb(dl)), '[]'::jsonb)
                           from distribution_lines dl where dl.group_id = v_group),
    'meetings', (select coalesce(jsonb_agg(to_jsonb(mt) order by mt.held_on), '[]'::jsonb)
                 from meetings mt where mt.group_id = v_group),
    'meeting_attendance', (select coalesce(jsonb_agg(to_jsonb(ma)), '[]'::jsonb)
                           from meeting_attendance ma where ma.group_id = v_group),
    'summary', (select to_jsonb(f) from v_fund_summary f)
  ) into v_out;

  return v_out;
end $$;

revoke execute on function export_group_data() from public, anon;
grant execute on function export_group_data() to authenticated;
