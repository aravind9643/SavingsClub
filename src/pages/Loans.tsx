import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Screen } from '../App';
import { supabase } from '../lib/supabase';
import { useQuery } from '../hooks/useQuery';
import { formatPaiseShort } from '../lib/money';
import { useSession } from '../context/SessionContext';
import {
  List, Row, Empty, SkeletonList, Segments, initials, fmtDate, toneForStatus,
} from '../components/ui';
import { IconPlus, IconLoans } from '../components/icons';
import type { LoanRow } from '../lib/types';

type Filter = 'all' | 'voting' | 'active' | 'done';

export default function Loans() {
  const nav = useNavigate();
  const { currentGroupId } = useSession();
  const [filter, setFilter] = useState<Filter>('all');

  const q = useQuery<LoanRow[]>('loans', async () => {
    let query = supabase
      .from('v_loan_status').select('*').order('requested_at', { ascending: false });
    if (currentGroupId) query = query.eq('group_id', currentGroupId);
    const { data, error } = await query;
    if (error) throw error;
    return (data ?? []) as LoanRow[];
  });

  const all = q.data ?? [];
  const voting = all.filter((l) => l.status === 'requested');
  const active = all.filter((l) => l.status === 'approved' || l.status === 'disbursed');
  const done = all.filter((l) =>
    l.status === 'closed' || l.status === 'rejected' || l.status === 'written_off');

  const shown =
    filter === 'voting' ? voting : filter === 'active' ? active : filter === 'done' ? done : all;

  return (
    <>
      <Screen title="Loans" sub={`${active.length} running`}>
        <Segments<Filter>
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: 'All', count: all.length },
            { value: 'voting', label: 'Voting', count: voting.length },
            { value: 'active', label: 'Running', count: active.length },
            { value: 'done', label: 'Finished', count: done.length },
          ]}
        />

        {q.loading && !q.data ? (
          <SkeletonList rows={5} />
        ) : shown.length === 0 ? (
          <Empty icon={<IconLoans width={22} height={22} />}>
            {filter === 'all'
              ? 'No loans yet. Tap the button below to request one.'
              : 'Nothing here right now.'}
          </Empty>
        ) : (
          <List>
            {shown.map((l) => (
              <Row
                key={l.id}
                icon={initials(l.borrower_name)}
                iconTone={l.is_overdue ? 'coral' : toneForStatus(l.status)}
                title={l.borrower_name}
                sub={
                  l.status === 'requested'
                    ? `${l.approvals} of ${l.required_approvals} approvals${l.can_i_vote ? ' · your vote needed' : ''}`
                    : l.is_overdue
                      ? `Overdue by ${l.days_overdue} days`
                      : l.status === 'disbursed'
                        ? `Due ${fmtDate(l.due_on)}`
                        : l.status
                }
                amount={formatPaiseShort(
                  l.status === 'disbursed' ? l.outstanding_principal_paise : l.principal_paise,
                )}
                amountTone={l.is_overdue ? 'coral' : undefined}
                note={l.status === 'disbursed' ? 'outstanding' : l.status}
                onClick={() => nav(`/loans/${l.id}`)}
                chevron
              />
            ))}
          </List>
        )}
      </Screen>

      <button className="fab" onClick={() => nav('/loans/new')}>
        <IconPlus width={18} height={18} />
        Request
      </button>
    </>
  );
}
