import { useState, useMemo } from 'react';
import { formatPaiseShort, formatPaise } from '../lib/money';

export interface GrowthPoint {
  label: string;
  month: string;
  capital: number;
  interest: number;
}

export function FundGrowthChart({
  points,
  mySharePct,
}: {
  points: GrowthPoint[];
  mySharePct?: number;
}) {
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);

  const data = useMemo(() => {
    if (!points || points.length === 0) return [];
    // Ensure chronological order
    const copy = [...points];
    copy.sort((a: GrowthPoint, b: GrowthPoint) => a.month.localeCompare(b.month));
    return copy;
  }, [points]);

  if (data.length < 2) {
    return null;
  }

  const activeIdx = selectedIdx !== null ? selectedIdx : data.length - 1;
  const activePt = data[activeIdx];

  const maxVal = Math.max(...data.map((d: GrowthPoint) => d.capital + d.interest), 1);
  const minVal = 0;

  // Chart dimensions
  const width = 360;
  const height = 150;
  const paddingX = 24;
  const paddingTop = 20;
  const paddingBottom = 30;

  const chartW = width - paddingX * 2;
  const chartH = height - paddingTop - paddingBottom;

  const getX = (idx: number) => paddingX + (idx / (data.length - 1)) * chartW;
  const getY = (val: number) => paddingTop + chartH - ((val - minVal) / (maxVal - minVal)) * chartH;

  // Generate SVG path for cumulative capital
  const coords = data.map((d: GrowthPoint, i: number) => ({ x: getX(i), y: getY(d.capital + d.interest) }));
  const dPath = coords.reduce((acc: string, pt: { x: number; y: number }, i: number) => {
    if (i === 0) return `M ${pt.x} ${pt.y}`;
    // Smooth bezier curve
    const prev = coords[i - 1];
    const cx = (prev.x + pt.x) / 2;
    return `${acc} C ${cx} ${prev.y}, ${cx} ${pt.y}, ${pt.x} ${pt.y}`;
  }, '');

  const areaPath = `${dPath} L ${coords[coords.length - 1].x} ${height - paddingBottom} L ${coords[0].x} ${height - paddingBottom} Z`;

  const firstVal = data[0].capital + data[0].interest;
  const lastVal = data[data.length - 1].capital + data[data.length - 1].interest;
  const growthPaise = lastVal - firstVal;
  const growthPct = firstVal > 0 ? Math.round((growthPaise / firstVal) * 100) : 100;

  // Calculate personal return if mySharePct is given
  const totalInterest = data[data.length - 1]?.interest ?? 0;
  const myEarnings = mySharePct ? Math.round((mySharePct / 100) * totalInterest) : 0;

  return (
    <div
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--hairline)',
        borderRadius: 'var(--r)',
        padding: '16px 14px 12px',
        margin: '14px 0',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            Fund Trajectory
          </div>
          <div style={{ fontSize: '1.25rem', fontWeight: 800, color: 'var(--text)', marginTop: 2 }}>
            {formatPaise(activePt.capital + activePt.interest)}
          </div>
          <div style={{ fontSize: '0.76rem', color: 'var(--text-3)', marginTop: 1 }}>
            {activePt.label} · {formatPaiseShort(activePt.interest)} interest earned
          </div>
        </div>

        <div style={{ textAlign: 'right' }}>
          <span
            style={{
              fontSize: '0.75rem',
              fontWeight: 700,
              padding: '3px 8px',
              borderRadius: 6,
              background: growthPaise >= 0 ? 'var(--mint-ghost)' : 'var(--coral-ghost)',
              color: growthPaise >= 0 ? 'var(--mint)' : 'var(--coral)',
            }}
          >
            {growthPaise >= 0 ? `+${growthPct}%` : `${growthPct}%`}
          </span>
          <div style={{ fontSize: '0.72rem', color: 'var(--text-3)', marginTop: 4 }}>
            {data.length} months track
          </div>
        </div>
      </div>

      {/* SVG chart */}
      <div style={{ width: '100%', overflow: 'hidden' }}>
        <svg
          viewBox={`0 0 ${width} ${height}`}
          style={{ width: '100%', height: 'auto', display: 'block', overflow: 'visible' }}
        >
          <defs>
            <linearGradient id="growthGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--mint)" stopOpacity="0.25" />
              <stop offset="100%" stopColor="var(--mint)" stopOpacity="0.0" />
            </linearGradient>
          </defs>

          {/* Grid lines */}
          <line
            x1={paddingX}
            y1={height - paddingBottom}
            x2={width - paddingX}
            y2={height - paddingBottom}
            stroke="var(--hairline)"
            strokeWidth="1"
          />

          {/* Area fill */}
          <path d={areaPath} fill="url(#growthGradient)" />

          {/* Trend line */}
          <path d={dPath} fill="none" stroke="var(--mint)" strokeWidth="2.5" strokeLinecap="round" />

          {/* Active selection vertical rule and dots */}
          {coords.map((pt: { x: number; y: number }, i: number) => {
            const isSelected = i === activeIdx;
            return (
              <g key={i} onClick={() => setSelectedIdx(i)} style={{ cursor: 'pointer' }}>
                {isSelected && (
                  <line
                    x1={pt.x}
                    y1={paddingTop}
                    x2={pt.x}
                    y2={height - paddingBottom}
                    stroke="var(--mint)"
                    strokeWidth="1.5"
                    strokeDasharray="2,2"
                    opacity="0.6"
                  />
                )}
                <circle
                  cx={pt.x}
                  cy={pt.y}
                  r={isSelected ? 5 : 3}
                  fill={isSelected ? 'var(--mint)' : 'var(--surface-3)'}
                  stroke={isSelected ? '#fff' : 'var(--mint)'}
                  strokeWidth={isSelected ? 2 : 1.5}
                />
                <text
                  x={pt.x}
                  y={height - 10}
                  fontSize="10"
                  textAnchor="middle"
                  fill={isSelected ? 'var(--text)' : 'var(--text-3)'}
                  fontWeight={isSelected ? '700' : '400'}
                >
                  {data[i].label}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      {/* Member Personal Return Badge */}
      {mySharePct && myEarnings > 0 && (
        <div
          style={{
            marginTop: 10,
            padding: '8px 12px',
            background: 'var(--surface-2)',
            borderRadius: 'var(--r-sm)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            fontSize: '0.8rem',
          }}
        >
          <span style={{ color: 'var(--text-2)' }}>
            Your Share of Fund Returns ({Number(mySharePct).toFixed(0)}%)
          </span>
          <span style={{ fontWeight: 700, color: 'var(--mint)' }}>
            +{formatPaiseShort(myEarnings)}
          </span>
        </div>
      )}
    </div>
  );
}
