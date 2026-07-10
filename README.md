# Tylo — premium ride-hailing platform

A working demo of the three systems a ride-hailing platform actually lives or dies on:
a **real-time dispatch engine**, **marketplace money movement**, and **driver trust & safety**.
Everything else — the wallet UI, promotions, the dashboard — is CRUD around them.

Nothing here is a clickable mock. Fares, Stripe Connect splits, ETAs, surge, the dispatch
ranking and the trip state machine are computed by the same engines an app of this shape
runs in production. The map is a live canvas over a real road graph.

```
npm install
npm run dev          # NestJS on :4000, Vite on :5173
```

Open **http://localhost:5173** and press `4×` in the top bar.

---

## What you can actually do

| Try this | What it proves |
|---|---|
| Driver app → flip **Go online** | Refused, `409`, with the reason. A pending insurance document blocks driving. The gate is server-side. |
| Admin → Drivers → **Verify** the document | Now the driver can go online. |
| Admin → Drivers → adjudicate **Nadia Roshan**'s "consider" background check | FCRA requires a human decision on a `consider` report. Nothing auto-rejects. |
| Rider app → destination → promo `WELCOME50` → Request | Watch **Dispatch trace** rank every eligible driver, offer to one at a time, and cascade when one declines. |
| Try `SPRING24`, `BEACHDAY`, `MIAMI5` | Typed rejections: `PROMO_EXPIRED`, `PROMO_USAGE_LIMIT_REACHED`, `PROMO_MIN_FARE_NOT_MET`. |
| Finish the ride, open Admin → Trips → click it | The FSM timeline, and the exact Connect split that settled it. |
| Driver app → **Kill the phone's signal** mid-trip | Heartbeat times out → `driver_unreachable` → rider is told → reassignment if he never returns. |
| Admin → Pricing → change **per-mile** | The rider's next quote uses it. Same code path, same cents. |
| Driver app → **Boost** | Demand heatmap, earnings optimiser with the arithmetic shown, and a smart-ETA model whose error you can watch fall. |
| Rider receipt → **Get help** → Admin → Support → refund | The refund posts to the ledger and lands in the rider's wallet. |

---

## Architecture

```
packages/shared     One domain package, imported by BOTH sides.
                    Road graph + Dijkstra, fare engine, Connect split,
                    trip FSM, promo rules, zones. The browser and the
                    server provably run the same fare math.

server              NestJS. Socket.IO gateway is the only place a
                    transport is mentioned; engines publish domain
                    events onto a bus.
                      engine/dispatch      offer cascade, radius expansion
                      engine/trips         the ONLY path to trip.state
                      engine/payments      ledger, Connect, payouts
                      engine/ai            heatmap, smart ETA, optimiser
                      engine/verification  documents + background checks
                      world/               10 Hz simulation of Miami

web                 React + Vite + Zustand + Framer Motion.
                    Canvas map renders at 60 fps off the store directly,
                    so 10 Hz vehicle motion never re-renders React.
```

### Three decisions worth defending

**Money is integer cents, everywhere.** No float ever touches a fare.

**The driver is paid on the pre-discount fare.** A promo is an acquisition cost the
platform funds — never a cut of the driver's pay. Run `WELCOME50` and the rider is
charged $5.28 while the driver earns $6.06; `application_fee` floors at zero and the
platform books a subsidy. That trip is net-negative *on purpose*.

**`trip.state` is only ever written by `transition()`.** An illegal edge is rejected and
logged (`fsm:reject` on the wire), not silently applied. That is what stops a trip from
ending up "in progress" with no driver after a reconnect or a double-tap.

### The AI, kept honest

The router only knows speed limits. Reality has traffic. Each completed pickup feeds an
EMA of `actual ÷ predicted` per zone, and the corrected estimate's error drops below the
raw router's within ~30 trips (**26.5% → 19.2%** MAPE at 22 samples; **18.1% → 7.7%** at 400).
The learned factors converge on the congestion the simulation actually applies — Downtown
lands near 1.4×. No magic, and it is measurable.

---

## Notes

- **Simulated**, not stubbed: Stripe Connect object shapes (`pi_`, `tr_`, `acct_`, `po_`),
  a Checkr-shaped background check. Swap the adapters for the real SDKs; the domain
  logic above them does not change.
- The console is deliberately omniscient — it renders the rider app, the driver app and
  the ops dashboard side by side. In production the same events are scoped to
  `rider:<id>`, `driver:<id>` and `admin` rooms.
- State is in-memory. A reset button re-seeds the world.
