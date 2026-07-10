import { AnimatePresence, motion } from 'framer-motion';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  POIS, STATE_LABEL, cents, fmtEta, isTerminal, type CancellationPolicy,
  type FareBreakdown, type ProductKey, type Route, type Trip, type Vec,
} from '@tylo/shared';
import { api, getJson, useStore } from '../lib/store';
import { Chip, clockOf } from '../ui/bits';

interface Quote { product: ProductKey; fare: FareBreakdown; route: Route; surge: number; etaSec: number; promoError?: string }

const CAR: Record<ProductKey, string> = { tylo_x: '🚗', tylo_black: '🚘', tylo_xl: '🚙' };

const fade = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -8 },
  transition: { duration: 0.22, ease: [0.2, 0.8, 0.2, 1] as const },
};

interface Props {
  picking: 'pickup' | 'dropoff' | null;
  setPicking: (v: 'pickup' | 'dropoff' | null) => void;
  pickup: { pos: Vec; label: string };
  dropoff: { pos: Vec; label: string } | null;
  setDropoff: (v: { pos: Vec; label: string } | null) => void;
}

export function RiderApp({ picking, setPicking, pickup, dropoff, setDropoff }: Props) {
  const riderId = useStore((s) => s.humanRiderId);
  const rider = useStore((s) => s.riders[s.humanRiderId]);
  const config = useStore((s) => s.config);
  const trips = useStore((s) => s.trips);
  const drivers = useStore((s) => s.drivers);
  const notifications = useStore((s) => s.notifications);

  const [product, setProduct] = useState<ProductKey>('tylo_x');
  const [promoInput, setPromoInput] = useState('');
  const [promoApplied, setPromoApplied] = useState<string | null>(null);
  const [quotes, setQuotes] = useState<Quote[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const myTrips = useMemo(
    () => Object.values(trips).filter((t) => t.riderId === riderId).sort((a, b) => b.requestedAt - a.requestedAt),
    [trips, riderId],
  );
  const active = myTrips.find((t) => !isTerminal(t.state)) ?? null;
  const last = myTrips[0] ?? null;
  const showReceipt = !active && last?.state === 'completed';
  const showFailed = !active && last && ['cancelled_by_rider', 'cancelled_by_driver', 'no_drivers_available'].includes(last.state);

  /* live quote — refetched whenever anything that moves the price moves */
  const refreshQuote = useCallback(async () => {
    if (!dropoff || active) { setQuotes(null); return; }
    try {
      const q = await api<Quote[]>('rides/quote', { pickup: pickup.pos, dropoff: dropoff.pos, promoCode: promoApplied });
      setQuotes(q);
      const err = q.find((x) => x.promoError)?.promoError;
      setError(err ?? null);
      if (err) setPromoApplied(null);
    } catch (e) { setError((e as Error).message); }
  }, [pickup.pos, dropoff, promoApplied, active]);

  useEffect(() => { void refreshQuote(); }, [refreshQuote, config?.commissionPct, config?.products.tylo_x.perMileCents]);
  useEffect(() => {
    if (active || !dropoff) return;
    const t = setInterval(() => void refreshQuote(), 6000); // surge drifts
    return () => clearInterval(t);
  }, [refreshQuote, active, dropoff]);

  if (!rider || !config) return null;

  const quote = quotes?.find((q) => q.product === product) ?? null;

  const request = async () => {
    if (!dropoff || !quote) return;
    setBusy(true); setError(null);
    try {
      await api<Trip>('rides', {
        product, pickup: pickup.pos, dropoff: dropoff.pos,
        pickupLabel: pickup.label, dropoffLabel: dropoff.label,
        promoCode: promoApplied,
      });
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  const riderNotifs = notifications.filter((n) => n.audience === 'rider').slice(0, 4);

  return (
    <div className="phone">
      <div className="phead">
        <span className="av r">{rider.initials}</span>
        <div className="who">
          <b>{rider.name}</b>
          <small>★ {rider.rating.toFixed(1)} · {rider.completedTrips} trips</small>
        </div>
        {rider.isMember ? <Chip tone="plus">TYLO+</Chip> : null}
        {rider.walletCents > 0 && <Chip tone="good">{cents(rider.walletCents)}</Chip>}
      </div>

      <AnimatePresence mode="wait">
        {active ? (
          <motion.div key={active.state} {...fade}>
            <ActiveTrip trip={active} />
          </motion.div>
        ) : showReceipt ? (
          <motion.div key="receipt" {...fade}>
            <Receipt trip={last!} onDone={() => setDropoff(null)} />
          </motion.div>
        ) : (
          <motion.div key="book" {...fade} style={{ display: 'grid', gap: 12 }}>
            {showFailed && (
              <div className={`card ${last!.state === 'no_drivers_available' ? 'bad' : ''}`}>
                <b style={{ fontSize: 13 }}>{STATE_LABEL[last!.state]}</b>
                <p className="muted" style={{ margin: '4px 0 0', fontSize: 12 }}>
                  {last!.state === 'no_drivers_available'
                    ? 'Every driver in range declined or was busy. Nothing was charged.'
                    : last!.cancelFeeCents
                      ? `A ${cents(last!.cancelFeeCents)} cancellation fee was charged.`
                      : 'Nothing was charged.'}
                </p>
              </div>
            )}

            <div className="card tight" style={{ display: 'grid', gap: 8 }}>
              <button className="prod" style={{ gridTemplateColumns: '20px 1fr auto' }} onClick={() => setPicking('pickup')} aria-pressed={picking === 'pickup'}>
                <span style={{ color: 'var(--demand-bright)' }}>●</span>
                <span><small>Pickup</small><b style={{ fontSize: 12.5 }}>{pickup.label}</b></span>
                <span className="muted" style={{ fontSize: 11 }}>map</span>
              </button>
              <div className="field">
                <select
                  value={dropoff ? POIS.find((p) => p.name === dropoff.label)?.id ?? 'custom' : ''}
                  onChange={(e) => {
                    const poi = POIS.find((p) => p.id === e.target.value);
                    if (poi) setDropoff({ pos: poi.pos, label: poi.name });
                    else if (e.target.value === 'map') setPicking('dropoff');
                  }}
                >
                  <option value="" disabled>Where to?</option>
                  {POIS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  <option value="map">Pick on map…</option>
                  {dropoff && !POIS.some((p) => p.name === dropoff.label) && <option value="custom">{dropoff.label}</option>}
                </select>
              </div>
            </div>

            {dropoff && quotes && (
              <div className="prods">
                {quotes.map((q) => {
                  const p = config.products[q.product];
                  const undiscounted = q.fare.totalCents - q.fare.membershipDiscountCents - q.fare.promoDiscountCents;
                  const discounted = q.fare.membershipDiscountCents + q.fare.promoDiscountCents < 0;
                  return (
                    <button key={q.product} className="prod" aria-pressed={product === q.product} onClick={() => setProduct(q.product)}>
                      <span className="car">{CAR[q.product]}</span>
                      <span>
                        <b>{p.name}</b>
                        <small>{p.blurb} · {fmtEta(q.etaSec)} away</small>
                      </span>
                      <span className="p">
                        {discounted && <s>{cents(undiscounted)}</s>}
                        <b>{cents(q.fare.totalCents)}</b>
                        {q.surge > 1 && <small style={{ color: 'var(--supply-bright)' }}>{q.surge.toFixed(1)}× surge</small>}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}

            {dropoff && quote && (
              <div className="card tight">
                <div className="lbl" style={{ marginBottom: 6 }}>Fare breakdown</div>
                {quote.fare.lines.map((l, i) => (
                  <div className="kv" key={i}>
                    <span>{l.label}</span>
                    <b className={l.amount < 0 ? 'neg' : ''}>{l.amount < 0 ? '−' : ''}{cents(Math.abs(l.amount))}</b>
                  </div>
                ))}
                <div className="kv tot"><span>Total</span><b>{cents(quote.fare.totalCents)}</b></div>
              </div>
            )}

            <div className="field">
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  placeholder="Promo code"
                  value={promoInput}
                  onChange={(e) => setPromoInput(e.target.value.toUpperCase())}
                  style={{ textTransform: 'uppercase' }}
                />
                <button className="btn dark sm" disabled={!promoInput || !dropoff} onClick={() => { setPromoApplied(promoInput); setError(null); }}>
                  Apply
                </button>
              </div>
              {promoApplied && !error && <small style={{ color: 'var(--good-ink)' }}>✓ {promoApplied} applied</small>}
              {error && <small style={{ color: 'var(--crit-ink)' }}>{error}</small>}
              {!promoApplied && !error && <small className="muted">Try WELCOME50 · MIAMI5 · BEACHDAY · SPRING24</small>}
            </div>

            {!rider.isMember ? (
              <div className="card supply" style={{ display: 'grid', gap: 8 }}>
                <div>
                  <b style={{ fontSize: 13 }}>Tylo+ · {cents(config.membership.priceCents)}/mo</b>
                  <p className="muted" style={{ margin: '3px 0 0', fontSize: 11.5 }}>
                    {Math.round(config.membership.discountPct * 100)}% off every fare, priority dispatch, free cancellations.
                  </p>
                </div>
                <button className="btn sup sm" style={{ width: '100%' }} onClick={() => api('membership/subscribe')}>Join Tylo+</button>
              </div>
            ) : null}

            <button className="btn" disabled={!dropoff || !quote || busy} onClick={request}>
              {busy ? 'Requesting…' : dropoff && quote ? `Request ${config.products[product].name} · ${cents(quote.fare.totalCents)}` : 'Choose a destination'}
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {riderNotifs.length > 0 && (
        <div>
          <div className="lbl" style={{ marginBottom: 6 }}>Notifications</div>
          <div className="list">
            {riderNotifs.map((n) => (
              <div className="notif" key={n.id}>
                <span className={`ic ${n.tone === 'success' ? 'green' : n.tone === 'error' ? 'red' : n.tone === 'warn' ? 'amber' : 'blue'}`}>•</span>
                <p><b>{n.title}</b>{n.body}</p>
                <small>{clockOf(n.at)}</small>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ active trip */

function ActiveTrip({ trip }: { trip: Trip }) {
  const driver = useStore((s) => (trip.driverId ? s.drivers[trip.driverId] : null));
  const [policy, setPolicy] = useState<CancellationPolicy | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (trip.state === 'searching' || trip.state === 'requested') { setPolicy({ feeCents: 0, free: true, reason: 'No driver matched yet.' }); return; }
    const load = () => getJson<CancellationPolicy>(`rides/${trip.id}/cancellation`).then(setPolicy).catch(() => {});
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [trip.id, trip.state]);

  const cancel = async () => {
    setErr(null);
    try { await api(`rides/${trip.id}/cancel`); } catch (e) { setErr((e as Error).message); }
  };

  if (trip.state === 'searching' || trip.state === 'requested') {
    return (
      <div className="card accent">
        <div className="radar"><i /><i /><i /><b>Contacting drivers…</b></div>
        <p className="muted" style={{ textAlign: 'center', fontSize: 11.5, margin: '0 0 10px' }}>
          {trip.offersSent === 0 ? 'Ranking eligible drivers' : `${trip.offersSent} offer${trip.offersSent > 1 ? 's' : ''} sent · cascading on decline`}
        </p>
        <button className="btn danger" onClick={cancel}>Cancel — free</button>
        {err && <small style={{ color: 'var(--crit-ink)' }}>{err}</small>}
      </div>
    );
  }

  if (trip.state === 'driver_unreachable') {
    return (
      <div className="card bad">
        <b style={{ fontSize: 13 }}>Reconnecting to your driver…</b>
        <p className="muted" style={{ fontSize: 12, margin: '4px 0 0' }}>
          We lost {driver?.name ?? 'their'} signal. Your trip is held — if they don't return we'll find you another driver automatically.
        </p>
      </div>
    );
  }

  const onTrip = trip.state === 'in_progress';

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div className="card accent">
        <div style={{ display: 'flex', alignItems: 'center', gap: 11, marginBottom: 10 }}>
          <span className="av d">{driver?.initials}</span>
          <div style={{ flex: 1 }}>
            <b style={{ fontSize: 14 }}>{driver?.name}</b>
            <div className="muted" style={{ fontSize: 11.5 }}>
              ★ {driver?.rating.toFixed(2)} · {driver?.vehicle.color} {driver?.vehicle.make} {driver?.vehicle.model}
            </div>
          </div>
          <Chip tone="neutral">{driver?.vehicle.plate}</Chip>
        </div>

        <TripProgress trip={trip} />

        <div className="kv" style={{ marginTop: 8 }}>
          <span>{onTrip ? 'Dropping off at' : 'Picking up at'}</span>
          <b>{onTrip ? trip.dropoffLabel : trip.pickupLabel}</b>
        </div>
        {trip.surgeMultiplier > 1 && (
          <div className="kv"><span>Surge locked at request</span><b style={{ color: 'var(--supply-bright)' }}>{trip.surgeMultiplier.toFixed(1)}×</b></div>
        )}
        <div className="kv"><span>{onTrip ? 'Fare' : 'Estimated fare'}</span><b>{cents(trip.quotedFare.totalCents)}</b></div>
      </div>

      {!onTrip && policy && (
        <>
          <button className="btn danger" onClick={cancel}>
            Cancel {policy.free ? '— free' : `— ${cents(policy.feeCents)} fee`}
          </button>
          <small className="muted" style={{ marginTop: -6, fontSize: 11 }}>{policy.reason}</small>
        </>
      )}
      {err && <small style={{ color: 'var(--crit-ink)' }}>{err}</small>}
    </div>
  );
}

function TripProgress({ trip }: { trip: Trip }) {
  const simSec = useStore((s) => s.simSec);

  if (trip.state === 'driver_arrived') {
    return (
      <div className="card tight" style={{ background: 'rgba(12,163,12,0.1)', border: '1px solid rgba(12,163,12,0.3)', textAlign: 'center' }}>
        <b style={{ fontSize: 13, color: 'var(--good-ink)' }}>Your driver has arrived</b>
      </div>
    );
  }

  const onTrip = trip.state === 'in_progress';
  const start = onTrip ? trip.startedAt ?? simSec : trip.matchedAt ?? simSec;
  const total = onTrip ? trip.estMinutes * 60 : trip.predictedPickupEtaSec;
  const elapsed = simSec - start;
  const left = Math.max(0, total - elapsed);
  const pct = Math.min(100, (elapsed / Math.max(1, total)) * 100);

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
        <span style={{ fontSize: 12.5, color: 'var(--ink-2)' }}>{STATE_LABEL[trip.state]}</span>
        <b style={{ fontSize: 12.5 }} className="num">{left > 0 ? `${fmtEta(left)} away` : 'Arriving now'}</b>
      </div>
      <div className={`prog${onTrip ? '' : ' sup'}`}>
        <motion.i animate={{ width: `${pct}%` }} transition={{ ease: 'linear', duration: 0.4 }} />
      </div>
    </>
  );
}

/* ---------------------------------------------------------------- receipt */

const TIPS = [0, 0.1, 0.15, 0.2];

function Receipt({ trip, onDone }: { trip: Trip; onDone: () => void }) {
  const driver = useStore((s) => (trip.driverId ? s.drivers[trip.driverId] : null));
  const [stars, setStars] = useState(trip.rating ?? 0);
  const [helpOpen, setHelpOpen] = useState(false);
  const [category, setCategory] = useState('fare_dispute');
  const [message, setMessage] = useState('');
  const [sent, setSent] = useState(false);
  const fare = trip.finalFare!;

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <b style={{ fontSize: 15 }}>Trip complete</b>
          <span className="muted mono" style={{ fontSize: 11 }}>{trip.id}</span>
        </div>
        <p className="muted" style={{ fontSize: 11.5, margin: '2px 0 10px' }}>
          {trip.pickupLabel} → {trip.dropoffLabel} · {trip.actualMiles?.toFixed(1)} mi · {trip.actualMinutes?.toFixed(0)} min
        </p>
        {fare.lines.map((l, i) => (
          <div className="kv" key={i}>
            <span>{l.label}</span>
            <b className={l.amount < 0 ? 'neg' : ''}>{l.amount < 0 ? '−' : ''}{cents(Math.abs(l.amount))}</b>
          </div>
        ))}
        {trip.tipCents > 0 && <div className="kv"><span>Tip</span><b>{cents(trip.tipCents)}</b></div>}
        <div className="kv tot"><span>Charged</span><b>{cents(fare.totalCents + trip.tipCents)}</b></div>
      </div>

      {trip.tipCents === 0 && (
        <div className="card tight">
          <div className="lbl" style={{ marginBottom: 8 }}>Tip {driver?.name.split(' ')[0]} — they keep 100%</div>
          <div className="btnrow">
            {TIPS.map((t) => (
              <button key={t} className="btn dark sm" onClick={() => api(`rides/${trip.id}/tip`, { cents: Math.round(fare.totalCents * t) })}>
                {t === 0 ? 'No tip' : `${Math.round(t * 100)}%`}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="card tight">
        <div className="lbl" style={{ marginBottom: 8, textAlign: 'center' }}>Rate your driver</div>
        <div className="stars">
          {[1, 2, 3, 4, 5].map((n) => (
            <button key={n} className={n <= stars ? 'on' : ''} onClick={() => { setStars(n); api(`rides/${trip.id}/rate`, { stars: n }); }}>★</button>
          ))}
        </div>
      </div>

      {!helpOpen ? (
        <div className="btnrow">
          <button className="btn dark" onClick={() => setHelpOpen(true)}>Get help</button>
          <button className="btn" onClick={onDone}>Book another</button>
        </div>
      ) : sent ? (
        <div className="card">
          <b style={{ fontSize: 13, color: 'var(--good-ink)' }}>Ticket opened</b>
          <p className="muted" style={{ fontSize: 11.5, margin: '4px 0 0' }}>
            It's in the admin support queue now. Resolve it there — a refund posts straight to this wallet.
          </p>
        </div>
      ) : (
        <div className="card" style={{ display: 'grid', gap: 8 }}>
          <div className="field">
            <span className="lbl">What went wrong?</span>
            <select value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="fare_dispute">Fare dispute</option>
              <option value="lost_item">Lost item</option>
              <option value="driver_conduct">Driver conduct</option>
              <option value="safety">Safety concern</option>
              <option value="app_issue">App issue</option>
            </select>
          </div>
          <div className="field">
            <textarea placeholder="Tell us what happened…" value={message} onChange={(e) => setMessage(e.target.value)} />
          </div>
          <div className="btnrow">
            <button className="btn dark" onClick={() => setHelpOpen(false)}>Back</button>
            <button
              className="btn"
              disabled={!message.trim()}
              onClick={async () => {
                await api('support/tickets', { tripId: trip.id, category, subject: `${trip.id} · ${category.replace('_', ' ')}`, body: message });
                setSent(true);
              }}
            >Submit</button>
          </div>
        </div>
      )}
    </div>
  );
}
