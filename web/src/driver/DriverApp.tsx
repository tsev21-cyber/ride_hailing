import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useMemo, useState } from 'react';
import {
  STATE_LABEL, cents, fmtEta, instantPayoutFee,
  type Driver, type Offer, type Trip, type ZoneRecommendation,
} from '@tylo/shared';
import { api, getJson, useStore } from '../lib/store';
import { Chip, CountdownRing, clockOf } from '../ui/bits';

type Tab = 'drive' | 'earnings' | 'boost' | 'verify';

const DOC_LABEL: Record<string, string> = {
  drivers_license: "Driver's license",
  insurance: 'Proof of insurance',
  vehicle_registration: 'Vehicle registration',
  profile_photo: 'Profile photo',
};

export function DriverApp() {
  const id = useStore((s) => s.humanDriverId);
  const driver = useStore((s) => s.drivers[s.humanDriverId]);
  const config = useStore((s) => s.config);
  const offers = useStore((s) => s.offers);
  const trips = useStore((s) => s.trips);
  const notifications = useStore((s) => s.notifications);

  const [tab, setTab] = useState<Tab>('drive');
  const [blockReason, setBlockReason] = useState<string | null>(null);
  const [autoAccept, setAutoAccept] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const offer = useMemo(() => Object.values(offers).find((o) => o.driverId === id) ?? null, [offers, id]);
  const trip = driver?.tripId ? trips[driver.tripId] ?? null : null;

  useEffect(() => {
    getJson<Driver & { blockReason: string | null; autoAccept: boolean }>('driver/me')
      .then((d) => { setBlockReason(d.blockReason); setAutoAccept(d.autoAccept); })
      .catch(() => {});
  }, [driver?.verification, driver?.online]);

  useEffect(() => { if (offer && tab !== 'drive') setTab('drive'); }, [offer]);

  if (!driver || !config) return null;

  const toggleOnline = async () => {
    setErr(null);
    try { await api('driver/online', { online: !driver.online }); }
    catch (e) { setErr((e as Error).message); }
  };

  return (
    <div className="phone">
      <div className="phead">
        <span className="av d">{driver.initials}</span>
        <div className="who">
          <b>{driver.name}</b>
          <small>★ {driver.rating.toFixed(2)} · {driver.completedTrips} trips · {(driver.acceptanceRate * 100).toFixed(0)}% accept</small>
        </div>
        {!driver.connected && <Chip tone="bad">no signal</Chip>}
        <button
          className={`sw sup`}
          aria-pressed={driver.online}
          aria-label={driver.online ? 'Go offline' : 'Go online'}
          onClick={toggleOnline}
        />
      </div>

      <div className="railtabs" style={{ padding: 0, gap: 4 }}>
        {(['drive', 'earnings', 'boost', 'verify'] as Tab[]).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} style={{ fontSize: 11.5, borderRadius: 8, border: '1px solid transparent' }}>
            {t === 'verify' ? 'Verification' : t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {err && <div className="card bad"><b style={{ fontSize: 12.5 }}>Can't go online</b><p className="muted" style={{ margin: '3px 0 0', fontSize: 11.5 }}>{err}</p></div>}

      {blockReason && !driver.online && tab !== 'verify' && (
        <div className="callout">
          <b>Blocked from driving.</b> {blockReason}{' '}
          <button className="ghost" style={{ marginTop: 6, padding: '3px 9px' }} onClick={() => setTab('verify')}>Open verification</button>
        </div>
      )}

      <AnimatePresence mode="wait">
        <motion.div
          key={tab}
          initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.18 }}
          style={{ display: 'grid', gap: 12 }}
        >
          {tab === 'drive' && <DriveTab driver={driver} offer={offer} trip={trip} autoAccept={autoAccept} setAutoAccept={setAutoAccept} />}
          {tab === 'earnings' && <EarningsTab driver={driver} />}
          {tab === 'boost' && <BoostTab online={driver.online} />}
          {tab === 'verify' && <VerifyTab driver={driver} blockReason={blockReason} />}
        </motion.div>
      </AnimatePresence>

      {tab === 'drive' && (
        <div>
          <div className="lbl" style={{ marginBottom: 6 }}>Activity</div>
          <div className="list">
            {notifications.filter((n) => n.audience === 'driver').slice(0, 3).map((n) => (
              <div className="notif" key={n.id}>
                <span className={`ic ${n.tone === 'supply' ? 'amber' : 'grey'}`}>•</span>
                <p><b>{n.title}</b>{n.body}</p>
                <small>{clockOf(n.at)}</small>
              </div>
            ))}
            {!notifications.some((n) => n.audience === 'driver') && <p className="muted" style={{ fontSize: 11.5, margin: 0 }}>Nothing yet.</p>}
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ drive */

function DriveTab({ driver, offer, trip, autoAccept, setAutoAccept }: {
  driver: Driver; offer: Offer | null; trip: Trip | null;
  autoAccept: boolean; setAutoAccept: (v: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true); setErr(null);
    try { await fn(); } catch (e) { setErr((e as Error).message); }
    setBusy(false);
  };

  return (
    <>
      <AnimatePresence>
        {offer && (
          <motion.div
            key={offer.id}
            className="card supply"
            initial={{ opacity: 0, scale: 0.94, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={{ type: 'spring', stiffness: 380, damping: 28 }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
              <CountdownRing from={offer.issuedAt} to={offer.expiresAt} />
              <div style={{ flex: 1 }}>
                <b style={{ fontSize: 15 }}>New ride offer</b>
                <div className="muted" style={{ fontSize: 11.5 }}>{fmtEta(offer.etaSec)} to pickup</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <b style={{ fontSize: 18 }} className="num">{cents(offer.estimatedEarningsCents)}</b>
                <div className="muted" style={{ fontSize: 10.5 }}>you earn</div>
              </div>
            </div>
            <div className="btnrow">
              <button className="btn dark" disabled={busy} onClick={() => act(() => api(`driver/offers/${offer.id}/decline`))}>Decline</button>
              <button className="btn sup" disabled={busy} onClick={() => act(() => api(`driver/offers/${offer.id}/accept`))}>Accept</button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {trip ? (
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
            <b style={{ fontSize: 13.5 }}>{STATE_LABEL[trip.state]}</b>
            <span className="mono muted" style={{ fontSize: 11 }}>{trip.id}</span>
          </div>
          <NavCard trip={trip} />
          <div className="btnrow" style={{ marginTop: 10 }}>
            {trip.state === 'driver_arrived' && (
              <button className="btn sup" disabled={busy} onClick={() => act(() => api('driver/trip/start'))}>Start trip</button>
            )}
            {trip.state === 'in_progress' && (
              <button className="btn sup" disabled={busy} onClick={() => act(() => api('driver/trip/complete'))}>End trip</button>
            )}
            {['matched', 'en_route_to_pickup', 'driver_arrived'].includes(trip.state) && (
              <button className="btn danger" disabled={busy} onClick={() => act(() => api('driver/trip/cancel'))}>Cancel</button>
            )}
          </div>
        </div>
      ) : !offer && (
        <div className="card" style={{ textAlign: 'center', padding: '22px 12px' }}>
          <b style={{ fontSize: 13 }}>{driver.online ? 'Waiting for offers' : "You're offline"}</b>
          <p className="muted" style={{ fontSize: 11.5, margin: '4px 0 0' }}>
            {driver.online
              ? 'Dispatch ranks you against every eligible driver by road-network ETA.'
              : 'Flip the switch above to start receiving offers.'}
          </p>
        </div>
      )}

      {err && <div className="card bad"><p style={{ margin: 0, fontSize: 12 }}>{err}</p></div>}

      <div className="card tight" style={{ display: 'grid', gap: 10 }}>
        <div className="lbl">Simulate real-world conditions</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button className="sw sup" aria-pressed={autoAccept} onClick={async () => {
            const r = await api<{ enabled: boolean }>('driver/autoaccept', { enabled: !autoAccept });
            setAutoAccept(r.enabled);
          }} />
          <div style={{ flex: 1 }}>
            <b style={{ fontSize: 12.5 }}>Auto-accept offers</b>
            <div className="muted" style={{ fontSize: 11 }}>Let the sim drive for you.</div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button className="sw" aria-pressed={!driver.connected} onClick={() => api('driver/connection', { connected: !driver.connected })} />
          <div style={{ flex: 1 }}>
            <b style={{ fontSize: 12.5 }}>Kill the phone's signal</b>
            <div className="muted" style={{ fontSize: 11 }}>
              After {useStore.getState().config?.dispatch.heartbeatTimeoutSec}s the trip enters <span className="mono">driver_unreachable</span>, then reassigns.
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function NavCard({ trip }: { trip: Trip }) {
  const simSec = useStore((s) => s.simSec);
  const onTrip = trip.state === 'in_progress';
  const start = onTrip ? trip.startedAt ?? simSec : trip.matchedAt ?? simSec;
  const total = onTrip ? trip.estMinutes * 60 : trip.predictedPickupEtaSec;
  const left = Math.max(0, total - (simSec - start));
  const pct = Math.min(100, ((simSec - start) / Math.max(1, total)) * 100);

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
        <span style={{ fontSize: 12.5, color: 'var(--ink-2)' }}>{onTrip ? trip.dropoffLabel : trip.pickupLabel}</span>
        <b className="num" style={{ fontSize: 12.5 }}>{trip.state === 'driver_arrived' ? 'At pickup' : fmtEta(left)}</b>
      </div>
      <div className={`prog${onTrip ? '' : ' sup'}`}>
        <motion.i animate={{ width: `${pct}%` }} transition={{ ease: 'linear', duration: 0.4 }} />
      </div>
      <div className="kv" style={{ marginTop: 8 }}>
        <span>Trip fare</span><b>{cents(trip.quotedFare.totalCents)}</b>
      </div>
      <div className="kv"><span>Distance</span><b>{trip.estMiles.toFixed(1)} mi</b></div>
    </>
  );
}

/* --------------------------------------------------------------- earnings */

function EarningsTab({ driver }: { driver: Driver }) {
  const config = useStore((s) => s.config)!;
  const payouts = useStore((s) => s.payouts.filter((p) => p.driverId === driver.id));
  const [err, setErr] = useState<string | null>(null);
  const fee = instantPayoutFee(config, driver.wallet.availableCents);

  return (
    <>
      <div className="card supply">
        <div className="lbl">Available now</div>
        <div style={{ fontSize: 30, fontWeight: 660, letterSpacing: '-0.02em' }}>{cents(driver.wallet.availableCents)}</div>
        <div className="muted" style={{ fontSize: 11.5, marginBottom: 10 }}>
          Lifetime {cents(driver.wallet.lifetimeCents)} · Stripe <span className="mono">{driver.stripeAccountId}</span>
        </div>
        <button
          className="btn sup"
          disabled={driver.wallet.availableCents < 100}
          onClick={async () => { setErr(null); try { await api('driver/payout/instant'); } catch (e) { setErr((e as Error).message); } }}
        >
          Cash out {cents(Math.max(0, driver.wallet.availableCents - fee))} now
        </button>
        <p className="muted" style={{ fontSize: 11, margin: '6px 0 0', textAlign: 'center' }}>
          Instant payout fee {cents(fee)} ({(config.instantPayout.percent * 100).toFixed(1)}%, min {cents(config.instantPayout.minFeeCents)}). Friday's standard payout is free.
        </p>
        {err && <small style={{ color: 'var(--crit-ink)' }}>{err}</small>}
      </div>

      <div>
        <div className="lbl" style={{ marginBottom: 6 }}>Payout history</div>
        <div className="list">
          {payouts.length === 0 && <p className="muted" style={{ fontSize: 11.5, margin: 0 }}>No payouts yet.</p>}
          {payouts.map((p) => (
            <div key={p.id} className="kv" style={{ padding: '9px 11px' }}>
              <span>
                <b style={{ display: 'block', color: 'var(--ink)', fontSize: 12.5 }}>{cents(p.netCents)} · {p.method}</b>
                <small className="muted mono" style={{ fontSize: 10 }}>{p.id}</small>
              </span>
              <b style={{ fontSize: 11, color: 'var(--ink-3)' }}>{p.feeCents ? `−${cents(p.feeCents)} fee` : 'no fee'}</b>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ boost */

function BoostTab({ online }: { online: boolean }) {
  const metrics = useStore((s) => s.metrics);
  const [recs, setRecs] = useState<ZoneRecommendation[]>([]);

  useEffect(() => {
    const load = () => getJson<ZoneRecommendation[]>('driver/recommendations').then(setRecs).catch(() => {});
    load();
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, []);

  const eta = metrics?.eta;
  const improved = eta && eta.samples > 4 && eta.mapeCorrected < eta.mapeRaw;

  return (
    <>
      <div className="card">
        <div className="lbl" style={{ marginBottom: 8 }}>Where to earn next</div>
        <div style={{ display: 'grid', gap: 10 }}>
          {recs.map((r, i) => (
            <div className="zonerec" key={r.zone}>
              <span className="rank">{i + 1}</span>
              <b style={{ fontSize: 13 }}>{r.name}</b>
              <b className="num" style={{ color: 'var(--supply-bright)' }}>{cents(r.expectedHourlyCents)}/hr</b>
              <div className="why">{r.rationale}</div>
            </div>
          ))}
          {!recs.length && <p className="muted" style={{ fontSize: 11.5, margin: 0 }}>Loading…</p>}
        </div>
        <p className="muted" style={{ fontSize: 10.5, marginTop: 10, lineHeight: 1.5 }}>
          expected $/hr = catchable rides × avg fare × surge × (1 − commission) × (1 − deadhead/60).
          Contention divides demand by the drivers already idle there. {!online && 'Go online to act on it.'}
        </p>
      </div>

      <div className="card">
        <div className="lbl" style={{ marginBottom: 8 }}>Smart ETA model</div>
        {eta && eta.samples > 0 ? (
          <>
            <div className="kv"><span>Pickups learned from</span><b>{eta.samples}</b></div>
            <div className="kv"><span>Router alone (free-flow)</span><b>{eta.mapeRaw.toFixed(1)}% error</b></div>
            <div className="kv"><span>With learned traffic</span><b style={{ color: improved ? 'var(--good-ink)' : undefined }}>{eta.mapeCorrected.toFixed(1)}% error</b></div>
            <div className="lbl" style={{ margin: '10px 0 6px' }}>Learned congestion per zone</div>
            <div style={{ display: 'grid', gap: 3 }}>
              {Object.entries(eta.factors).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([z, f]) => (
                <div key={z} style={{ display: 'grid', gridTemplateColumns: '76px 1fr 44px', gap: 8, alignItems: 'center', fontSize: 11 }}>
                  <span className="muted">{z}</span>
                  <div className="prog"><i style={{ width: `${Math.min(100, ((f - 1) / 0.6) * 100)}%`, background: 'var(--supply)' }} /></div>
                  <b className="num" style={{ fontSize: 11 }}>{f.toFixed(2)}×</b>
                </div>
              ))}
            </div>
            <p className="muted" style={{ fontSize: 10.5, marginTop: 10, lineHeight: 1.5 }}>
              The router only knows speed limits. Each completed pickup feeds an EMA of actual ÷ predicted per zone.
              Downtown converges around 1.4× because that is what the traffic actually is.
            </p>
          </>
        ) : <p className="muted" style={{ fontSize: 11.5, margin: 0 }}>No completed pickups yet — the model has nothing to learn from.</p>}
      </div>
    </>
  );
}

/* ----------------------------------------------------------- verification */

function VerifyTab({ driver, blockReason }: { driver: Driver; blockReason: string | null }) {
  const v = driver.verification;
  const bg = v.backgroundCheck;
  const tone = (s: string) => (s === 'verified' ? 'ok' : s === 'pending' ? 'warn' : s === 'rejected' ? 'bad' : 'neutral');

  return (
    <>
      <div className={`card ${blockReason ? 'bad' : ''}`}>
        <b style={{ fontSize: 13 }}>{blockReason ? 'Not cleared to drive' : 'Cleared to drive'}</b>
        <p className="muted" style={{ fontSize: 11.5, margin: '4px 0 0' }}>
          {blockReason ?? 'All documents verified, background check clear, admin approved.'}
        </p>
      </div>

      <div className="card">
        <div className="lbl" style={{ marginBottom: 8 }}>Documents</div>
        <div style={{ display: 'grid', gap: 7 }}>
          {Object.entries(v.documents).map(([k, s]) => (
            <div key={k} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 12.5 }}>{DOC_LABEL[k]}</span>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <Chip tone={tone(s)}>{s}</Chip>
                {s !== 'verified' && (
                  <button className="ghost" style={{ padding: '2px 8px', fontSize: 10.5 }}
                    onClick={() => api(`admin/drivers/${driver.id}/documents/${k}`, { status: 'verified' })}>
                    Approve (admin)
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <div className="lbl" style={{ marginBottom: 8 }}>Background check</div>
        <div className="kv"><span>Report</span><b className="mono" style={{ fontSize: 11 }}>{bg.id}</b></div>
        <div className="kv"><span>Status</span><Chip tone={bg.status === 'clear' ? 'ok' : bg.status === 'consider' ? 'warn' : bg.status === 'suspended' ? 'bad' : 'neutral'}>{bg.status}</Chip></div>
        {bg.findings.length > 0 && (
          <ul style={{ margin: '8px 0 0', paddingLeft: 16, fontSize: 11.5, color: 'var(--ink-2)' }}>
            {bg.findings.map((f, i) => <li key={i} style={{ marginBottom: 3 }}>{f}</li>)}
          </ul>
        )}
        <p className="muted" style={{ fontSize: 10.5, marginTop: 10, lineHeight: 1.5 }}>
          Shaped like a Checkr report. A "consider" result must be adjudicated by a human under FCRA
          before any adverse action — never auto-rejected.
        </p>
      </div>
    </>
  );
}
