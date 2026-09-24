-- 0033_deterministic_role.sql
--
-- role_of() could return a DIFFERENT ANSWER for the same data.
--
-- Found by running the migrations against a real Postgres for the first time.
-- No amount of reading the SQL would have shown it, because the bug is not in
-- what the query says -- it is in what the query leaves unsaid.
--
-- THE DEFECT
--
--   order by ra.start_date desc limit 1
--
-- When a member holds two jobs that started on the SAME DAY, start_date does
-- not break the tie, so the row returned is whichever the planner happens to
-- reach first. Demonstrated directly: the same member, the same two rows, gave
-- 'admin' one moment and 'cashier' the next, purely because the rows were
-- physically reordered in between.
--
-- WHY THIS IS REACHABLE, NOT THEORETICAL
--
-- assign_role() only forbids cashier + accountant on one person -- correctly,
-- since that is the separation that matters. Admin + cashier is deliberately
-- allowed, and in a small group it is the NORMAL arrangement: there are not
-- five people to go round. A group set up in a single sitting gives both jobs
-- the same start_date, which is exactly the tie.
--
-- WHAT IT COSTS
--
-- current_role_of() is the gate on almost every RPC in this app. A cashier
-- whose role resolves to 'admin' is refused when recording a payment; an admin
-- resolving to 'cashier' is allowed to handle money the group never gave them
-- charge of. The same person, the same permissions, a different answer between
-- two requests -- and no error message that would ever point here.
--
-- THE FIX
--
-- Order by authority, not by date. When someone holds several jobs, the
-- most-privileged one is the honest answer: it is what they can actually do.
-- start_date stays as the second key so a genuine later appointment still wins
-- among equals, and the id is a final tiebreak so the result is total --
-- never again dependent on physical row order.

create or replace function role_of(p_member_id uuid)
returns role_enum
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    (select ra.role from role_assignments ra
     where ra.member_id = p_member_id
       and ra.role <> 'member'
       and ra.start_date <= current_date
       and (ra.end_date is null or ra.end_date > current_date)
     order by
       -- Most authority first. Cashier and accountant outrank admin here
       -- because they are the money-handling jobs: if someone holds one of
       -- them, that is the capability that governs what they may do.
       case ra.role
         when 'cashier'    then 1
         when 'accountant' then 2
         when 'admin'      then 3
         else 4
       end,
       ra.start_date desc,
       ra.id
     limit 1),
    'member'::role_enum)
$$;
