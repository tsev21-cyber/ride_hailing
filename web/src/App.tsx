import { useMemo, useState } from 'react';
import { POIS, isTerminal, simClock, type Vec } from '@tylo/shared';
import { AdminApp } from './admin/AdminApp';
import { DriverApp } from './driver/DriverApp';
import { api, socket, useStore } from './lib/store';
import { MapCanvas } from './map/MapCanvas';
import { RiderApp } from './rider/RiderApp';
import { DispatchTraceView, Toasts, WireLog } from './ui/bits';

const SPEEDS = [1, 4, 16];

export default function App() {
  const ready = useStore((s) => s.ready);
  const connected = useStore((s) => s.connected);
  const speed = useStore((s) => s.speed);
  const simSec = useStore((s) => s.simSec);
  const riderId = useStore((s) => s.humanRiderId);
  const trips = useStore((s) => s.trips);
  const traces = useStore((s) => s.traces);

  const [view, setView] = useState<'console' | 'admin'>('console');
  const [rail, setRail] = useState<'rider' | 'driver'>('rider');
  const [picking, setPicking] = useState<'pickup' | 'dropoff' | null>(null);
  const [pickup, setPickup] = useState({ pos: { x: 3.62, y: 1.72 }, label: 'Brickell City Centre' });
  const [dropoff, setDropoff] = useState<{ pos: Vec; label: string } | null>(null);

  const activeTrip = useMemo(
    () => Object.values(trips).find((t) => t.riderId === riderId && !isTerminal(t.state)) ?? null,
    [trips, riderId],
  );
  const trace = activeTrip ? traces[activeTrip.id] ?? null : null;
  const { hh, mm, day } = simClock(simSec);

  if (!ready) {
    return (
      <div className="boot">
        <div className="brand"><b>TYLO</b></div>
        <p>{connected ? 'Loading the world…' : 'Connecting to the dispatch engine…'}</p>
      </div>
    );
  }

  const nameOf = (p: Vec) => {
    const near = POIS.map((x) => ({ x, d: Math.hypot(x.pos.x - p.x, x.pos.y - p.y) })).sort((a, b) => a.d - b.d)[0];
    return near.d < 0.3 ? near.x.name : `Dropped pin · ${p.x.toFixed(2)}, ${p.y.toFixed(2)}`;
  };

  const onPick = (p: Vec) => {
    const label = nameOf(p);
    if (picking === 'pickup') setPickup({ pos: p, label });
    else setDropoff({ pos: p, label });
    setPicking(null);
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand"><b>TYLO</b><span>ops console</span></div>

        <div className="clock">
          <div className="t num">{hh}:{mm}</div>
          <div className="d">{day}</div>
        </div>

        <div className="seg" role="group" aria-label="Simulation speed">
          {SPEEDS.map((s) => (
            <button key={s} aria-pressed={speed === s} onClick={() => api('sim/speed', { speed: s })}>{s}×</button>
          ))}
          <button aria-pressed={speed === 0} title="Pause" onClick={() => api('sim/speed', { speed: speed === 0 ? 4 : 0 })}>
            {speed === 0 ? '▶' : '❚❚'}
          </button>
        </div>

        <div className="spacer" />

        <div className="sock">
          <span className={`dot${connected ? ' pulse' : ' off'}`} />
          {connected ? 'connected' : 'reconnecting'}
        </div>
        <button
          className="ghost danger"
          onClick={() => { if (socket.connected) socket.disconnect(); else socket.connect(); }}
        >
          {connected ? 'Drop socket' : 'Reconnect'}
        </button>

        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={view === 'console'} onClick={() => setView('console')}>Console</button>
          <button role="tab" aria-selected={view === 'admin'} onClick={() => setView('admin')}>Admin</button>
        </div>
        <button className="ghost" onClick={() => api('sim/reset')}>Reset</button>
      </header>

      {view === 'console' ? (
        <main className="console">
          <MapCanvas
            picking={picking}
            onPick={onPick}
            onCancelPick={() => setPicking(null)}
            activeTripId={activeTrip?.id ?? null}
          />

          <aside className="rail">
            <div className="railtabs" role="tablist">
              <button role="tab" aria-selected={rail === 'rider'} onClick={() => setRail('rider')}>Rider app</button>
              <button role="tab" aria-selected={rail === 'driver'} onClick={() => setRail('driver')}>Driver app</button>
            </div>
            <div className="railbody">
              {rail === 'rider'
                ? <RiderApp picking={picking} setPicking={setPicking} pickup={pickup} dropoff={dropoff} setDropoff={setDropoff} />
                : <DriverApp />}

              <details className="dtrace" open={!!trace}>
                <summary>Dispatch trace — candidate ranking</summary>
                <DispatchTraceView trace={trace} />
              </details>
            </div>
          </aside>
        </main>
      ) : (
        <AdminApp />
      )}

      <WireLog />
      <Toasts />
    </div>
  );
}
