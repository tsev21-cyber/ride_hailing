import { Injectable } from '@nestjs/common';
import type { MetricBucket, Metrics } from '@tylo/shared';
import { StoreService } from '../core/store.service';
import { AiService } from './ai.service';

const BUCKET_SEC = 120;
const MAX_BUCKETS = 30;

/**
 * Everything here is derived from the ledger and the trip log. No counter is
 * incremented "for the dashboard" — if the number moves, money or a trip moved.
 */
@Injectable()
export class AnalyticsService {
  constructor(private readonly store: StoreService, private readonly ai: AiService) {}

  metrics(): Metrics {
    const s = this.store;
    const trips = [...s.trips.values()];
    const completed = trips.filter((t) => t.state === 'completed' && t.split);

    const sumBy = (type: string) =>
      s.ledger.filter((e) => e.type === type).reduce((a, e) => a + e.amountCents, 0);

    const gmvCents = sumBy('charge') + sumBy('cancellation_fee') + sumBy('subscription');
    const stripeFeeCents = -sumBy('processing_fee');
    const driverPayoutCents = -sumBy('transfer');
    const refundedCents = -sumBy('refund');

    // The platform's net IS the ledger sum. Nothing is booked twice.
    const platformNetCents = s.ledger.reduce((a, e) => a + e.amountCents, 0);

    const subsidyCents = completed.reduce((a, t) => a + (t.split?.platformSubsidyCents ?? 0), 0);
    const tipsCents = completed.reduce((a, t) => a + t.tipCents, 0);

    const fares = completed.map((t) => t.finalFare!.totalCents);
    const avgFareCents = fares.length ? Math.round(fares.reduce((a, b) => a + b, 0) / fares.length) : 0;

    const etas = trips.filter((t) => t.actualPickupEtaSec != null).map((t) => t.actualPickupEtaSec!);
    const avgPickupEtaSec = etas.length ? etas.reduce((a, b) => a + b, 0) / etas.length : 0;

    const drivers = [...s.drivers.values()];
    const onlineDrivers = drivers.filter((d) => d.online && d.connected).length;
    const busyDrivers = drivers.filter((d) => d.state === 'on_trip' || d.state === 'en_route').length;

    const c = s.counters;
    const closed = c.completed + c.cancelledByRider + c.cancelledByDriver + c.noDrivers;

    return {
      simSec: s.simSec,
      requests: c.requests,
      completed: c.completed,
      cancelledByRider: c.cancelledByRider,
      cancelledByDriver: c.cancelledByDriver,
      noDrivers: c.noDrivers,
      activeTrips: s.activeTrips().length,

      gmvCents, driverPayoutCents, platformNetCents, stripeFeeCents,
      subsidyCents, refundedCents, tipsCents,

      avgFareCents,
      takeRate: gmvCents > 0 ? platformNetCents / gmvCents : 0,
      acceptanceRate: c.offersSent > 0 ? c.offersAccepted / c.offersSent : 0,
      cancellationRate: closed > 0 ? (c.cancelledByRider + c.cancelledByDriver) / closed : 0,
      avgPickupEtaSec,

      onlineDrivers, busyDrivers,
      utilization: onlineDrivers > 0 ? busyDrivers / onlineDrivers : 0,

      eta: this.ai.etaStats(),
      buckets: this.buckets(),
      zones: s.zoneStats,
    };
  }

  private buckets(): MetricBucket[] {
    const s = this.store;
    const trips = [...s.trips.values()];
    const now = s.simSec;
    const first = Math.max(0, Math.floor(now / BUCKET_SEC) - MAX_BUCKETS + 1);

    const out: MetricBucket[] = [];
    for (let b = first; b <= Math.floor(now / BUCKET_SEC); b++) {
      const t0 = b * BUCKET_SEC;
      const t1 = t0 + BUCKET_SEC;
      const done = trips.filter((t) => t.endedAt != null && t.endedAt >= t0 && t.endedAt < t1 && t.split);
      const picked = trips.filter((t) => t.arrivedAt != null && t.arrivedAt >= t0 && t.arrivedAt < t1 && t.actualPickupEtaSec != null);

      out.push({
        t: t0,
        requests: trips.filter((t) => t.requestedAt >= t0 && t.requestedAt < t1).length,
        completed: done.length,
        driverPayoutCents: done.reduce((a, t) => a + t.split!.driverPayoutCents, 0),
        platformNetCents: done.reduce((a, t) => a + t.split!.platformNetCents, 0),
        stripeFeeCents: done.reduce((a, t) => a + t.split!.stripeFeeCents, 0),
        predictedEtaSec: picked.reduce((a, t) => a + t.predictedPickupEtaSec, 0),
        actualEtaSec: picked.reduce((a, t) => a + t.actualPickupEtaSec!, 0),
        etaSamples: picked.length,
      });
    }
    return out;
  }
}
