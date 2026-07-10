import { motion } from 'framer-motion';
import { useState } from 'react';
import {
  STATE_LABEL, ZONES, cents, describePromo, isTerminal,
  type Driver, type PlatformConfig, type Promo, type Ticket, type Trip,
} from '@tylo/shared';
import { api, useStore } from '../lib/store';
import { Bars, ChartTable, GroupedBars, LineChart, SERIES, money, plain, secs } from './Charts';
import { Chip, clockOf } from '../ui/bits';

type Section = 'ops' | 'trips' | 'drivers' | 'payments' | 'promos' | 'support' | 'analytics' | 'pricing';

const NAV: { key: Section; label: string }[] = [
  { key: 'ops', label: 'Live ops' },
  { key: 'trips', label: 'Trips' },
  { key: 'drivers', label: 'Drivers' },
  { key: 'payments', label: 'Payments' },
  { key: 'promos', label: 'Promotions' },
  { key: 'support', label: 'Support' },
  { key: 'analytics', label: 'Analytics' },
  { key: 'pricing', label: 'Pricing & config' },
];

export function AdminApp() {
  const [section, setSection] = useState<Section>('ops');
  const drivers = useStore((s) => s.drivers);
  const tickets = useStore((s) => s.tickets);

  const queue = Object.values(drivers).filter((d) =>
    d.verification.backgroundCheck.status === 'consider' ||
    Object.values(d.verification.documents).some((x) => x !== 'verified')).length;
  const openTickets = tickets.filter((t) => t.status !== 'resolved').length;

  return (
    <main className="admin">
      <nav className="side">
        <div className="lbl">Operations</div>
        {NAV.map((n) => (
          <button key={n.key} aria-current={section === n.key} onClick={() => setSection(n.key)}>
            {n.label}
            {n.key === 'drivers' && queue > 0 && <span className="badge q">{queue}</span>}
            {n.key === 'support' && openTickets > 0 && <span className="badge">{openTickets}</span>}
          </button>
        ))}
      </nav>
      <div className="acontent">
        <motion.div key={section} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }}>
          {section === 'ops' && <Ops />}
          {section === 'trips' && <Trips />}
          {section === 'drivers' && <Drivers />}
          {section === 'payments' && <Payments />}
          {section === 'promos' && <Promos />}
          {section === 'support' && <Support />}
          {section === 'analytics' && <Analytics />}
          {section === 'pricing' && <Pricing />}
        </motion.div>
      </div>
    </main>
  );
}

function Head({ title, sub }: { title: string; sub: string }) {
  return <div className="ahead"><h1>{title}</h1><p>{sub}</p></div>;
}

function Tile({ k, v, s, tone }: { k: string; v: string; s?: string; tone?: 'up' | 'down' }) {
  return <div className="tile"><div className="k">{k}</div><div className="v">{v}</div>{s && <div className={`s ${tone ?? ''}`}>{s}</div>}</div>;
}

/* -------------------------------------------------------------- live ops */

