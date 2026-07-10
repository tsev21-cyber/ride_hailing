import { io, type Socket } from 'socket.io-client';
import { create } from 'zustand';
import type {
  Driver, DriverTick, LedgerEntry, Metrics, Notification, Offer, Payout, PlatformConfig,
  Promo, Rider, Ticket, Trip, Vec, WireFrame, DispatchTrace,
} from '@tylo/shared';

export interface RouteLine { driverId: string; tripId: string | null; points: Vec[]; phase: 'pickup' | 'trip' }
export interface Heat { cols: number; rows: number; max: number; cells: number[] }

interface Snapshot {
  simSec: number; speed: number; config: PlatformConfig;
  humanDriverId: string; humanRiderId: string;
  drivers: Driver[]; riders: Rider[]; trips: Trip[]; offers: Offer[];
  promos: Promo[]; tickets: Ticket[]; ledger: LedgerEntry[]; payouts: Payout[];
  routes: RouteLine[]; heat: Heat; metrics: Metrics;
}

interface State {
  connected: boolean;
  ready: boolean;
  simSec: number;
  speed: number;
  config: PlatformConfig | null;
  humanDriverId: string;
  humanRiderId: string;

  drivers: Record<string, Driver>;
  /** Live positions, updated 10×/s. Kept apart from `drivers` so the React
   *  tree never re-renders on movement — only the canvas reads this. */
  ticks: Record<string, DriverTick>;
  riders: Record<string, Rider>;
  trips: Record<string, Trip>;
  offers: Record<string, Offer>;
  promos: Promo[];
  tickets: Ticket[];
  ledger: LedgerEntry[];
  payouts: Payout[];
  routes: Record<string, RouteLine>;
  heat: Heat | null;
  metrics: Metrics | null;
  traces: Record<string, DispatchTrace>;

  notifications: Notification[];
  toasts: Notification[];
  wire: WireFrame[];
  wirePaused: boolean;

  dismissToast: (id: string) => void;
  setWirePaused: (v: boolean) => void;
  clearWire: () => void;
}

export const useStore = create<State>((set) => ({
  connected: false,
  ready: false,
  simSec: 0,
  speed: 1,
  config: null,
  humanDriverId: 'D-01',
  humanRiderId: 'R-01',

  drivers: {}, ticks: {}, riders: {}, trips: {}, offers: {},
  promos: [], tickets: [], ledger: [], payouts: [], routes: {},
  heat: null, metrics: null, traces: {},

  notifications: [], toasts: [], wire: [], wirePaused: false,

  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  setWirePaused: (v) => set({ wirePaused: v }),
  clearWire: () => set({ wire: [] }),
}));

/* ------------------------------------------------------------------ wire */

let frameId = 0;
const byId = <T extends { id: string }>(xs: T[]) => Object.fromEntries(xs.map((x) => [x.id, x]));

/** Events too chatty to log every frame; we sample them instead. */
const NOISY = new Set(['world:tick', 'heat:update', 'metrics', 'surge:update']);
let tickSample = 0;

function logFrame(dir: WireFrame['dir'], event: string, payload: unknown, level?: WireFrame['level']) {
  const st = useStore.getState();
  if (st.wirePaused) return;
  if (NOISY.has(event) && ++tickSample % 24 !== 0) return;

  let text = '';
  try {
    text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  } catch { text = '[unserialisable]'; }
  if (text.length > 150) text = text.slice(0, 150) + '…';

  const frame: WireFrame = { id: ++frameId, at: st.simSec, dir, event, payload: text, level };
  useStore.setState((s) => ({ wire: [frame, ...s.wire].slice(0, 220) }));
}

/* ---------------------------------------------------------------- socket */

export const socket: Socket = io({ path: '/socket.io', autoConnect: true, transports: ['websocket', 'polling'] });

socket.on('connect', () => {
  useStore.setState({ connected: true });
  logFrame('sys', 'socket:connect', { id: socket.id });
});

socket.on('disconnect', (reason) => {
  useStore.setState({ connected: false });
  logFrame('sys', 'socket:disconnect', { reason }, 'error');
});

socket.on('world:snapshot', (s: Snapshot) => {
  logFrame('down', 'world:snapshot', { drivers: s.drivers.length, trips: s.trips.length });
  useStore.setState({
    ready: true,
    simSec: s.simSec,
    speed: s.speed,
    config: s.config,
    humanDriverId: s.humanDriverId,
    humanRiderId: s.humanRiderId,
    drivers: byId(s.drivers),
    riders: byId(s.riders),
    trips: byId(s.trips),
    offers: byId(s.offers),
    promos: s.promos,
    tickets: s.tickets,
    ledger: s.ledger,
    payouts: s.payouts,
    routes: Object.fromEntries(s.routes.map((r) => [r.driverId, r])),
    heat: s.heat,
    metrics: s.metrics,
    ticks: Object.fromEntries(s.drivers.map((d) => [d.id, {
      id: d.id, x: d.pos.x, y: d.pos.y, heading: d.heading, state: d.state, connected: d.connected,
    }])),
  });
});

