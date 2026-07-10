import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  dijkstraFrom, dist, driverFareBase, nearestNode, sid,
  type DispatchCandidate, type DispatchTrace, type Driver, type Offer, type Trip,
} from '@tylo/shared';
import { EventsService } from '../core/events.service';
import { StoreService } from '../core/store.service';
import { AiService } from './ai.service';
import { TripsService } from './trips.service';

interface Ctx {
  tripId: string;
  round: number;
  radiusMi: number;
  tried: Set<string>;
  offerId: string | null;
  /** Whether we have already given every driver a second chance. */
  secondPass: boolean;
}

/**
 * Real-time dispatch.
 *
 * A ride is not "assigned to the nearest driver". It is *offered*, in ranked
 * order, one driver at a time, with a countdown. Decline or time out and the
 * offer cascades to the next candidate. If the ranked list runs dry we widen
 * the search radius and try again, and only when that hits the ceiling does
 * the rider get told nobody is coming.
 *
 * Ranking is by road-network ETA — not crow-flies distance, which would send
 * drivers across the bay — nudged by reliability (acceptance rate, rating).
 * Tylo+ members are served first when trips compete for the same driver.
 */
@Injectable()
export class DispatchService {
  private ctxs = new Map<string, Ctx>();
  private traces = new Map<string, DispatchTrace>();

  constructor(
    private readonly store: StoreService,
    private readonly events: EventsService,
    private readonly ai: AiService,
    private readonly trips: TripsService,
  ) {}

  traceFor(tripId: string) { return this.traces.get(tripId) ?? null; }

  /* ---------------------------------------------------------------- tick */

  tick(): void {
    const now = this.store.simSec;

    for (const offer of [...this.store.offers.values()]) {
      if (now >= offer.expiresAt) this.resolveOffer(offer, 'timed_out');
    }

    // Housekeeping: a driver left holding an offer for a trip that died.
    for (const d of this.store.drivers.values()) {
      if (d.state === 'offered' && !this.store.offerFor(d.id)) {
        d.state = d.online ? 'available' : 'offline';
        this.events.emit('driver:update', d);
      }
    }

    for (const [tripId, ctx] of this.ctxs) {
      const trip = this.store.trips.get(tripId);
      if (!trip || trip.state !== 'searching') {
        if (!trip || trip.state !== 'driver_unreachable') this.ctxs.delete(tripId);
        continue;
      }
      if (!ctx.offerId) this.offerNext(trip, ctx);
    }

    // Tylo+ first, then oldest request. Priority only matters under contention.
    const waiting = [...this.store.trips.values()]
      .filter((t) => t.state === 'searching' && !this.ctxs.has(t.id))
      .sort((a, b) => {
        const am = this.store.riders.get(a.riderId)?.isMember ? 0 : 1;
        const bm = this.store.riders.get(b.riderId)?.isMember ? 0 : 1;
        if (am !== bm && this.store.config.membership.priorityDispatch) return am - bm;
        return a.requestedAt - b.requestedAt;
      });

    for (const trip of waiting) {
      const ctx: Ctx = {
        tripId: trip.id, round: 1,
        radiusMi: this.store.config.dispatch.initialRadiusMi,
        tried: new Set(), offerId: null, secondPass: false,
      };
      this.ctxs.set(trip.id, ctx);
      this.offerNext(trip, ctx);
    }
  }

  /* ----------------------------------------------------------- candidates */

  private rank(trip: Trip, ctx: Ctx): DispatchCandidate[] {
    const g = this.store.graph;
    const sp = dijkstraFrom(g, nearestNode(g, trip.pickup));

    const rows: DispatchCandidate[] = [];
    for (const d of this.store.drivers.values()) {
      if (!d.online || !d.connected) continue;
      if (!d.products.includes(trip.product)) continue;
      if (d.state !== 'available' && !ctx.tried.has(d.id)) continue;

      const distanceMi = dist(d.pos, trip.pickup);
      const rawEtaSec = sp.dist[nearestNode(g, d.pos)];
      if (!isFinite(rawEtaSec)) continue;

      const smartEtaSec = this.ai.correctEta(d.zone, rawEtaSec);
      const score = smartEtaSec + (1 - d.acceptanceRate) * 45 + (5 - d.rating) * 35;

      const outOfRadius = distanceMi > ctx.radiusMi;
      rows.push({
        driverId: d.id, driverName: d.name,
        distanceMi: Math.round(distanceMi * 100) / 100,
        rawEtaSec: Math.round(rawEtaSec),
        smartEtaSec: Math.round(smartEtaSec),
        rating: d.rating, acceptanceRate: d.acceptanceRate,
        score: Math.round(score),
        outcome: ctx.tried.has(d.id) ? 'declined' : outOfRadius ? 'skipped' : 'queued',
        reason: outOfRadius && !ctx.tried.has(d.id) ? `outside ${ctx.radiusMi.toFixed(1)} mi radius` : undefined,
      });
    }
    return rows.sort((a, b) => a.score - b.score);
  }

  private publishTrace(trip: Trip, ctx: Ctx, rows: DispatchCandidate[]) {
    const trace: DispatchTrace = {
      tripId: trip.id,
      riderIsMember: !!this.store.riders.get(trip.riderId)?.isMember,
      radiusMi: ctx.radiusMi,
      round: ctx.round,
      candidates: rows,
      at: this.store.simSec,
    };
    this.traces.set(trip.id, trace);
    this.events.emit('dispatch:trace', trace);
  }

