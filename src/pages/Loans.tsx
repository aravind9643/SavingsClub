import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Screen } from '../App';
import { supabase } from '../lib/supabase';
import { useQuery } from '../hooks/useQuery';
import { formatPaiseShort } from '../lib/money';
import { useSession } from '../context/SessionContext';
import {
  List, Row, Empty, SkeletonList, Segments, Notice, Tag, initials, fmtDate, toneForStatus, labelForStatus,
} from '../components/ui';
import { IconPlus, IconLoans } from '../components/icons';
import type { LoanRow } from '../lib/types';

type Filter = 'all' | 'voting' | 'active' | 'done';

export default function Loans() {
  const nav = useNavigate();
  const { currentGroupId } = useSession();
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');

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

  const qClean = search.trim().toLowerCase();
  const filtered = shown.filter((l) => {
    if (!qClean) return true;
    const nameMatch = l.borrower_name?.toLowerCase().includes(qClean);
    const outsideMatch = l.is_outside_borrower && l.outside_borrower_name?.toLowerCase().includes(qClean);
    const guarantorMatch = l.guarantor_name?.toLowerCase().includes(qClean);
    const purposeMatch = l.purpose?.toLowerCase().includes(qClean);
    return Boolean(nameMatch || outsideMatch || guarantorMatch || purposeMatch);
  });

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

        {/* Search input */}
        <div style={{ position: 'relative', margin: '10px 0 6px' }}>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search loan by borrower or guarantor..."
            style={{
              paddingLeft: 36,
              paddingRight: search ? 36 : 14,
              minHeight: 40,
              fontSize: '0.86rem',
              borderRadius: 'var(--r-sm)',
              border: '1px solid var(--hairline)',
              background: 'var(--surface)',
            }}
          />
          <span
            style={{
              position: 'absolute',
              left: 12,
              top: '50%',
              transform: 'translateY(-50%)',
              color: 'var(--text-3)',
              pointerEvents: 'none',
              fontSize: '0.88rem',
            }}
          >
            🔍
          </span>
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              style={{
                position: 'absolute',
                right: 8,
                top: '50%',
                transform: 'translateY(-50%)',
                background: 'transparent',
                border: 0,
                padding: '4px 8px',
                color: 'var(--text-3)',
                fontSize: '0.85rem',
                cursor: 'pointer',
              }}
            >
              ✕
            </button>
          )}
        </div>

        {voting.some((l) => l.can_i_vote) && filter !== 'done' && (
          <div style={{ marginTop: 8 }}>
            <Notice tone="warn" onClick={() => nav(`/loans/${voting.find((l) => l.can_i_vote)!.id}`)}>
              <strong>Action needed:</strong> You have {voting.filter((l) => l.can_i_vote).length === 1 ? '1 loan request waiting for your vote' : `${voting.filter((l) => l.can_i_vote).length} loan requests waiting for your vote`}.
            </Notice>
          </div>
        )}

        {q.loading && !q.data ? (
          <SkeletonList rows={5} />
        ) : filtered.length === 0 ? (
          <Empty icon={<IconLoans width={22} height={22} />}>
            {search
              ? `No loans match "${search}"`
              : filter === 'all'
              ? 'No loans yet. Tap the button below to request one.'
              : 'Nothing here right now.'}
          </Empty>
        ) : (
          <List>
            {filtered.map((l) => {
              const repaidPct = l.principal_paise > 0
                ? Math.min(100, Math.max(0, Math.round((l.principal_paid_paise / l.principal_paise) * 100)))
                : 0;
              const isDisbursed = l.status === 'disbursed';

              return (
                <Row
                  key={l.id}
                  icon={initials(l.borrower_name)}
                  iconTone={l.is_overdue ? 'coral'
                    : toneForStatus(l.status, l.withdrawn_by_requester)}
                  title={
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      <span>{l.borrower_name}</span>
                      {l.is_outside_borrower && <Tag tone="amber">Outside</Tag>}
                    </span>
                  }
                  sub={
                    isDisbursed ? (
                      <div>
                        <span>
                          {l.is_overdue
                            ? l.arrears_paise > 0
                              ? `${formatPaiseShort(l.arrears_paise)} behind`
                              : `Overdue by ${l.days_overdue} days`
                            : `Next ${fmtDate(l.next_due_on ?? l.due_on)} · ${repaidPct}% repaid`}
                          {l.is_outside_borrower && ` · Vouched by ${l.guarantor_name}`}
                        </span>
                        <div
                          style={{
                            marginTop: 5,
                            height: 4,
                            width: '100%',
                            maxWidth: 150,
                            background: 'var(--surface-sunken)',
                            borderRadius: 2,
                            overflow: 'hidden',
                          }}
                        >
                          <div
                            style={{
                              width: `${repaidPct}%`,
                              height: '100%',
                              background: repaidPct >= 100
                                ? 'var(--mint)'
                                : 'linear-gradient(90deg, var(--mint), var(--violet))',
                              borderRadius: 2,
                            }}
                          />
                        </div>
                      </div>
                    ) : l.status === 'requested'
                      ? `${l.approvals} of ${l.required_approvals} approvals${l.can_i_vote ? ' · your vote needed' : ''}${l.is_outside_borrower ? ` · Vouched by ${l.guarantor_name}` : ''}`
                      : `${labelForStatus(l.status, l.withdrawn_by_requester)}${l.is_outside_borrower ? ` · Vouched by ${l.guarantor_name}` : ''}`
                  }
                  amount={formatPaiseShort(
                    isDisbursed ? l.outstanding_principal_paise : l.principal_paise,
                  )}
                  amountTone={l.is_overdue ? 'coral' : undefined}
                  note={isDisbursed
                    ? 'still to repay'
                    : labelForStatus(l.status, l.withdrawn_by_requester)}
                  onClick={() => nav(`/loans/${l.id}`)}
                  chevron
                />
              );
            })}
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