function Ops() {
  const m = useStore((s) => s.metrics);
  const trips = useStore((s) => s.trips);
  const drivers = useStore((s) => s.drivers);
  const active = Object.values(trips).filter((t) => !isTerminal(t.state)).sort((a, b) => b.requestedAt - a.requestedAt);

  return (
    <>
      <Head title="Live operations" sub="Everything below is derived from the trip log and the ledger. No counter is incremented for the dashboard's benefit." />
      <div className="tiles">
        <Tile k="Active trips" v={String(m?.activeTrips ?? 0)} s={`${m?.requests ?? 0} requested today`} />
        <Tile k="Online drivers" v={String(m?.onlineDrivers ?? 0)} s={`${m?.busyDrivers ?? 0} on a trip`} />
        <Tile k="Utilisation" v={`${Math.round((m?.utilization ?? 0) * 100)}%`} s="busy ÷ online" />
        <Tile k="Acceptance" v={`${Math.round((m?.acceptanceRate ?? 0) * 100)}%`} s="offers accepted" />
        <Tile k="Avg pickup" v={`${((m?.avgPickupEtaSec ?? 0) / 60).toFixed(1)} min`} s="matched → arrived" />
        <Tile k="GMV" v={money(m?.gmvCents ?? 0)} s={`take ${((m?.takeRate ?? 0) * 100).toFixed(1)}%`} tone="up" />
      </div>

      <div className="panel">
        <header><h2>Trips in flight</h2><span className="lbl">{active.length} active</span></header>
        <div className="body flush scrollx">
          <table className="tbl">
            <thead><tr><th>Trip</th><th>State</th><th>Rider</th><th>Driver</th><th>Route</th><th className="r">Surge</th><th className="r">Fare</th></tr></thead>
            <tbody>
              {active.map((t) => (
                <tr key={t.id}>
                  <td className="m">{t.id}</td>
                  <td><TripChip state={t.state} /></td>
                  <td>{useStore.getState().riders[t.riderId]?.name ?? t.riderId}</td>
                  <td>{t.driverId ? drivers[t.driverId]?.name ?? t.driverId : <span className="muted">—</span>}</td>
                  <td className="muted" style={{ fontSize: 11.5 }}>{t.pickupLabel} → {t.dropoffLabel}</td>
                  <td className="r">{t.surgeMultiplier > 1 ? <span style={{ color: 'var(--supply-bright)' }}>{t.surgeMultiplier.toFixed(1)}×</span> : '—'}</td>
                  <td className="r">{cents(t.quotedFare.totalCents)}</td>
                </tr>
              ))}
              {!active.length && <tr><td colSpan={7} className="empty">No trips in flight. Request one from the rider app.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <header><h2>Supply &amp; demand by zone</h2><span className="lbl">surge = f(open requests ÷ idle drivers)</span></header>
        <div className="body flush scrollx">
          <table className="tbl">
            <thead><tr><th>Zone</th><th className="r">Open requests</th><th className="r">Idle drivers</th><th className="r">Ratio</th><th className="r">Surge</th><th className="r">Avg fare</th></tr></thead>
            <tbody>
              {(m?.zones ?? []).map((z) => (
                <tr key={z.zone}>
                  <td>{z.name}</td>
                  <td className="r">{z.openRequests}</td>
                  <td className="r">{z.availableDrivers}</td>
                  <td className="r">{z.ratio.toFixed(2)}</td>
                  <td className="r">{z.surge > 1 ? <Chip tone="warn">{z.surge.toFixed(1)}×</Chip> : <span className="muted">1.0×</span>}</td>
                  <td className="r">{z.avgFareCents ? cents(z.avgFareCents) : <span className="muted">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

function TripChip({ state }: { state: Trip['state'] }) {
  const tone = state === 'completed' ? 'ok'
    : state === 'in_progress' || state === 'driver_arrived' ? 'good'
    : state === 'driver_unreachable' ? 'warn'
    : state.startsWith('cancelled') || state === 'no_drivers_available' ? 'bad'
    : 'info';
  return <Chip tone={tone}>{STATE_LABEL[state]}</Chip>;
}

/* ----------------------------------------------------------------- trips */

function Trips() {
  const trips = useStore((s) => s.trips);
  const riders = useStore((s) => s.riders);
  const drivers = useStore((s) => s.drivers);
  const [open, setOpen] = useState<string | null>(null);
  const rows = Object.values(trips).sort((a, b) => b.requestedAt - a.requestedAt).slice(0, 80);
  const trip = open ? trips[open] : null;

  return (
    <>
      <Head title="Trips" sub="Click any trip to see its state-machine timeline and the exact Stripe Connect split that settled it." />
      <div className="grid2">
        <div className="panel">
          <header><h2>Recent trips</h2><span className="lbl">{rows.length}</span></header>
          <div className="body flush scrollx" style={{ maxHeight: 560, overflowY: 'auto' }}>
            <table className="tbl">
              <thead><tr><th>Trip</th><th>State</th><th className="r">Fare</th><th className="r">Net</th></tr></thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.id} className="clickable" onClick={() => setOpen(t.id)}>
                    <td className="m">{t.id}</td>
                    <td><TripChip state={t.state} /></td>
                    <td className="r">{cents((t.finalFare ?? t.quotedFare).totalCents)}</td>
                    <td className="r" style={{ color: (t.split?.platformNetCents ?? 0) < 0 ? 'var(--crit-ink)' : undefined }}>
                      {t.split ? cents(t.split.platformNetCents) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="panel">
          <header><h2>{trip ? trip.id : 'Trip detail'}</h2></header>
          <div className="body">
            {!trip ? <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>Select a trip.</p> : (
              <>
                <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
                  {riders[trip.riderId]?.name ?? trip.riderId} · {trip.driverId ? drivers[trip.driverId]?.name : 'unmatched'}<br />
                  {trip.pickupLabel} → {trip.dropoffLabel}
                </p>

                <div className="lbl" style={{ margin: '14px 0 8px' }}>State machine</div>
                <div className="fsm">
                  {trip.history.map((h, i) => (
                    <div key={i} className={`st ${h.state === 'completed' ? 'ok' : h.state.startsWith('cancelled') || h.state === 'no_drivers_available' ? 'bad' : h.state === 'driver_unreachable' ? 'warn' : ''}`}>
                      <i />
                      <div><b>{h.state}</b>{h.note && <small>{h.note}</small>}</div>
                      <time>{clockOf(h.at)}</time>
                    </div>
                  ))}
                </div>

                {trip.split && (
                  <>
                    <div className="lbl" style={{ margin: '16px 0 8px' }}>Stripe Connect · destination charge</div>
                    <div className="split">
                      <div className="r plus"><span>charge · {trip.split.objects.paymentIntent}</span><b>+{cents(trip.split.chargeCents)}</b></div>
                      <div className="r"><span>├ fare</span><b>{cents(trip.split.fareTotalCents)}</b></div>
                      {trip.split.tipCents > 0 && <div className="r"><span>└ tip (100% to driver)</span><b>{cents(trip.split.tipCents)}</b></div>}
                      <div className="r"><span>application_fee · {trip.split.objects.applicationFee}</span><b>−{cents(trip.split.applicationFeeCents)}</b></div>
                      <div className="r"><span>├ commission {(trip.split.platformCommissionCents / Math.max(1, trip.split.driverFareBaseCents) * 100).toFixed(0)}% of {cents(trip.split.driverFareBaseCents)}</span><b>{cents(trip.split.platformCommissionCents)}</b></div>
                      <div className="r"><span>└ booking fee</span><b>{cents(trip.split.bookingFeeCents)}</b></div>
                      {trip.split.platformSubsidyCents > 0 && (
                        <div className="r warn"><span>promo subsidy funded by platform</span><b>−{cents(trip.split.platformSubsidyCents)}</b></div>
                      )}
                      <div className="r"><span>transfer → {trip.split.objects.destination}</span><b>−{cents(trip.split.driverPayoutCents)}</b></div>
                      <div className="r"><span>stripe fee 2.9% + $0.30</span><b>−{cents(trip.split.stripeFeeCents)}</b></div>
                      <div className="r net"><span>platform net · take {(trip.split.takeRate * 100).toFixed(1)}%</span><b style={{ color: trip.split.platformNetCents < 0 ? 'var(--crit-ink)' : 'var(--good-ink)' }}>{cents(trip.split.platformNetCents)}</b></div>
                    </div>
                    {trip.split.platformSubsidyCents > 0 && (
                      <p className="muted" style={{ fontSize: 11, marginTop: 8, lineHeight: 1.5 }}>
                        This trip is net-negative on purpose. The driver is paid on the pre-discount fare;
                        the promo is an acquisition cost the platform funds, never a cut of the driver's pay.
                      </p>
                    )}
                  </>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

/* --------------------------------------------------------------- drivers */

function Drivers() {
  const drivers = useStore((s) => s.drivers);
  const rows = Object.values(drivers);
  const queue = rows.filter((d) => d.verification.backgroundCheck.status === 'consider' || Object.values(d.verification.documents).some((x) => x !== 'verified'));

  return (
    <>
      <Head title="Drivers &amp; verification" sub="Going online is gated server-side on documents, background check and admin approval. A client cannot route around it." />

      {queue.length > 0 && (
        <div className="panel">
          <header><h2>Verification queue</h2><span className="lbl">{queue.length} awaiting review</span></header>
          <div className="body" style={{ display: 'grid', gap: 12 }}>
            {queue.map((d) => <VerifyCard key={d.id} d={d} />)}
          </div>
        </div>
      )}

      <div className="panel">
        <header><h2>Fleet</h2></header>
        <div className="body flush scrollx">
          <table className="tbl">
            <thead><tr><th>Driver</th><th>Vehicle</th><th>State</th><th className="r">Rating</th><th className="r">Accept</th><th className="r">Trips</th><th className="r">Balance</th><th>Check</th></tr></thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.id}>
                  <td><b>{d.name}</b><div className="muted mono" style={{ fontSize: 10.5 }}>{d.stripeAccountId}</div></td>
                  <td className="muted" style={{ fontSize: 11.5 }}>{d.vehicle.year} {d.vehicle.make} {d.vehicle.model}<br />{d.vehicle.plate}</td>
                  <td><Chip tone={d.state === 'offline' ? 'neutral' : d.state === 'on_trip' ? 'good' : 'info'}>{d.state}</Chip></td>
                  <td className="r">{d.rating.toFixed(2)}</td>
                  <td className="r">{(d.acceptanceRate * 100).toFixed(0)}%</td>
                  <td className="r">{d.completedTrips}</td>
                  <td className="r">{cents(d.wallet.availableCents)}</td>
                  <td><Chip tone={d.verification.backgroundCheck.status === 'clear' ? 'ok' : d.verification.backgroundCheck.status === 'consider' ? 'warn' : 'bad'}>{d.verification.backgroundCheck.status}</Chip></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

function VerifyCard({ d }: { d: Driver }) {
  const bg = d.verification.backgroundCheck;
  const badDocs = Object.entries(d.verification.documents).filter(([, s]) => s !== 'verified');

  return (
    <div className="card">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
        <span className="av d">{d.initials}</span>
        <div style={{ flex: 1 }}>
          <b>{d.name}</b>
          <div className="muted" style={{ fontSize: 11.5 }}>{d.vehicle.year} {d.vehicle.make} {d.vehicle.model} · {bg.id}</div>
        </div>
        <Chip tone={bg.status === 'consider' ? 'warn' : 'neutral'}>{bg.status}</Chip>
      </div>

      {badDocs.length > 0 && (
        <div style={{ display: 'grid', gap: 6, marginBottom: 10 }}>
          {badDocs.map(([k, s]) => (
            <div key={k} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12.5 }}>
              <span>{k.replace(/_/g, ' ')} · <span className="muted">{s}</span></span>
              <button className="btn dark sm" onClick={() => api(`admin/drivers/${d.id}/documents/${k}`, { status: 'verified' })}>Verify</button>
            </div>
          ))}
        </div>
      )}

      {bg.status === 'consider' && (
        <>
          <ul style={{ margin: '0 0 10px', paddingLeft: 16, fontSize: 11.5, color: 'var(--ink-2)' }}>
            {bg.findings.map((f, i) => <li key={i} style={{ marginBottom: 2 }}>{f}</li>)}
          </ul>
          <div className="btnrow">
            <button className="btn danger" onClick={() => api(`admin/drivers/${d.id}/adjudicate`, { decision: 'suspend' })}>Adverse action</button>
            <button className="btn" onClick={() => api(`admin/drivers/${d.id}/adjudicate`, { decision: 'clear' })}>Clear to drive</button>
          </div>
          <p className="muted" style={{ fontSize: 10.5, marginTop: 8 }}>
            FCRA requires a human to adjudicate a "consider" report. Nothing here is automatic.
          </p>
        </>
      )}
    </div>
  );
}

/* -------------------------------------------------------------- payments */

function Payments() {
  const ledger = useStore((s) => s.ledger);
  const payouts = useStore((s) => s.payouts);
  const m = useStore((s) => s.metrics);

  return (
    <>
      <Head title="Payments &amp; payouts" sub="The platform's net income is literally the sum of the ledger column. Charges in, processing fees and transfers out." />
      <div className="tiles">
        <Tile k="GMV" v={money(m?.gmvCents ?? 0)} />
        <Tile k="Driver payouts" v={money(m?.driverPayoutCents ?? 0)} />
        <Tile k="Stripe fees" v={money(m?.stripeFeeCents ?? 0)} />
        <Tile k="Promo subsidy" v={money(m?.subsidyCents ?? 0)} s="platform-funded" />
        <Tile k="Refunds" v={money(m?.refundedCents ?? 0)} />
        <Tile k="Platform net" v={money(m?.platformNetCents ?? 0)} s={`take ${((m?.takeRate ?? 0) * 100).toFixed(1)}%`} tone={(m?.platformNetCents ?? 0) >= 0 ? 'up' : 'down'} />
      </div>

      <div className="panel">
        <header>
          <h2>Payout batches</h2>
          <button className="btn dark sm" onClick={() => api('admin/payouts/batch')}>Run standard payout batch</button>
        </header>
        <div className="body flush scrollx">
          <table className="tbl">
            <thead><tr><th>Payout</th><th>Driver</th><th>Method</th><th className="r">Gross</th><th className="r">Fee</th><th className="r">Net</th><th>Status</th></tr></thead>
            <tbody>
              {payouts.slice(0, 12).map((p) => (
                <tr key={p.id}>
                  <td className="m">{p.id}</td>
                  <td>{useStore.getState().drivers[p.driverId]?.name ?? p.driverId}</td>
                  <td>{p.method}</td>
                  <td className="r">{cents(p.amountCents)}</td>
                  <td className="r">{p.feeCents ? cents(p.feeCents) : '—'}</td>
                  <td className="r">{cents(p.netCents)}</td>
                  <td><Chip tone={p.status === 'paid' ? 'ok' : 'info'}>{p.status}</Chip></td>
                </tr>
              ))}
              {!payouts.length && <tr><td colSpan={7} className="empty">No payouts yet. Cash out from the driver app, or run the batch.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <header><h2>Ledger</h2><span className="lbl">newest first</span></header>
        <div className="body flush scrollx" style={{ maxHeight: 460, overflowY: 'auto' }}>
          <table className="tbl">
            <thead><tr><th>Time</th><th>Type</th><th>Account</th><th>Memo</th><th>Stripe object</th><th className="r">Amount</th></tr></thead>
            <tbody>
              {ledger.map((e) => (
                <tr key={e.id}>
                  <td className="m">{clockOf(e.at)}</td>
                  <td>{e.type}</td>
                  <td className="m">{e.account}</td>
                  <td className="muted" style={{ fontSize: 11.5 }}>{e.memo}</td>
                  <td className="m">{e.stripeObject ?? '—'}</td>
                  <td className="r" style={{ color: e.amountCents > 0 ? 'var(--good-ink)' : e.amountCents < 0 ? 'var(--ink-2)' : 'var(--ink-3)' }}>
                    {e.amountCents > 0 ? '+' : ''}{cents(e.amountCents)}
                  </td>
                </tr>
              ))}
              {!ledger.length && <tr><td colSpan={6} className="empty">No transactions yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

/* ---------------------------------------------------------------- promos */

function Promos() {
  const promos = useStore((s) => s.promos);
  const [form, setForm] = useState({ code: '', kind: 'percent' as Promo['kind'], value: 25, maxDiscountCents: 1000, minFareCents: 0, firstRideOnly: false });

  const create = async () => {
    await api<Promo>('admin/promos', {
      code: form.code, kind: form.kind, value: Number(form.value),
      maxDiscountCents: form.kind === 'percent' ? Number(form.maxDiscountCents) : null,
      minFareCents: Number(form.minFareCents) || null,
      firstRideOnly: form.firstRideOnly, usageLimit: null, used: 0,
      active: true, expiresAtSec: null,
      description: `${form.kind === 'percent' ? form.value + '% off' : cents(form.value) + ' off'}`,
    });
    setForm({ ...form, code: '' });
  };

  return (
    <>
      <Head title="Promotions" sub="Create a code here and it is immediately usable in the rider app. Validation returns a typed reason, not a boolean." />
      <div className="grid2">
        <div className="panel">
          <header><h2>Active codes</h2></header>
          <div className="body flush scrollx">
            <table className="tbl">
              <thead><tr><th>Code</th><th>Offer</th><th>Rules</th><th className="r">Used</th><th></th></tr></thead>
              <tbody>
                {promos.map((p) => (
                  <tr key={p.code}>
                    <td className="m"><b>{p.code}</b></td>
                    <td>{describePromo(p)}</td>
                    <td className="muted" style={{ fontSize: 11 }}>
                      {[p.firstRideOnly && 'first ride', p.minFareCents && `min ${cents(p.minFareCents)}`, p.usageLimit && `limit ${p.usageLimit}`, p.expiresAtSec != null && 'expired'].filter(Boolean).join(' · ') || 'no restrictions'}
                    </td>
                    <td className="r">{p.used}{p.usageLimit ? `/${p.usageLimit}` : ''}</td>
                    <td><button className="sw" aria-pressed={p.active} onClick={() => api(`admin/promos/${p.code}/active`, { active: !p.active })} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="panel">
          <header><h2>New campaign</h2></header>
          <div className="body" style={{ display: 'grid', gap: 10 }}>
            <div className="field"><span className="lbl">Code</span>
              <input value={form.code} placeholder="SUMMER25" onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} /></div>
            <div className="field"><span className="lbl">Type</span>
              <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as Promo['kind'] })}>
                <option value="percent">Percent off</option><option value="flat">Flat amount off</option>
              </select></div>
            <div className="field"><span className="lbl">{form.kind === 'percent' ? 'Percent' : 'Amount (cents)'}</span>
              <input type="number" value={form.value} onChange={(e) => setForm({ ...form, value: Number(e.target.value) })} /></div>
            {form.kind === 'percent' && (
              <div className="field"><span className="lbl">Max discount (cents)</span>
                <input type="number" value={form.maxDiscountCents} onChange={(e) => setForm({ ...form, maxDiscountCents: Number(e.target.value) })} /></div>
            )}
            <div className="field"><span className="lbl">Minimum fare (cents, 0 = none)</span>
              <input type="number" value={form.minFareCents} onChange={(e) => setForm({ ...form, minFareCents: Number(e.target.value) })} /></div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <button className="sw" aria-pressed={form.firstRideOnly} onClick={() => setForm({ ...form, firstRideOnly: !form.firstRideOnly })} />
              <span style={{ fontSize: 12.5 }}>First ride only</span>
            </div>
            <button className="btn" disabled={!form.code} onClick={create}>Create &amp; publish</button>
            <p className="muted" style={{ fontSize: 11, margin: 0 }}>
              The driver is always paid on the pre-discount fare — a promo is funded by the platform.
            </p>
          </div>
        </div>
      </div>
    </>
  );
}

/* --------------------------------------------------------------- support */

function Support() {
  const tickets = useStore((s) => s.tickets);
  const [open, setOpen] = useState<string | null>(null);
  const [reply, setReply] = useState('');
  const [refund, setRefund] = useState(500);
  const t: Ticket | undefined = open ? tickets.find((x) => x.id === open) : undefined;

  return (
    <>
      <Head title="Support centre" sub="Resolving with a refund actually moves money: it posts to the ledger and lands in the rider's wallet." />
      <div className="grid2">
        <div className="panel">
          <header><h2>Queue</h2><span className="lbl">{tickets.filter((x) => x.status !== 'resolved').length} open</span></header>
          <div className="body flush scrollx">
            <table className="tbl">
              <thead><tr><th>Ticket</th><th>Subject</th><th>Priority</th><th>Status</th></tr></thead>
              <tbody>
                {tickets.map((x) => (
                  <tr key={x.id} className="clickable" onClick={() => setOpen(x.id)}>
                    <td className="m">{x.id}</td>
                    <td>{x.subject}</td>
                    <td><Chip tone={x.priority === 'urgent' ? 'bad' : x.priority === 'high' ? 'warn' : 'neutral'}>{x.priority}</Chip></td>
                    <td><Chip tone={x.status === 'resolved' ? 'ok' : 'info'}>{x.status}</Chip></td>
                  </tr>
                ))}
                {!tickets.length && <tr><td colSpan={4} className="empty">No tickets. Open one from a completed trip receipt in the rider app.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>

        <div className="panel">
          <header><h2>{t ? t.id : 'Ticket'}</h2></header>
          <div className="body">
            {!t ? <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>Select a ticket.</p> : (
              <>
                <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                  <Chip tone="neutral">{t.category.replace(/_/g, ' ')}</Chip>
                  {t.tripId && <Chip tone="info">{t.tripId}</Chip>}
                  {t.refundedCents > 0 && <Chip tone="ok">refunded {cents(t.refundedCents)}</Chip>}
                </div>
                <div className="list" style={{ marginBottom: 12 }}>
                  {t.messages.map((m, i) => (
                    <div key={i}>
                      <div className="lbl" style={{ marginBottom: 3 }}>{m.from} · {clockOf(m.at)}</div>
                      <p style={{ margin: 0, fontSize: 12.5 }}>{m.body}</p>
                    </div>
                  ))}
                </div>

                {t.status !== 'resolved' && (
                  <>
                    <div className="field" style={{ marginBottom: 10 }}>
                      <textarea placeholder="Reply to the rider…" value={reply} onChange={(e) => setReply(e.target.value)} />
                    </div>
                    <div className="btnrow" style={{ marginBottom: 10 }}>
                      <button className="btn dark" disabled={!reply.trim()} onClick={async () => { await api(`admin/tickets/${t.id}/reply`, { body: reply }); setReply(''); }}>Send reply</button>
                    </div>
                    <div className="cfgrow" style={{ borderBottom: 'none' }}>
                      <div className="n"><b>Resolve with refund</b><small>Posts a refund to the ledger and the rider's wallet</small></div>
                      <input type="number" value={refund} onChange={(e) => setRefund(Number(e.target.value))} />
                    </div>
                    <div className="btnrow">
                      <button className="btn dark" onClick={() => api(`admin/tickets/${t.id}/resolve`, { refundCents: 0 })}>Resolve, no refund</button>
                      <button className="btn" onClick={() => api(`admin/tickets/${t.id}/resolve`, { refundCents: refund })}>Refund {cents(refund)}</button>
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

/* -------------------------------------------------------------- analytics */

function Analytics() {
  const m = useStore((s) => s.metrics);
  const [table, setTable] = useState(false);
  if (!m) return null;

  const b = m.buckets.slice(-14);
  const labels = b.map((x) => clockOf(x.t));

  const revenue = [
    { name: 'Driver payouts', color: SERIES[0], values: b.map((x) => x.driverPayoutCents) },
    { name: 'Platform net', color: SERIES[1], values: b.map((x) => x.platformNetCents) },
    { name: 'Processing fees', color: SERIES[2], values: b.map((x) => x.stripeFeeCents) },
  ];
  const etaSeries = [
    { name: 'Predicted pickup', color: SERIES[0], values: b.map((x) => (x.etaSamples ? x.predictedEtaSec / x.etaSamples : 0)) },
    { name: 'Actual pickup', color: SERIES[1], values: b.map((x) => (x.etaSamples ? x.actualEtaSec / x.etaSamples : 0)) },
  ];
  const zoneLabels = ZONES.map((z) => z.short);
  const zoneSeries = [
    { name: 'Open requests', color: SERIES[0], values: ZONES.map((z) => m.zones.find((x) => x.zone === z.key)?.openRequests ?? 0) },
    { name: 'Idle drivers', color: SERIES[1], values: ZONES.map((z) => m.zones.find((x) => x.zone === z.key)?.availableDrivers ?? 0) },
  ];
  const outcomeLabels = ['Completed', 'Rider cancel', 'Driver cancel', 'No drivers'];
  const outcomes = [m.completed, m.cancelledByRider, m.cancelledByDriver, m.noDrivers];

  return (
    <>
      <Head title="Analytics" sub="Every figure is computed from the trip log and the ledger at read time. Buckets are two simulated minutes wide." />
      <div className="tiles">
        <Tile k="Completed" v={String(m.completed)} s={`of ${m.requests} requested`} />
        <Tile k="Avg fare" v={money(m.avgFareCents)} s={`tips ${money(m.tipsCents)}`} />
        <Tile k="Take rate" v={`${(m.takeRate * 100).toFixed(1)}%`} s="net ÷ GMV" />
        <Tile k="Cancellation" v={`${(m.cancellationRate * 100).toFixed(1)}%`} s="of closed trips" />
        <Tile k="ETA error" v={`${m.eta.mapeCorrected.toFixed(1)}%`} s={`router alone ${m.eta.mapeRaw.toFixed(1)}%`} tone={m.eta.mapeCorrected < m.eta.mapeRaw ? 'up' : undefined} />
        <Tile k="Utilisation" v={`${(m.utilization * 100).toFixed(0)}%`} s={`${m.busyDrivers}/${m.onlineDrivers} drivers`} />
      </div>

      <div className="panel">
        <header>
          <h2>Charts</h2>
          <button className="ghost" aria-pressed={table} onClick={() => setTable((v) => !v)}>{table ? 'Show charts' : 'Show table view'}</button>
        </header>
        <div className="body">
          <div className="charts">
            <Card title="Where the money goes" note="One axis. Platform net dips below zero on promo-subsidised trips.">
              {table ? <ChartTable labels={labels} series={revenue} fmt={money} /> : <LineChart series={revenue} labels={labels} fmt={money} zeroLine />}
            </Card>
            <Card title="Pickup ETA — promised vs actual" note="Both in seconds, so they share one axis honestly.">
              {table ? <ChartTable labels={labels} series={etaSeries} fmt={secs} /> : <LineChart series={etaSeries} labels={labels} fmt={secs} />}
            </Card>
            <Card title="Supply and demand by zone" note="The two inputs to the surge multiplier.">
              {table ? <ChartTable labels={zoneLabels} series={zoneSeries} fmt={plain} /> : <GroupedBars series={zoneSeries} labels={zoneLabels} fmt={plain} />}
            </Card>
            <Card title="Trip outcomes" note="One series, one colour — the labels carry the meaning.">
              {table
                ? <ChartTable labels={outcomeLabels} series={[{ name: 'Trips', color: SERIES[0], values: outcomes }]} fmt={plain} />
                : <Bars labels={outcomeLabels} values={outcomes} fmt={plain} />}
            </Card>
          </div>
        </div>
      </div>
    </>
  );
}

function Card({ title, note, children }: { title: string; note: string; children: React.ReactNode }) {
  return (
    <div className="panel" style={{ margin: 0 }}>
      <header><h2>{title}</h2></header>
      <div className="body" style={{ paddingBottom: 4 }}>{children}</div>
      <p className="muted" style={{ fontSize: 11, margin: 0, padding: '0 15px 14px' }}>{note}</p>
    </div>
  );
}

/* ---------------------------------------------------------------- pricing */

function Pricing() {
  const config = useStore((s) => s.config);
  if (!config) return null;

  const patch = (p: Partial<PlatformConfig>) => api('admin/config', p, 'PATCH');
  const num = (v: string) => Number(v) || 0;

  return (
    <>
      <Head title="Pricing &amp; configuration" sub="These write straight through to the fare engine. Change a number and the rider app's next quote uses it — same code path, same cents." />

      <div className="grid2">
        <div className="panel">
          <header><h2>Products</h2><span className="lbl">amounts in cents</span></header>
          <div className="body">
            {Object.values(config.products).map((p) => (
              <div key={p.key} style={{ marginBottom: 18 }}>
                <b style={{ fontSize: 13 }}>{p.name}</b>
                {([['baseCents', 'Base fare'], ['perMileCents', 'Per mile'], ['perMinuteCents', 'Per minute'], ['bookingFeeCents', 'Booking fee'], ['minFareCents', 'Minimum fare'], ['cancelFeeCents', 'Cancellation fee']] as const).map(([k, label]) => (
                  <div className="cfgrow" key={k}>
                    <div className="n"><b>{label}</b></div>
                    <input type="number" defaultValue={p[k]} onBlur={(e) => patch({ products: { [p.key]: { [k]: num(e.target.value) } } } as never)} />
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>

        <div>
          <div className="panel">
            <header><h2>Marketplace economics</h2></header>
            <div className="body">
              <div className="cfgrow">
                <div className="n"><b>Commission</b><small>Platform's cut of the pre-discount fare</small></div>
                <input type="number" step="0.01" defaultValue={config.commissionPct} onBlur={(e) => patch({ commissionPct: num(e.target.value) })} />
              </div>
              <div className="cfgrow">
                <div className="n"><b>Airport surcharge</b><small>Applied when either end is MIA</small></div>
                <input type="number" defaultValue={config.airportSurchargeCents} onBlur={(e) => patch({ airportSurchargeCents: num(e.target.value) })} />
              </div>
              <div className="cfgrow">
                <div className="n"><b>Tylo+ price</b><small>per month</small></div>
                <input type="number" defaultValue={config.membership.priceCents} onBlur={(e) => patch({ membership: { priceCents: num(e.target.value) } } as never)} />
              </div>
              <div className="cfgrow">
                <div className="n"><b>Tylo+ discount</b><small>fraction off the fare</small></div>
                <input type="number" step="0.01" defaultValue={config.membership.discountPct} onBlur={(e) => patch({ membership: { discountPct: num(e.target.value) } } as never)} />
              </div>
            </div>
          </div>

          <div className="panel">
            <header><h2>Dispatch</h2></header>
            <div className="body">
              {([['offerTimeoutSec', 'Offer timeout', 'seconds a driver has to answer'],
                 ['maxOffersPerTrip', 'Max offers', 'before we admit nobody is coming'],
                 ['initialRadiusMi', 'Initial radius', 'miles'],
                 ['maxRadiusMi', 'Max radius', 'miles'],
                 ['searchTimeoutSec', 'Search timeout', 'hold the rider while the fleet is busy'],
                 ['arrivalGraceSec', 'Free-cancel grace', 'seconds after matching']] as const).map(([k, label, sub]) => (
                <div className="cfgrow" key={k}>
                  <div className="n"><b>{label}</b><small>{sub}</small></div>
                  <input type="number" step="0.1" defaultValue={config.dispatch[k]} onBlur={(e) => patch({ dispatch: { [k]: num(e.target.value) } } as never)} />
                </div>
              ))}
            </div>
          </div>

          <div className="panel">
            <header><h2>Surge</h2></header>
            <div className="body">
              <div className="cfgrow">
                <div className="n"><b>Surge pricing</b><small>Turn it off and every quote drops to 1.0×</small></div>
                <button className="sw" aria-pressed={config.surge.enabled} onClick={() => patch({ surge: { enabled: !config.surge.enabled } } as never)} />
              </div>
              <div className="cfgrow">
                <div className="n"><b>Sensitivity</b><small>multiplier per unit of demand/supply ratio</small></div>
                <input type="number" step="0.01" defaultValue={config.surge.sensitivity} onBlur={(e) => patch({ surge: { sensitivity: num(e.target.value) } } as never)} />
              </div>
              <div className="cfgrow">
                <div className="n"><b>Ceiling</b><small>hard cap on the multiplier</small></div>
                <input type="number" step="0.1" defaultValue={config.surge.maxMultiplier} onBlur={(e) => patch({ surge: { maxMultiplier: num(e.target.value) } } as never)} />
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
