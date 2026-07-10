import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  DEMAND_BY_HOUR, POIS, ZONES, clamp, isBay, positionAlong, routeBetween, simHour, zoneAt,
  type Driver, type ProductKey, type Rider, type Vec,
} from '@tylo/shared';
import { EventsService } from '../core/events.service';
import { StoreService } from '../core/store.service';
import { AiService } from '../engine/ai.service';
import { AnalyticsService } from '../engine/analytics.service';
import { DispatchService } from '../engine/dispatch.service';
import { SurgeService } from '../engine/surge.service';
import { TripsService } from '../engine/trips.service';

const TICK_MS = 100;
/**
 * Scales the zone demand curves down to what a 10-driver fleet can actually
 * serve. A driver turns over roughly 2.4 trips/hour once pickup and trip time
 * are counted, so ~24 rides/hour is the ceiling; we aim well under it so the
 * fleet stays ~60% utilised and a human rider can always get a car.
 */
const DEMAND_INTENSITY = 0.12;
const MAX_SIM_TRIPS = 5;

const RIDER_NAMES = [
  'Camila O.', 'Devon P.', 'Aisha K.', 'Luca F.', 'Mei T.', 'Owen B.', 'Sofia D.',
  'Noah G.', 'Priya S.', 'Mateo R.', 'Zara N.', 'Ethan W.', 'Ines V.', 'Jonah L.',
];

