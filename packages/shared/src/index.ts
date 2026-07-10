export * from './types';
export * from './zones';
export * from './roadgraph';
export * from './config';
export * from './pricing';
export * from './connect';
export * from './fsm';
export * from './promos';
export * from './ids';

/* Simulation clock helpers — the world starts at 08:00 on a Monday. */
export const SIM_START_HOUR = 8;

export const simHour = (simSec: number) => Math.floor(SIM_START_HOUR + simSec / 3600) % 24;

export function simClock(simSec: number): { hh: string; mm: string; day: string } {
  const total = SIM_START_HOUR * 3600 + simSec;
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const h = Math.floor(total / 3600) % 24;
  const m = Math.floor((total % 3600) / 60);
  return {
    hh: String(h).padStart(2, '0'),
    mm: String(m).padStart(2, '0'),
    day: days[Math.floor(total / 86400) % 7],
  };
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function fmtEta(sec: number): string {
  if (sec < 60) return `${Math.max(1, Math.round(sec))} sec`;
  return `${Math.round(sec / 60)} min`;
}

export function fmtDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