  private offerNext(trip: Trip, ctx: Ctx): void {
    const cfg = this.store.config.dispatch;
    const waited = this.store.simSec - trip.requestedAt;

    let rows = this.rank(trip, ctx);
    let next = rows.find((r) => r.outcome === 'queued');

    // Nobody in this radius. Widen it until the ceiling.
    while (!next && ctx.radiusMi < cfg.maxRadiusMi) {
      ctx.radiusMi = Math.min(cfg.maxRadiusMi, ctx.radiusMi + cfg.radiusStepMi);
      ctx.round += 1;
      rows = this.rank(trip, ctx);
      next = rows.find((r) => r.outcome === 'queued');
    }

    // Still nobody, but everyone who said no is a candidate again after a while.
    if (!next && !ctx.secondPass && waited > 45) {
      ctx.secondPass = true;
      ctx.tried.clear();
      rows = this.rank(trip, ctx);
      next = rows.find((r) => r.outcome === 'queued');
    }

    if (!next) {
      // The fleet is simply busy. Hold the rider in the queue — a driver
      // finishing a trip in the next minute is a better outcome than a
      // premature "no drivers available".
      this.publishTrace(trip, ctx, rows);
      if (waited < cfg.searchTimeoutSec) return;
      this.ctxs.delete(trip.id);
      this.trips.noDrivers(trip);
      return;
    }

    if (trip.offersSent >= cfg.maxOffersPerTrip) {
      this.publishTrace(trip, ctx, rows);
      this.ctxs.delete(trip.id);
      this.trips.noDrivers(trip);
      return;
    }

    this.issue(trip, ctx, next);
  }

  private issue(trip: Trip, ctx: Ctx, cand: DispatchCandidate): void {
    const driver = this.store.drivers.get(cand.driverId)!;
    const share = 1 - this.store.config.commissionPct;

    const offer: Offer = {
      id: sid('off', 10),
      tripId: trip.id,
      driverId: driver.id,
      issuedAt: this.store.simSec,
      expiresAt: this.store.simSec + this.store.config.dispatch.offerTimeoutSec,
      etaSec: cand.smartEtaSec,
      estimatedEarningsCents: Math.round(driverFareBase(trip.quotedFare) * share),
    };

    this.store.offers.set(offer.id, offer);
    ctx.offerId = offer.id;
    ctx.tried.add(driver.id);
    trip.offersSent += 1;
    this.store.counters.offersSent += 1;

    driver.state = 'offered';
    this.events.emit('driver:update', driver);
    this.events.emit('trip:offer', { offer, trip, driver });

    const rows = this.rank(trip, ctx).map((r) =>
      r.driverId === driver.id ? { ...r, outcome: 'offered' as const } : r);
    this.publishTrace(trip, ctx, rows);
  }

  /* -------------------------------------------------------------- outcomes */

  private resolveOffer(offer: Offer, outcome: 'declined' | 'timed_out'): void {
    this.store.offers.delete(offer.id);
    const driver = this.store.drivers.get(offer.driverId);
    if (driver && driver.state === 'offered') {
      driver.state = driver.online ? 'available' : 'offline';
      // Acceptance rate is an EMA over answered offers (α = 0.06), not a
      // running penalty. A subtract-only counter walks every driver down to
      // the floor over a long shift and starves dispatch of candidates.
      driver.acceptanceRate = Math.max(0.15, driver.acceptanceRate * 0.94);
      this.events.emit('driver:update', driver);
    }
    const ctx = this.ctxs.get(offer.tripId);
    if (ctx && ctx.offerId === offer.id) ctx.offerId = null;

    this.events.emit('offer:cleared', { offerId: offer.id, driverId: offer.driverId, reason: outcome });

    const trip = this.store.trips.get(offer.tripId);
    if (trip && ctx) {
      const rows = this.rank(trip, ctx).map((r) =>
        r.driverId === offer.driverId ? { ...r, outcome, reason: outcome === 'timed_out' ? 'no response in time' : 'declined' } : r);
      this.publishTrace(trip, ctx, rows);
    }
  }

  accept(driverId: string, offerId?: string): Trip {
    const offer = offerId ? this.store.offers.get(offerId) : this.store.offerFor(driverId);
    if (!offer) throw new NotFoundException('That offer is no longer available');
    if (offer.driverId !== driverId) throw new BadRequestException('Offer belongs to another driver');
    if (this.store.simSec >= offer.expiresAt) {
      this.resolveOffer(offer, 'timed_out');
      throw new BadRequestException('That offer expired');
    }

    const trip = this.store.trips.get(offer.tripId);
    const driver = this.store.drivers.get(driverId);
    if (!trip || !driver) throw new NotFoundException('trip or driver');
    if (trip.state !== 'searching') throw new BadRequestException(`Trip is already ${trip.state}`);

    this.store.offers.delete(offer.id);
    this.ctxs.delete(trip.id);
    this.store.counters.offersAccepted += 1;

    const g = this.store.graph;
    const sp = dijkstraFrom(g, nearestNode(g, driver.pos));
    const rawEta = sp.dist[nearestNode(g, trip.pickup)];

    const ctxRows = this.traces.get(trip.id);
    if (ctxRows) {
      ctxRows.candidates = ctxRows.candidates.map((c) =>
        c.driverId === driverId ? { ...c, outcome: 'accepted' as const, reason: 'accepted' } : c);
      this.events.emit('dispatch:trace', ctxRows);
    }

    this.events.emit('offer:cleared', { offerId: offer.id, driverId, reason: 'accepted' });
    this.trips.onDriverAccepted(trip, driver, isFinite(rawEta) ? rawEta : offer.etaSec);
    return trip;
  }

  decline(driverId: string, offerId?: string): void {
    const offer = offerId ? this.store.offers.get(offerId) : this.store.offerFor(driverId);
    if (!offer) throw new NotFoundException('That offer is no longer available');
    this.resolveOffer(offer, 'declined');
  }
}
