import { useState } from 'react';
import { cents } from '@tylo/shared';

/* Categorical slots, validated for CVD separation on the dark surface.
   These are money/measure categories — deliberately NOT the map's
   demand/supply hues, and never the reserved status colours. */
export const SERIES = ['#3987e5', '#199e70', '#c98500', '#9085e9', '#e66767'];

const W = 560;
const H = 210;
const PAD = { l: 46, r: 14, t: 12, b: 26 };
const PW = W - PAD.l - PAD.r;
const PH = H - PAD.t - PAD.b;

export interface Series { name: string; color: string; values: number[] }

interface TipState { x: number; y: number; title: string; rows: { name: string; color: string; value: string }[] }

function Tip({ tip }: { tip: TipState | null }) {
  if (!tip) return null;
  return (
    <div className="ctip" style={{ left: tip.x, top: tip.y }}>
      <b>{tip.title}</b>
      {tip.rows.map((r) => (
        <div className="r" key={r.name}>
          <span><i style={{ background: r.color }} />{r.name}</span>
          <span>{r.value}</span>
        </div>
      ))}
    </div>
  );
}

function Legend({ series }: { series: Series[] }) {
  if (series.length < 2) return null;
  return (
    <div className="clegend">
      {series.map((s) => <span key={s.name}><i style={{ background: s.color }} />{s.name}</span>)}
    </div>
  );
}

const niceMax = (v: number) => {
  if (v <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  return Math.ceil(v / mag) * mag;
};

/* ------------------------------------------------------------ line chart */

export function LineChart({ series, labels, fmt, zeroLine = false }: {
  series: Series[]; labels: string[]; fmt: (v: number) => string; zeroLine?: boolean;
}) {
  const [tip, setTip] = useState<TipState | null>(null);
  if (!labels.length) return <Empty />;

  const all = series.flatMap((s) => s.values);
  const lo = Math.min(0, ...all);
  const hi = niceMax(Math.max(1, ...all));
  const span = hi - lo || 1;

  const x = (i: number) => PAD.l + (labels.length === 1 ? PW / 2 : (i / (labels.length - 1)) * PW);
  const y = (v: number) => PAD.t + PH - ((v - lo) / span) * PH;
  const ticks = [lo, lo + span / 2, hi];

  const move = (e: React.MouseEvent<SVGRectElement>, i: number) => {
    const r = e.currentTarget.getBoundingClientRect();
    setTip({
      x: r.left + r.width / 2, y: r.top,
      title: labels[i],
      rows: series.map((s) => ({ name: s.name, color: s.color, value: fmt(s.values[i]) })),
    });
  };

  return (
    <>
      <div className="chart">
        <svg viewBox={`0 0 ${W} ${H}`} onMouseLeave={() => setTip(null)}>
          {ticks.map((t, i) => (
            <g key={i}>
              <line className="gridline" x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} />
              <text className="tick" x={PAD.l - 7} y={y(t) + 3} textAnchor="end">{fmt(t)}</text>
            </g>
          ))}
          {zeroLine && lo < 0 && <line className="axisline" x1={PAD.l} x2={W - PAD.r} y1={y(0)} y2={y(0)} />}
          <line className="axisline" x1={PAD.l} x2={PAD.l} y1={PAD.t} y2={PAD.t + PH} />

          {series.map((s) => (
            <polyline
              key={s.name} fill="none" stroke={s.color} strokeWidth="2"
              strokeLinejoin="round" strokeLinecap="round"
              points={s.values.map((v, i) => `${x(i)},${y(v)}`).join(' ')}
            />
          ))}
          {/* endpoint dots, 2px surface ring so overlaps stay legible */}
          {series.map((s) => (
            <circle key={s.name} cx={x(labels.length - 1)} cy={y(s.values[labels.length - 1])} r="3.5"
              fill={s.color} stroke="var(--surface)" strokeWidth="2" />
          ))}

          {labels.map((l, i) => (
            <g key={i} className="hitrow">
              <rect className="hit" x={x(i) - PW / labels.length / 2} y={PAD.t} width={PW / labels.length} height={PH}
                onMouseMove={(e) => move(e, i)} />
              {(i === 0 || i === labels.length - 1 || i === Math.floor(labels.length / 2)) && (
                <text className="tick" x={x(i)} y={H - 8} textAnchor="middle">{l}</text>
              )}
            </g>
          ))}
        </svg>
      </div>
      <Legend series={series} />
      <Tip tip={tip} />
    </>
  );
}

/* ----------------------------------------------------------- bar charts */

