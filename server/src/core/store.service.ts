import { Injectable } from '@nestjs/common';
import {
  buildRoadGraph, defaultConfig, ZONES,
  type Driver, type LedgerEntry, type MetricBucket, type Offer, type PlatformConfig,
  type Payout, type Promo, type Rider, type RoadGraph, type Ticket, type Trip, type ZoneKey,
  type ZoneStat,
} from '@tylo/shared';
import { seedDrivers, seedPromos, seedRider } from './seed';

export const HEAT_COLS = 30;
export const HEAT_ROWS = 23;

export interface Counters {
  requests: number;
  completed: number;
  cancelledByRider: number;
  cancelledByDriver: number;
  noDrivers: number;
  offersSent: number;
  offersAccepted: number;
}

@Injectable()
export class StoreService {
  readonly graph: RoadGraph = buildRoadGraph();

  simSec = 0;
  speed = 1;
  config: PlatformConfig = defaultConfig();

  drivers = new Map<string, Driver>();
  riders = new Map<string, Rider>();
  trips = new Map<string, Trip>();
  offers = new Map<string, Offer>();
  promos = new Map<string, Promo>();
  tickets = new Map<string, Ticket>();

  ledger: LedgerEntry[] = [];
  payouts: Payout[] = [];
  buckets: MetricBucket[] = [];
  zoneStats: ZoneStat[] = [];

  /** Learned free-flow → real-world correction, one factor per zone. */
  etaFactors: Record<ZoneKey, number> = Object.fromEntries(ZONES.map((z) => [z.key, 1])) as Record<ZoneKey, number>;
  etaSamples: Array<{ zone: ZoneKey; raw: number; corrected: number; actual: number }> = [];

  heat = new Float32Array(HEAT_COLS * HEAT_ROWS);

  counters: Counters = {
    requests: 0, completed: 0, cancelledByRider: 0,
    cancelledByDriver: 0, noDrivers: 0, offersSent: 0, offersAccepted: 0,
  };

  readonly humanDriverId = 'D-01';
  readonly humanRiderId = 'R-01';

  constructor() { this.reset(); }

  reset(): void {
    this.simSec = 0;
    this.speed = 1;
    this.config = defaultConfig();
    this.drivers = new Map(seedDrivers(this.graph).map((d) => [d.id, d]));
    this.riders = new Map([[this.humanRiderId, seedRider()]]);
    this.trips.clear();
    this.offers.clear();
    this.promos = new Map(seedPromos().map((p) => [p.code, p]));
    this.tickets.clear();
    this.ledger = [];
    this.payouts = [];
    this.buckets = [];
    this.etaFactors = Object.fromEntries(ZONES.map((z) => [z.key, 1])) as Record<ZoneKey, number>;
    this.etaSamples = [];
    this.heat = new Float32Array(HEAT_COLS * HEAT_ROWS);
    this.counters = {
      requests: 0, completed: 0, cancelledByRider: 0,
      cancelledByDriver: 0, noDrivers: 0, offersSent: 0, offersAccepted: 0,
    };
  }

  get humanDriver(): Driver { return this.drivers.get(this.humanDriverId)!; }
  get humanRider(): Rider { return this.riders.get(this.humanRiderId)!; }

  activeTrips(): Trip[] {
    return [...this.trips.values()].filter((t) =>
      !['completed', 'cancelled_by_rider', 'cancelled_by_driver', 'no_drivers_available'].includes(t.state));
  }

  tripsOf(riderId: string): Trip[] {
    return [...this.trips.values()].filter((t) => t.riderId === riderId).sort((a, b) => b.requestedAt - a.requestedAt);
  }

  offerFor(driverId: string): Offer | undefined {
    return [...this.offers.values()].find((o) => o.driverId === driverId);
  }
}