@Injectable()
export class WorldService implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;
  private acc = { dispatch: 0, surge: 0, metrics: 0, heat: 0 };
  private offerDecisionAt = new Map<string, number>();
  private completeAt = new Map<string, number>();
  private startAt = new Map<string, number>();
  private riderSeq = 100;
  private frame = 0;

  autoAcceptHuman = false;

  constructor(
    private readonly store: StoreService,
    private readonly events: EventsService,
    private readonly trips: TripsService,
    private readonly dispatch: DispatchService,
    private readonly surge: SurgeService,
    private readonly ai: AiService,
    private readonly analytics: AnalyticsService,
  ) {}

  onModuleInit() { this.timer = setInterval(() => this.tick(), TICK_MS); }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  setSpeed(speed: number) {
    this.store.speed = clamp(speed, 0, 32);
    this.events.emit('clock:speed', { speed: this.store.speed });
  }

  reset() {
    this.store.reset();
    this.offerDecisionAt.clear();
    this.completeAt.clear();
    this.startAt.clear();
    this.riderSeq = 100;
    this.events.emit('world:reset', {});
  }

  /* ------------------------------------------------------------------ tick */

  private tick(): void {
    const speed = this.store.speed;
    if (speed <= 0) return;
    const dt = (TICK_MS / 1000) * speed;
    this.store.simSec += dt;
    this.frame++;

    this.moveDrivers(dt);
    this.heartbeats();
    this.decideOffers();
    this.progressSimTrips();
    this.spawnDemand(dt);

    this.acc.dispatch += dt;
    if (this.acc.dispatch >= 0.5) { this.acc.dispatch = 0; this.dispatch.tick(); }

    this.acc.surge += dt;
    if (this.acc.surge >= 5) {
      this.acc.surge = 0;
      this.store.zoneStats = this.surge.recompute();
      this.events.emit('surge:update', this.store.zoneStats);
    }

    this.acc.heat += dt;
    if (this.acc.heat >= 2) {
      this.ai.decayHeat(this.acc.heat);
      this.acc.heat = 0;
      this.events.emit('heat:update', this.ai.heatSnapshot());
    }

    this.acc.metrics += dt;
    if (this.acc.metrics >= 5) {
      this.acc.metrics = 0;
      this.events.emit('metrics', this.analytics.metrics());
      this.prune();
    }

    this.events.emit('world:tick', {
      simSec: this.store.simSec,
      speed,
      drivers: [...this.store.drivers.values()].map((d) => ({
        id: d.id, x: d.pos.x, y: d.pos.y, heading: d.heading, state: d.state, connected: d.connected,
      })),
    });
  }

  /* --------------------------------------------------------------- driving */

  private moveDrivers(dt: number): void {
    for (const d of this.store.drivers.values()) {
      if (!d.online || !d.connected) continue;

      if (!d.route) {
        if (d.state === 'available' && Math.random() < 0.004 * dt * 60) this.cruise(d);
        continue;
      }

      const arrived = this.trips.advance(d, dt) === 'arrived';
      const p = positionAlong(d.route, d.routeElapsedSec);
      d.pos = p.pos;
      d.heading = p.heading;
      d.zone = zoneAt(p.pos);

      if (!arrived) continue;

      // Finished a repositioning cruise — nothing to report.
      if (!d.tripId) { d.route = null; d.routeElapsedSec = 0; continue; }

      const trip = this.store.trips.get(d.tripId);
      if (!trip) { d.route = null; continue; }

      if (trip.state === 'en_route_to_pickup') {
        this.trips.markArrived(trip);
        const wait = trip.isSimulated ? 6 + Math.random() * 10 : 4;
        this.startAt.set(trip.id, this.store.simSec + wait);
      } else if (trip.state === 'in_progress' && !this.completeAt.has(trip.id)) {
        // AI drivers close out immediately; a human taps "End trip", and we
        // auto-close after a grace period so the demo never wedges.
        this.completeAt.set(trip.id, this.store.simSec + (d.isHuman ? 25 : 0.5));
      }
    }
  }

  /** Idle drivers reposition toward demand rather than parking forever. */
  private cruise(d: Driver): void {
    const g = this.store.graph;
    const hot = this.store.zoneStats.slice().sort((a, b) => b.ratio - a.ratio)[0];
    const target: Vec = hot && Math.random() < 0.55
      ? this.randomPointIn(hot.zone)
      : g.nodes[Math.floor(Math.random() * g.nodes.length)].pos;

    const route = routeBetween(g, d.pos, target);
    if (route && route.legs.length) { d.route = route; d.routeElapsedSec = 0; }
  }

  /* ------------------------------------------------------------ heartbeats */

  private heartbeats(): void {
    const timeout = this.store.config.dispatch.heartbeatTimeoutSec;
    for (const d of this.store.drivers.values()) {
      if (d.connected) { d.lastPingAt = this.store.simSec; continue; }
      const gone = this.store.simSec - d.lastPingAt;
      if (gone > timeout) this.trips.markUnreachable(d);
      if (gone > timeout + 30) this.trips.reassign(d);
    }
  }

  setConnected(driverId: string, connected: boolean): Driver {
    const d = this.store.drivers.get(driverId)!;
    const was = d.connected;
    d.connected = connected;
    if (connected && !was) {
      d.lastPingAt = this.store.simSec;
      this.trips.resumeAfterReconnect(d);
    }
    this.events.emit('driver:update', d);
    return d;
  }

  /* ----------------------------------------------------- autonomous drivers */

  private decideOffers(): void {
    for (const offer of this.store.offers.values()) {
      const d = this.store.drivers.get(offer.driverId);
      if (!d) continue;
      if (d.isHuman && !this.autoAcceptHuman) continue;

      let at = this.offerDecisionAt.get(offer.id);
      if (at == null) {
        at = offer.issuedAt + 1.5 + Math.random() * 4.5;
        this.offerDecisionAt.set(offer.id, at);
      }
      if (this.store.simSec < at) continue;
      this.offerDecisionAt.delete(offer.id);

      // Decide from the hidden temperament, never from the observed rate —
      // otherwise a decline lowers the rate, which lowers the next decision,
      // and the fleet spirals into refusing everything.
      // Long pickups get declined more often. That is why dispatch cascades.
      const p = clamp(d.acceptPropensity - (offer.etaSec - 300) / 1200, 0.08, 0.98);
      try {
        if (Math.random() < p) this.dispatch.accept(d.id, offer.id);
        else this.dispatch.decline(d.id, offer.id);
      } catch { /* offer resolved underneath us; the next tick re-ranks */ }
    }
  }

  /* -------------------------------------------------------- trip automation */

  private progressSimTrips(): void {
    const now = this.store.simSec;

    for (const [tripId, at] of this.startAt) {
      if (now < at) continue;
      this.startAt.delete(tripId);
      const trip = this.store.trips.get(tripId);
      if (!trip || trip.state !== 'driver_arrived') continue;
      const driver = trip.driverId ? this.store.drivers.get(trip.driverId) : null;
      if (driver?.isHuman && !this.autoAcceptHuman) continue; // wait for the tap
      this.trips.startTrip(trip);
    }

    for (const [tripId, at] of this.completeAt) {
      if (now < at) continue;
      const trip = this.store.trips.get(tripId);
      if (!trip || trip.state !== 'in_progress') { this.completeAt.delete(tripId); continue; }
      this.completeAt.delete(tripId);
      this.trips.completeTrip(trip);

      if (trip.isSimulated) {
        if (Math.random() < 0.38) {
          const pct = [0.1, 0.15, 0.2][Math.floor(Math.random() * 3)];
          this.trips.addTip(trip.id, Math.round(trip.finalFare!.totalCents * pct));
        }
        this.trips.rate(trip.id, Math.random() < 0.86 ? 5 : 4);
      }
    }

    // A few simulated riders lose patience while searching.
    for (const trip of this.store.trips.values()) {
      if (!trip.isSimulated || trip.state !== 'searching') continue;
      if (now - trip.requestedAt > 25 && Math.random() < 0.0008) {
        try { this.trips.cancelByRider(trip.id); } catch { /* raced with dispatch */ }
      }
    }
  }

  /* ------------------------------------------------------------ demand sim */

  private spawnDemand(dt: number): void {
    const active = [...this.store.trips.values()].filter((t) => t.isSimulated &&
      !['completed', 'cancelled_by_rider', 'cancelled_by_driver', 'no_drivers_available'].includes(t.state)).length;
    if (active >= MAX_SIM_TRIPS) return;

    const hour = simHour(this.store.simSec);
    const curve = DEMAND_BY_HOUR[hour];

    for (const z of ZONES) {
      const lambda = z.demandPerHour * curve * DEMAND_INTENSITY;
      if (Math.random() > (lambda * dt) / 3600) continue;

      const pickup = this.randomPointIn(z.key);
      const dests = POIS.filter((p) => p.zone !== z.key);
      const dest = dests[Math.floor(Math.random() * dests.length)];
      if (!dest) continue;

      const rider = this.spawnRider(pickup);
      const product: ProductKey = Math.random() < 0.72 ? 'tylo_x' : Math.random() < 0.6 ? 'tylo_xl' : 'tylo_black';

      try {
        this.trips.request(rider.id, product, pickup, dest.pos,
          { pickup: this.trips.poiLabel(pickup), dropoff: dest.name }, null, true);
      } catch { /* no route / rider busy — skip this beat */ }
    }
  }

  private spawnRider(pos: Vec): Rider {
    const id = `R-${++this.riderSeq}`;
    const name = RIDER_NAMES[this.riderSeq % RIDER_NAMES.length];
    const rider: Rider = {
      id, name,
      initials: name.split(' ').map((w) => w[0]).join(''),
      rating: 4.6 + Math.random() * 0.4,
      isMember: Math.random() < 0.28,
      memberSince: null,
      completedTrips: Math.floor(Math.random() * 40),
      walletCents: 0,
      pos,
      isHuman: false,
    };
    this.store.riders.set(id, rider);
    return rider;
  }

  private randomPointIn(zoneKey: string): Vec {
    const z = ZONES.find((x) => x.key === zoneKey)!;
    for (let i = 0; i < 24; i++) {
      const p = {
        x: z.rect.x0 + Math.random() * (z.rect.x1 - z.rect.x0),
        y: z.rect.y0 + Math.random() * (z.rect.y1 - z.rect.y0),
      };
      if (!isBay(p)) return p;
    }
    return { x: (z.rect.x0 + z.rect.x1) / 2, y: (z.rect.y0 + z.rect.y1) / 2 };
  }

  /* ------------------------------------------------------------- bookkeeping */

  private prune(): void {
    const trips = [...this.store.trips.values()];
    if (trips.length <= 320) return;
    const removable = trips
      .filter((t) => t.isSimulated && ['completed', 'cancelled_by_rider', 'cancelled_by_driver', 'no_drivers_available'].includes(t.state))
      .sort((a, b) => a.requestedAt - b.requestedAt)
      .slice(0, trips.length - 320);
    for (const t of removable) {
      this.store.trips.delete(t.id);
      if (t.riderId !== this.store.humanRiderId) this.store.riders.delete(t.riderId);
    }
  }
}