export function GroupedBars({ series, labels, fmt }: { series: Series[]; labels: string[]; fmt: (v: number) => string }) {
  const [tip, setTip] = useState<TipState | null>(null);
  if (!labels.length) return <Empty />;

  const hi = niceMax(Math.max(1, ...series.flatMap((s) => s.values)));
  const band = PW / labels.length;
  const bw = Math.min(15, (band - 10) / series.length);
  const y = (v: number) => PAD.t + PH - (v / hi) * PH;

  const move = (e: React.MouseEvent<SVGRectElement>, i: number) => {
    const r = e.currentTarget.getBoundingClientRect();
    setTip({ x: r.left + r.width / 2, y: r.top, title: labels[i], rows: series.map((s) => ({ name: s.name, color: s.color, value: fmt(s.values[i]) })) });
  };

  return (
    <>
      <div className="chart">
        <svg viewBox={`0 0 ${W} ${H}`} onMouseLeave={() => setTip(null)}>
          {[0, hi / 2, hi].map((t, i) => (
            <g key={i}>
              <line className="gridline" x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} />
              <text className="tick" x={PAD.l - 7} y={y(t) + 3} textAnchor="end">{fmt(t)}</text>
            </g>
          ))}
          <line className="axisline" x1={PAD.l} x2={W - PAD.r} y1={y(0)} y2={y(0)} />

          {labels.map((l, i) => {
            const cx = PAD.l + band * i + band / 2;
            const start = cx - (bw * series.length + 2 * (series.length - 1)) / 2;
            return (
              <g key={l} className="hitrow">
                <rect className="hit" x={PAD.l + band * i} y={PAD.t} width={band} height={PH} onMouseMove={(e) => move(e, i)} />
                {series.map((s, k) => {
                  const v = s.values[i];
                  const h = Math.max(0, PAD.t + PH - y(v));
                  return <rect key={s.name} x={start + k * (bw + 2)} y={y(v)} width={bw} height={h} rx="3" fill={s.color} />;
                })}
                <text className="tick" x={cx} y={H - 8} textAnchor="middle">{l}</text>
              </g>
            );
          })}
        </svg>
      </div>
      <Legend series={series} />
      <Tip tip={tip} />
    </>
  );
}

/** One series → one colour. Never a value-ramp on nominal categories. */
export function Bars({ labels, values, color = SERIES[0], fmt }: { labels: string[]; values: number[]; color?: string; fmt: (v: number) => string }) {
  const [tip, setTip] = useState<TipState | null>(null);
  if (!labels.length) return <Empty />;

  const hi = niceMax(Math.max(1, ...values));
  const band = PW / labels.length;
  const bw = Math.min(46, band - 16);
  const y = (v: number) => PAD.t + PH - (v / hi) * PH;

  return (
    <>
      <div className="chart">
        <svg viewBox={`0 0 ${W} ${H}`} onMouseLeave={() => setTip(null)}>
          {[0, hi / 2, hi].map((t, i) => (
            <g key={i}>
              <line className="gridline" x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} />
              <text className="tick" x={PAD.l - 7} y={y(t) + 3} textAnchor="end">{fmt(t)}</text>
            </g>
          ))}
          <line className="axisline" x1={PAD.l} x2={W - PAD.r} y1={y(0)} y2={y(0)} />
          {labels.map((l, i) => {
            const cx = PAD.l + band * i + band / 2;
            const v = values[i];
            return (
              <g key={l} className="hitrow">
                <rect className="hit" x={PAD.l + band * i} y={PAD.t} width={band} height={PH}
                  onMouseMove={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    setTip({ x: r.left + r.width / 2, y: r.top, title: l, rows: [{ name: 'count', color, value: fmt(v) }] });
                  }} />
                <rect x={cx - bw / 2} y={y(v)} width={bw} height={Math.max(0, PAD.t + PH - y(v))} rx="4" fill={color} />
                <text className="tick" x={cx} y={y(v) - 6} textAnchor="middle" fill="var(--ink-2)">{v > 0 ? v : ''}</text>
                <text className="tick" x={cx} y={H - 8} textAnchor="middle">{l}</text>
              </g>
            );
          })}
        </svg>
      </div>
      <Tip tip={tip} />
    </>
  );
}

function Empty() {
  return <div className="muted" style={{ padding: '40px 0', textAlign: 'center', fontSize: 12.5 }}>Not enough data yet — let the simulation run.</div>;
}

/* ------------------------------------------------------------ table twin */

export function ChartTable({ labels, series, fmt }: { labels: string[]; series: Series[]; fmt: (v: number) => string }) {
  return (
    <div className="scrollx">
      <table className="tbl">
        <thead>
          <tr><th></th>{labels.map((l) => <th key={l} className="r">{l}</th>)}</tr>
        </thead>
        <tbody>
          {series.map((s) => (
            <tr key={s.name}>
              <td><i style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: s.color, marginRight: 8 }} />{s.name}</td>
              {s.values.map((v, i) => <td key={i} className="r">{fmt(v)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export const money = (c: number) => cents(Math.round(c));
export const secs = (v: number) => `${Math.round(v)}s`;
export const plain = (v: number) => String(Math.round(v));
