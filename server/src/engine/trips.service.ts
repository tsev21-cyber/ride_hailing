import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  POI_BY_ID, ZONE_BY_KEY, cents, congestion, fmtEta, hasDriver, quoteFare, riderCancellationPolicy,
  routeBetween, simHour, transition, validatePromo, zoneAt,
  type Driver, type FareBreakdown, type Promo, type ProductKey, type Rider,
  type Route, type Trip, type TripState, type Vec,
} from '@tylo/shared';
import { EventsService } from '../core/events.service';
import { StoreService } from '../core/store.service';
import { AiService } from './ai.service';
import { PaymentsService } from './payments.service';
import { PromosService } from './promos.service';
import { SurgeService } from './surge.service';

export interface QuoteResult {
  product: ProductKey;
  fare: FareBreakdown;
  route: Route;
  surge: number;
  etaSec: number;
  promoError?: string;
}

@Injectable()
export class TripsService {
  private seq = 1000;

  constructor(
    private readonly store: StoreService,
    private readonly events: EventsService,
    private readonly payments: PaymentsService,
    private readonly promos: PromosService,
    private readonly surge: SurgeService,
    private readonly ai: AiService,
  ) {}

  /* ------------------------------------------------------------ helpers */

  private notify(audience: 'rider' | 'driver' | 'admin', title: string, body: string, tone = 'info', target?: string) {
    this.events.emit('notify', {
      id: `n${Math.random().toString(36).slice(2, 9)}`,
      audience, target, title, body, tone, at: this.store.simSec,
    });
  }

  private emitTrip(trip: Trip) { this.events.emit('trip:update', trip); }

  /** The only path to `trip.state`. An illegal edge is surfaced, not swallowed. */
  private go(trip: Trip, to: TripState, note?: string): boolean {
    const r = transition(trip, to, this.store.simSec, note);
    if (!r.ok) {
      this.events.emit('fsm:reject', { tripId: trip.id, from: r.from, to: r.to, error: r.error });
      return false;
    }
    this.emitTrip(trip);
    return true;
  }

  private setRoute(driver: Driver, route: Route | null, phase: 'pickup' | 'trip') {
    driver.route = route;
    driver.routeElapsedSec = 0;
    this.events.emit('route:update', route
      ? { driverId: driver.id, tripId: driver.tripId, points: route.points, phase }
      : { driverId: driver.id, tripId: null, points: [], phase });
  }

  /* ------------------------------------------------------------- quoting */

  quote(riderId: string, product: ProductKey, pickup: Vec, dropoff: Vec, promoCode?: string | null): QuoteResult {
    const rider = this.store.riders.get(riderId);
    if (!rider) throw new NotFoundException('rider');

    const route = routeBetween(this.store.graph, pickup, dropoff);
    if (!route) throw new BadRequestException('No road route between those points');

    const pickupZone = zoneAt(pickup);
    const dropoffZone = zoneAt(dropoff);
    const surge = this.surge.multiplierFor(pickupZone);

    // The router gives free-flow seconds. Riders get the corrected estimate.
    const etaSec = this.ai.correctEta(pickupZone, route.seconds);
    const minutes = etaSec / 60;

    const airport = ZONE_BY_KEY[pickupZone].airport || ZONE_BY_KEY[dropoffZone].airport;

    let promo: Promo | null = null;
    let promoError: string | undefined;
    if (promoCode) {
      const dry = quoteFare({
        config: this.store.config, product, miles: route.miles, minutes,
        surgeMultiplier: surge, isMember: rider.isMember, promo: null, airport,
      });
      const res = validatePromo(this.store.promos.get(promoCode.trim().toUpperCase()), {
        isFirstRide: rider.completedTrips === 0,
        fareCents: dry.totalCents,
        nowSec: this.store.simSec,
      });
      if (res.ok) promo = res.promo; else promoError = res.message;
    }

    const fare = quoteFare({
      config: this.store.config, product, miles: route.miles, minutes,
      surgeMultiplier: surge, isMember: rider.isMember, promo, airport,
    });

    return { product, fare, route, surge, etaSec, promoError };
  }

  /** Live prices for every product, which is what the rider actually sees. */
  quoteAll(riderId: string, pickup: Vec, dropoff: Vec, promoCode?: string | null): QuoteResult[] {
    return (['tylo_x', 'tylo_black', 'tylo_xl'] as ProductKey[])
      .map((p) => this.quote(riderId, p, pickup, dropoff, promoCode));
  }

  /* ------------------------------------------------------------ requesting */

