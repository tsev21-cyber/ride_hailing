import { Injectable } from '@nestjs/common';
import { AiService } from '../engine/ai.service';
import { AnalyticsService } from '../engine/analytics.service';
import { StoreService } from './store.service';

@Injectable()
export class StateService {
  constructor(
    private readonly store: StoreService,
    private readonly analytics: AnalyticsService,
    private readonly ai: AiService,
  ) {}

  /**
   * Everything a freshly-connected console needs. The road graph is NOT here:
   * the browser builds the identical graph from the same shared module and seed.
   */
  snapshot() {
    const s = this.store;
    const trips = [...s.trips.values()].sort((a, b) => b.requestedAt - a.requestedAt).slice(0, 140);
    const routes = [...s.drivers.values()]
      .filter((d) => d.route && d.tripId)
      .map((d) => ({
        driverId: d.id, tripId: d.tripId, points: d.route!.points,
        phase: s.trips.get(d.tripId!)?.state === 'in_progress' ? 'trip' : 'pickup',
      }));

    return {
      simSec: s.simSec,
      speed: s.speed,
      config: s.config,
      humanDriverId: s.humanDriverId,
      humanRiderId: s.humanRiderId,
      drivers: [...s.drivers.values()].map(({ route, ...rest }) => rest),
      riders: [...s.riders.values()],
      trips,
      offers: [...s.offers.values()],
      promos: [...s.promos.values()],
      tickets: [...s.tickets.values()],
      ledger: s.ledger.slice(0, 80),
      payouts: s.payouts.slice(0, 40),
      routes,
      heat: this.ai.heatSnapshot(),
      metrics: this.analytics.metrics(),
    };
  }
}
