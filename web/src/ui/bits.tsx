import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useState } from 'react';
import { simClock, type DispatchTrace, type Notification } from '@tylo/shared';
import { useStore } from '../lib/store';

/* ------------------------------------------------------------------ misc */

export const clockOf = (simSec: number) => {
  const { hh, mm } = simClock(simSec);
  return `${hh}:${mm}`;
};

export function Chip({ tone = 'neutral', children }: { tone?: string; children: React.ReactNode }) {
  return <span className={`chip ${tone}`}>{children}</span>;
}

/** Circular offer countdown. Reads the sim clock, so pausing pauses the ring. */
export function CountdownRing({ from, to, tone = '#f0a24f' }: { from: number; to: number; tone?: string }) {
  const simSec = useStore((s) => s.simSec);
  const total = Math.max(0.001, to - from);
  const left = Math.max(0, to - simSec);
  const f = Math.max(0, Math.min(1, left / total));
  const R = 19;
  const C = 2 * Math.PI * R;

  return (
    <div className="timer">
      <svg width="46" height="46" viewBox="0 0 46 46">
        <circle cx="23" cy="23" r={R} fill="none" stroke="var(--raised-2)" strokeWidth="3.5" />
        <circle
          cx="23" cy="23" r={R} fill="none" stroke={tone} strokeWidth="3.5" strokeLinecap="round"
          strokeDasharray={C} strokeDashoffset={C * (1 - f)}
        />
      </svg>
      <b>{Math.ceil(left)}</b>
    </div>
  );
}

/* ---------------------------------------------------------------- toasts */

const TONE_ICON: Record<string, { cls: string; glyph: string }> = {
  info: { cls: 'blue', glyph: 'i' },
  success: { cls: 'green', glyph: '✓' },
  warn: { cls: 'amber', glyph: '!' },
  error: { cls: 'red', glyph: '✕' },
  supply: { cls: 'amber', glyph: '$' },
};

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);

  return (
    <div className="toasts">
      <AnimatePresence initial={false}>
        {toasts.map((t: Notification) => {
          const ic = TONE_ICON[t.tone] ?? TONE_ICON.info;
          return (
            <motion.div
              key={t.id}
              className="toast"
              layout
              initial={{ opacity: 0, x: 28, scale: 0.96 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={{ opacity: 0, x: 28, scale: 0.96 }}
              transition={{ type: 'spring', stiffness: 420, damping: 34 }}
              onClick={() => dismiss(t.id)}
            >
              <span className={`ic ${ic.cls}`}>{ic.glyph}</span>
              <div>
                <b>{t.title}</b>
                <p>{t.body}</p>
              </div>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}

/* -------------------------------------------------------------- wire log */

const FILTERS = ['all', 'trip', 'dispatch', 'money', 'errors'] as const;
type Filter = (typeof FILTERS)[number];

const matches = (event: string, level: string | undefined, f: Filter) => {
  if (f === 'all') return true;
  if (f === 'errors') return level === 'error' || level === 'warn';
  if (f === 'trip') return event.startsWith('trip:') || event.startsWith('fsm:') || event.includes('rides');
  if (f === 'dispatch') return event.startsWith('dispatch:') || event.startsWith('offer:') || event.startsWith('trip:offer');
  if (f === 'money') return event.startsWith('ledger') || event.includes('payout') || event.includes('tip') || event.includes('membership');
  return true;
};

export function WireLog() {
  const wire = useStore((s) => s.wire);
  const paused = useStore((s) => s.wirePaused);
  const setPaused = useStore((s) => s.setWirePaused);
  const clear = useStore((s) => s.clearWire);
  const [filter, setFilter] = useState<Filter>('all');
  const [min, setMin] = useState(false);

  const rows = wire.filter((f) => matches(f.event, f.level, filter)).slice(0, 90);

  return (
    <footer className={`wire${min ? ' min' : ''}`}>
      <header>
        <span className="lbl">WebSocket frames</span>
        <div className="filters">
          {FILTERS.map((f) => (
            <button key={f} aria-pressed={filter === f} onClick={() => setFilter(f)}>{f}</button>
          ))}
        </div>
        <button className="ghost" aria-pressed={paused} onClick={() => setPaused(!paused)} style={{ padding: '3px 9px', fontSize: 11 }}>
          {paused ? 'Resume' : 'Pause'}
        </button>
        <button className="ghost" onClick={clear} style={{ padding: '3px 9px', fontSize: 11 }}>Clear</button>
        <button className="ghost" onClick={() => setMin((v) => !v)} style={{ padding: '3px 9px', fontSize: 11 }}>
          {min ? 'Show' : 'Hide'}
        </button>
      </header>
      <div className="log">
        {rows.map((f) => (
          <div className={`fr ${f.dir === 'sys' ? 'sys' : ''} ${f.level ?? ''}`} key={f.id}>
            <time>{clockOf(f.at)}</time>
            <span className={`dir ${f.dir}`}>{f.dir === 'up' ? '↑' : f.dir === 'down' ? '↓' : '•'}</span>
            <span className="ev">{f.event}</span>
            <span className="pl">{f.payload}</span>
          </div>
        ))}
        {!rows.length && <div className="muted" style={{ padding: 8 }}>No frames match this filter yet.</div>}
      </div>
    </footer>
  );
}

/* -------------------------------------------------- dispatch trace drawer */

export function DispatchTraceView({ trace }: { trace: DispatchTrace | null }) {
  if (!trace) {
    return <p className="muted" style={{ fontSize: 12, padding: '4px 0' }}>
      Request a ride to watch the engine rank every eligible driver, offer them one at a time, and cascade on decline.
    </p>;
  }
  return (
    <>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
        <Chip tone="info">{trace.tripId}</Chip>
        <Chip tone="neutral">round {trace.round}</Chip>
        <Chip tone="neutral">radius {trace.radiusMi.toFixed(1)} mi</Chip>
        {trace.riderIsMember && <Chip tone="plus">Tylo+ priority</Chip>}
      </div>
      <table>
        <thead>
          <tr><th>driver</th><th>dist</th><th>raw eta</th><th>smart eta</th><th>acc</th><th>score</th><th>outcome</th></tr>
        </thead>
        <tbody>
          {trace.candidates.slice(0, 8).map((c) => (
            <tr key={c.driverId} className={c.outcome === 'accepted' ? 'win' : c.outcome === 'offered' ? 'offered' : ['declined', 'timed_out', 'skipped'].includes(c.outcome) ? 'out' : ''}>
              <td>{c.driverId}</td>
              <td>{c.distanceMi.toFixed(2)}</td>
              <td>{c.rawEtaSec}s</td>
              <td>{c.smartEtaSec}s</td>
              <td>{(c.acceptanceRate * 100).toFixed(0)}%</td>
              <td>{c.score}</td>
              <td>{c.outcome}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted" style={{ fontSize: 10.5, marginTop: 8, lineHeight: 1.5 }}>
        score = smart ETA + (1 − acceptance) × 45 + (5 − rating) × 35. Lower wins. Ranking is by
        road-network ETA, not straight-line distance — otherwise dispatch sends drivers across the bay.
      </p>
    </>
  );
}

/* ----------------------------------------------------------------- hooks */

export function useNow(intervalMs = 500) {
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((v) => v + 1), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
}