  request(
    riderId: string, product: ProductKey, pickup: Vec, dropoff: Vec,
    labels: { pickup: string; dropoff: string }, promoCode: string | null, isSimulated = false,
  ): Trip {
    const rider = this.store.riders.get(riderId);
    if (!rider) throw new NotFoundException('rider');

    const open = this.store.tripsOf(riderId).find((t) => hasDriver(t.state) || t.state === 'searching' || t.state === 'requested');
    if (open) throw new BadRequestException(`You already have an active trip (${open.id})`);

    const q = this.quote(riderId, product, pickup, dropoff, promoCode);
    if (q.promoError) throw new BadRequestException(q.promoError);

    const pickupZone = zoneAt(pickup);
    const trip: Trip = {
      id: `T-${++this.seq}`,
      riderId, driverId: null, product,
      state: 'requested',
      history: [{ state: 'requested', at: this.store.simSec }],
      pickup, dropoff, pickupZone, dropoffZone: zoneAt(dropoff),
      pickupLabel: labels.pickup, dropoffLabel: labels.dropoff,
      requestedAt: this.store.simSec,
      rawPickupEtaSec: 0, predictedPickupEtaSec: 0,
      quotedFare: q.fare,
      surgeMultiplier: q.surge,
      promoCode: promoCode ? promoCode.trim().toUpperCase() : null,
      estMiles: q.route.miles,
      estMinutes: q.etaSec / 60,
      tipCents: 0,
      offersSent: 0,
      isSimulated,
    };

    this.store.trips.set(trip.id, trip);
    this.store.counters.requests += 1;
    this.ai.noteRequest(pickup);

    this.emitTrip(trip);
    this.go(trip, 'searching', 'dispatch engine engaged');

    if (!isSimulated) {
      this.notify('rider', 'Looking for a driver', `${q.fare.surgeMultiplier > 1 ? `${q.fare.surgeMultiplier.toFixed(1)}× surge · ` : ''}${cents(q.fare.totalCents)} estimated`, 'info', riderId);
    }
    return trip;
  }

  noDrivers(trip: Trip): void {
    if (!this.go(trip, 'no_drivers_available', 'no candidate driver within max radius')) return;
    this.store.counters.noDrivers += 1;
    if (!trip.isSimulated) {
      this.notify('rider', 'No drivers nearby', 'We could not reach a driver. Nothing was charged.', 'error', trip.riderId);
    }
  }

  /* ------------------------------------------------------------- matching */

  onDriverAccepted(trip: Trip, driver: Driver, rawEtaSec: number): void {
    trip.driverId = driver.id;
    trip.matchedAt = this.store.simSec;
    trip.rawPickupEtaSec = rawEtaSec;
    trip.predictedPickupEtaSec = this.ai.correctEta(driver.zone, rawEtaSec);
    trip.offersSent += 1;

    if (!this.go(trip, 'matched', `${driver.name} accepted`)) return;

    driver.state = 'en_route';
    driver.tripId = trip.id;
    driver.acceptanceRate = Math.min(1, driver.acceptanceRate * 0.94 + 0.06);

    const route = routeBetween(this.store.graph, driver.pos, trip.pickup);
    this.setRoute(driver, route, 'pickup');
    this.events.emit('driver:update', driver);

    this.go(trip, 'en_route_to_pickup');

    if (!trip.isSimulated) {
      this.notify('rider', `${driver.name} is on the way`,
        `${driver.vehicle.color} ${driver.vehicle.make} ${driver.vehicle.model} · ${driver.vehicle.plate} · ${fmtEta(trip.predictedPickupEtaSec)} away`,
        'success', trip.riderId);
    }
  }

  markArrived(trip: Trip): void {
    const driver = this.store.drivers.get(trip.driverId!)!;
    if (!this.go(trip, 'driver_arrived')) return;

    trip.arrivedAt = this.store.simSec;
    trip.actualPickupEtaSec = trip.arrivedAt - (trip.matchedAt ?? trip.arrivedAt);

    // Feed the ETA model the one thing it can learn from: a real pickup leg.
    this.ai.learnEta(trip.pickupZone, trip.rawPickupEtaSec, trip.actualPickupEtaSec);
    this.setRoute(driver, null, 'pickup');

    if (!trip.isSimulated) {
      this.notify('rider', 'Your driver has arrived', `${driver.vehicle.plate} is waiting at ${trip.pickupLabel}.`, 'success', trip.riderId);
    }
  }

  startTrip(trip: Trip): void {
    const driver = this.store.drivers.get(trip.driverId!)!;
    if (!this.go(trip, 'in_progress')) return;

    trip.startedAt = this.store.simSec;
    driver.state = 'on_trip';
    this.setRoute(driver, routeBetween(this.store.graph, driver.pos, trip.dropoff), 'trip');
    this.events.emit('driver:update', driver);
  }