socket.on('world:tick', (t: { simSec: number; speed: number; drivers: DriverTick[] }) => {
  logFrame('down', 'world:tick', { simSec: Math.round(t.simSec), drivers: t.drivers.length });
  useStore.setState({ simSec: t.simSec, speed: t.speed, ticks: byId(t.drivers) });
});

socket.on('world:reset', () => { location.reload(); });

socket.on('clock:speed', (p: { speed: number }) => useStore.setState({ speed: p.speed }));

socket.on('trip:update', (trip: Trip) => {
  logFrame('down', 'trip:update', { id: trip.id, state: trip.state });
  useStore.setState((s) => ({ trips: { ...s.trips, [trip.id]: trip } }));
});

socket.on('driver:update', (d: Driver) => {
  useStore.setState((s) => ({ drivers: { ...s.drivers, [d.id]: d } }));
});

socket.on('rider:update', (r: Rider) => {
  useStore.setState((s) => ({ riders: { ...s.riders, [r.id]: r } }));
});

socket.on('trip:offer', ({ offer, trip, driver }: { offer: Offer; trip: Trip; driver: Driver }) => {
  logFrame('down', 'trip:offer', { to: driver.id, trip: trip.id, eta: offer.etaSec + 's' });
  useStore.setState((s) => ({
    offers: { ...s.offers, [offer.id]: offer },
    trips: { ...s.trips, [trip.id]: trip },
  }));
});

socket.on('offer:cleared', ({ offerId, reason }: { offerId: string; driverId: string; reason: string }) => {
  logFrame('down', 'offer:cleared', { offerId, reason }, reason === 'accepted' ? undefined : 'warn');
  useStore.setState((s) => {
    const offers = { ...s.offers };
    delete offers[offerId];
    return { offers };
  });
});

socket.on('dispatch:trace', (t: DispatchTrace) => {
  useStore.setState((s) => ({ traces: { ...s.traces, [t.tripId]: t } }));
});

socket.on('route:update', (r: RouteLine) => {
  useStore.setState((s) => {
    const routes = { ...s.routes };
    if (!r.points?.length) delete routes[r.driverId];
    else routes[r.driverId] = r;
    return { routes };
  });
});

socket.on('fsm:reject', (p: { tripId: string; from: string; to: string; error: string }) => {
  logFrame('down', 'fsm:reject', p, 'error');
});

socket.on('heat:update', (h: Heat) => { logFrame('down', 'heat:update', { max: h.max.toFixed(1) }); useStore.setState({ heat: h }); });
socket.on('surge:update', (z: unknown) => logFrame('down', 'surge:update', z));
socket.on('metrics', (m: Metrics) => { logFrame('down', 'metrics', { gmv: m.gmvCents }); useStore.setState({ metrics: m }); });
socket.on('promos:update', (p: Promo[]) => useStore.setState({ promos: p }));
socket.on('tickets:update', (t: Ticket[]) => useStore.setState({ tickets: t }));
socket.on('payouts:update', (p: Payout[]) => useStore.setState({ payouts: p }));
socket.on('config:update', (c: PlatformConfig) => { logFrame('down', 'config:update', { commission: c.commissionPct }); useStore.setState({ config: c }); });

socket.on('ledger:entry', (e: LedgerEntry) => {
  logFrame('down', 'ledger:entry', { type: e.type, amount: e.amountCents });
  useStore.setState((s) => ({ ledger: [e, ...s.ledger].slice(0, 120) }));
});

socket.on('notify', (n: Notification) => {
  logFrame('down', 'notify', { to: n.audience, title: n.title });
  useStore.setState((s) => ({
    notifications: [n, ...s.notifications].slice(0, 60),
    toasts: [...s.toasts, n].slice(-3),
  }));
  setTimeout(() => useStore.getState().dismissToast(n.id), 5200);
});

/* ------------------------------------------------------------------- api */

export async function api<T = unknown>(path: string, body?: unknown, method = 'POST'): Promise<T> {
  logFrame('up', `${method} /api/${path}`, body ?? {});
  const res = await fetch(`/api/${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = (data as { message?: string }).message ?? res.statusText;
    logFrame('down', `${res.status} /api/${path}`, message, 'error');
    throw new Error(Array.isArray(message) ? message.join(', ') : String(message));
  }
  return data as T;
}

export const getJson = <T,>(path: string) => api<T>(path, undefined, 'GET');
