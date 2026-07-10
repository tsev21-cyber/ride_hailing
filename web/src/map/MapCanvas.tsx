import { useEffect, useRef, useState } from 'react';
import { ZONES, type Vec } from '@tylo/shared';
import { useStore } from '../lib/store';
import { MapRenderer } from './renderer';

interface Props {
  picking: 'pickup' | 'dropoff' | null;
  onPick: (p: Vec) => void;
  onCancelPick: () => void;
  activeTripId: string | null;
}

export function MapCanvas({ picking, onPick, onCancelPick, activeTripId }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const renderer = useRef<MapRenderer | null>(null);

  const [showHeat, setShowHeat] = useState(false);
  const [showRoutes, setShowRoutes] = useState(true);
  const [showSurge, setShowSurge] = useState(true);

  const flags = useRef({ showHeat, showRoutes, showSurge, picking, activeTripId });
  flags.current = { showHeat, showRoutes, showSurge, picking, activeTripId };

  useEffect(() => {
    if (!canvas.current || !wrap.current) return;
    const r = new MapRenderer(canvas.current);
    renderer.current = r;

    const ro = new ResizeObserver(() => {
      const b = wrap.current!.getBoundingClientRect();
      r.resize(b.width, b.height);
    });
    ro.observe(wrap.current);

    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;

      // Read straight from the store — never through React state, so vehicle
      // motion at 10 Hz cannot trigger a component re-render.
      const s = useStore.getState();
      const f = flags.current;
      const trip = f.activeTripId ? s.trips[f.activeTripId] ?? null : null;

      r.draw({
        ticks: s.ticks,
        routes: s.routes,
        heat: s.heat,
        showHeat: f.showHeat,
        showRoutes: f.showRoutes,
        showSurge: f.showSurge,
        surge: Object.fromEntries((s.metrics?.zones ?? []).map((z) => [z.zone, z.surge])),
        humanDriverId: s.humanDriverId,
        activeTrip: trip,
        riderPos: s.riders[s.humanRiderId]?.pos ?? null,
        offeredDriverIds: Object.values(s.offers).map((o) => o.driverId),
      }, dt);

      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, []);

  useEffect(() => {
    if (!picking) return;
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onCancelPick();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [picking, onCancelPick]);

  const click = (e: React.MouseEvent) => {
    if (!picking || !renderer.current || !canvas.current) return;
    const b = canvas.current.getBoundingClientRect();
    const p = renderer.current.toWorld(e.clientX - b.left, e.clientY - b.top);
    onPick(p);
  };

  const metrics = useStore((s) => s.metrics);
  const ticks = useStore((s) => s.ticks);
  const online = Object.values(ticks).filter((t) => t.state !== 'offline').length;
  const surging = (metrics?.zones ?? []).filter((z) => z.surge > 1);
  const peak = surging.length ? Math.max(...surging.map((z) => z.surge)) : 1;

  return (
    <section className={`mapwrap${picking ? ' picking' : ''}`} ref={wrap}>
      <canvas ref={canvas} onClick={click} />

      <div className="mapcard maptools">
        <button aria-pressed={showHeat} onClick={() => setShowHeat((v) => !v)}>Demand heatmap</button>
        <button aria-pressed={showRoutes} onClick={() => setShowRoutes((v) => !v)}>Routes</button>
        <button aria-pressed={showSurge} onClick={() => setShowSurge((v) => !v)}>Surge</button>
      </div>

      <div className="mapcard hud">
        <div className="cell"><div className="k">Online</div><div className="v">{online}</div></div>
        <div className="cell"><div className="k">Active trips</div><div className="v">{metrics?.activeTrips ?? 0}</div></div>
        <div className="cell"><div className="k">Utilisation</div><div className="v">{Math.round((metrics?.utilization ?? 0) * 100)}%</div></div>
        <div className="cell"><div className="k">Peak surge</div><div className="v">{peak.toFixed(1)}×</div></div>
      </div>

      <div className="mapcard legend">
        <div className="row">
          <svg width="12" height="12" viewBox="0 0 12 12"><path d="M11 6 1.5 10.8 3.6 6 1.5 1.2Z" fill="#f0a24f" /></svg>
          Driver &mdash; supply
        </div>
        <div className="row">
          <svg width="12" height="12" viewBox="0 0 12 12"><circle cx="6" cy="6" r="4.5" fill="#3987e5" /></svg>
          Rider &mdash; demand
        </div>
        {showHeat && <div className="row"><span className="ramp" /> Request density</div>}
        {showSurge && surging.length > 0 && (
          <div className="row" style={{ color: 'var(--supply-bright)' }}>
            {surging.map((z) => ZONES.find((x) => x.key === z.zone)?.short).join(', ')} surging
          </div>
        )}
      </div>

      {picking && (
        <div className="mapcard pickhint">
          <b>Click the map</b> to set your {picking === 'pickup' ? 'pickup' : 'destination'}
          <button className="ghost" style={{ padding: '3px 9px' }} onClick={onCancelPick}>Esc</button>
        </div>
      )}
    </section>
  );
}