  completeTrip(trip: Trip): void {
    const driver = this.store.drivers.get(trip.driverId!)!;
    const rider = this.store.riders.get(trip.riderId)!;

    const durationSec = this.store.simSec - (trip.startedAt ?? this.store.simSec);
    trip.actualMinutes = durationSec / 60;
    trip.actualMiles = driver.route?.miles ?? trip.estMiles;

    const promo = trip.promoCode ? this.store.promos.get(trip.promoCode) ?? null : null;
    trip.finalFare = quoteFare({
      config: this.store.config,
      product: trip.product,
      miles: trip.actualMiles,
      minutes: trip.actualMinutes,
      surgeMultiplier: trip.surgeMultiplier,   // locked at request time — never re-surged
      isMember: rider.isMember,
      promo,
      airport: ZONE_BY_KEY[trip.pickupZone].airport || ZONE_BY_KEY[trip.dropoffZone].airport,
    });

    if (!this.go(trip, 'completed')) return;
    trip.endedAt = this.store.simSec;

    this.payments.settleTrip(trip, driver, rider);
    if (promo) this.promos.consume(promo.code);

    driver.state = 'available';
    driver.tripId = null;
    driver.completedTrips += 1;
    this.setRoute(driver, null, 'trip');
    rider.completedTrips += 1;
    rider.pos = trip.dropoff;

    this.store.counters.completed += 1;
    this.events.emit('driver:update', driver);
    this.events.emit('rider:update', rider);
    this.emitTrip(trip);

    if (!trip.isSimulated) {
      this.notify('rider', 'Trip complete', `${cents(trip.finalFare.totalCents)} charged. Add a tip?`, 'success', trip.riderId);
    }
    this.notify('driver', 'You earned', `${cents(trip.split!.driverPayoutCents)} for ${trip.id}`, 'supply', driver.id);
  }

  /* ---------------------------------------------------------- cancelling */

  cancellationQuote(tripId: string) {
    const trip = this.store.trips.get(tripId);
    if (!trip) throw new NotFoundException('trip');
    const rider = this.store.riders.get(trip.riderId)!;
    return riderCancellationPolicy(trip, this.store.config, rider.isMember, this.store.simSec);
  }

  cancelByRider(tripId: string): Trip {
    const trip = this.store.trips.get(tripId);
    if (!trip) throw new NotFoundException('trip');
    const rider = this.store.riders.get(trip.riderId)!;
    const policy = riderCancellationPolicy(trip, this.store.config, rider.isMember, this.store.simSec);
    const driver = trip.driverId ? this.store.drivers.get(trip.driverId)! : null;

    if (!this.go(trip, 'cancelled_by_rider', policy.free ? 'no fee' : `fee ${cents(policy.feeCents)}`)) {
      throw new BadRequestException(`Cannot cancel a trip in state "${trip.state}"`);
    }
    this.store.counters.cancelledByRider += 1;
    this.releaseDriver(driver);
    this.payments.chargeCancellationFee(trip, rider, driver, policy.feeCents);
    this.clearOffersFor(trip.id);

    this.notify('rider', 'Trip cancelled',
      policy.free ? 'No cancellation fee was charged.' : `${cents(policy.feeCents)} cancellation fee charged.`,
      policy.free ? 'info' : 'warn', trip.riderId);
    this.emitTrip(trip);
    return trip;
  }

  cancelByDriver(tripId: string): Trip {
    const trip = this.store.trips.get(tripId);
    if (!trip) throw new NotFoundException('trip');
    const driver = trip.driverId ? this.store.drivers.get(trip.driverId)! : null;

    if (!this.go(trip, 'cancelled_by_driver', driver ? `${driver.name} cancelled` : undefined)) {
      throw new BadRequestException(`Cannot cancel a trip in state "${trip.state}"`);
    }
    this.store.counters.cancelledByDriver += 1;

    if (driver) {
      // Cancelling after accepting costs the driver their acceptance rate.
      driver.acceptanceRate = Math.max(0.2, driver.acceptanceRate - 0.05);
      this.releaseDriver(driver);
    }
    this.clearOffersFor(trip.id);
    this.notify('rider', 'Your driver cancelled', 'Nothing was charged. Request again to find another driver.', 'error', trip.riderId);
    this.emitTrip(trip);
    return trip;
  }

  private releaseDriver(driver: Driver | null) {
    if (!driver) return;
    driver.state = driver.online ? 'available' : 'offline';
    driver.tripId = null;
    this.setRoute(driver, null, 'pickup');
    this.events.emit('driver:update', driver);
  }

  clearOffersFor(tripId: string) {
    for (const [id, o] of this.store.offers) {
      if (o.tripId === tripId) {
        this.store.offers.delete(id);
        this.events.emit('offer:cleared', { offerId: id, driverId: o.driverId, reason: 'trip_closed' });
      }
    }
  }

  /* ------------------------------------------- connection loss / recovery */

  markUnreachable(driver: Driver): void {
    if (!driver.tripId) return;
    const trip = this.store.trips.get(driver.tripId);
    if (!trip) return;
    if (this.go(trip, 'driver_unreachable', 'heartbeat timeout')) {
      this.notify('rider', 'Reconnecting to your driver', 'We lost their signal. Holding your trip.', 'warn', trip.riderId);
      this.notify('admin', 'Driver connection lost', `${driver.name} on ${trip.id}`, 'warn');
    }
  }

  resumeAfterReconnect(driver: Driver): void {
    if (!driver.tripId) return;
    const trip = this.store.trips.get(driver.tripId);
    if (!trip || trip.state !== 'driver_unreachable') return;
    const resume = trip.startedAt ? 'in_progress' : 'en_route_to_pickup';
    if (this.go(trip, resume, 'driver reconnected, state resynced')) {
      this.notify('rider', 'Driver reconnected', 'Your trip is back on track.', 'success', trip.riderId);
    }
  }

  /** The driver never came back. Put the rider back in the dispatch queue. */
  reassign(driver: Driver): void {
    if (!driver.tripId) return;
    const trip = this.store.trips.get(driver.tripId);
    if (!trip || trip.state !== 'driver_unreachable' || trip.startedAt) return;
    trip.driverId = null;
    trip.matchedAt = undefined;
    if (this.go(trip, 'searching', 'reassigning after driver timeout')) {
      this.releaseDriver(driver);
      this.notify('rider', 'Finding you another driver', 'Your first driver dropped off the network.', 'warn', trip.riderId);
    }
  }

  /* ------------------------------------------------------- post-trip bits */

  addTip(tripId: string, tipCents: number): Trip {
    const trip = this.store.trips.get(tripId);
    if (!trip || trip.state !== 'completed') throw new BadRequestException('Trip is not complete');
    if (trip.tipCents > 0) throw new BadRequestException('A tip was already added');
    if (tipCents <= 0) return trip;

    const driver = this.store.drivers.get(trip.driverId!)!;
    const rider = this.store.riders.get(trip.riderId)!;
    trip.tipCents = tipCents;
    this.payments.settleTip(trip, driver, rider, tipCents);
    this.notify('driver', 'You got a tip', `${cents(tipCents)} from ${rider.name}`, 'supply', driver.id);
    this.emitTrip(trip);
    this.events.emit('driver:update', driver);
    return trip;
  }

  rate(tripId: string, stars: number): Trip {
    const trip = this.store.trips.get(tripId);
    if (!trip) throw new NotFoundException('trip');
    trip.rating = Math.max(1, Math.min(5, Math.round(stars)));
    const driver = this.store.drivers.get(trip.driverId!);
    if (driver) {
      const n = Math.max(1, driver.completedTrips);
      driver.rating = Math.round(((driver.rating * (n - 1) + trip.rating) / n) * 100) / 100;
      this.events.emit('driver:update', driver);
    }
    this.emitTrip(trip);
    return trip;
  }

  /* -------------------------------------------------------------- driving */

  /**
   * Advance a driver along its route. The router measured free-flow seconds;
   * the world consumes them slower in congested zones. That gap is exactly
   * what the ETA model is trying to learn.
   */
  advance(driver: Driver, dtSec: number): 'moving' | 'arrived' {
    if (!driver.route || driver.route.legs.length === 0) return 'arrived';
    const factor = congestion(driver.zone, simHour(this.store.simSec));
    driver.routeElapsedSec += dtSec / factor;
    return driver.routeElapsedSec >= driver.route.seconds ? 'arrived' : 'moving';
  }

  poiLabel(p: Vec): string {
    let best = '';
    let bestD = Infinity;
    for (const poi of Object.values(POI_BY_ID)) {
      const d = (poi.pos.x - p.x) ** 2 + (poi.pos.y - p.y) ** 2;
      if (d < bestD) { bestD = d; best = poi.name; }
    }
    return bestD < 0.09 ? best : `${ZONE_BY_KEY[zoneAt(p)].name} · ${p.x.toFixed(2)}, ${p.y.toFixed(2)}`;
  }
}
