import { Injectable } from '@nestjs/common';
import { ZONES, clamp, type ZoneKey, type ZoneStat } from '@tylo/shared';
import { StoreService } from '../core/store.service';

/**
 * Surge is a supply/demand ratio per zone, not a mood. Open requests that
 * nobody has accepted yet are the demand signal; idle online drivers are the
 * supply signal. Multiplier is quantised to 0.1 so riders see a stable number.
 */
@Injectable()
export class SurgeService {
  private multipliers: Record<ZoneKey, number> = Object.fromEntries(
    ZONES.map((z) => [z.key, 1]),
  ) as Record<ZoneKey, number>;

  constructor(private readonly store: StoreService) {}

  get byZone(): Record<ZoneKey, number> { return this.multipliers; }

  multiplierFor(zone: ZoneKey): number {
    return this.store.config.surge.enabled ? this.multipliers[zone] : 1;
  }

  recompute(): ZoneStat[] {
    const { store } = this;
    const cfg = store.config.surge;
    const stats: ZoneStat[] = [];

    for (const z of ZONES) {
      const openRequests = store.activeTrips().filter(
        (t) => t.pickupZone === z.key && (t.state === 'searching' || t.state === 'requested'),
      ).length;

      const availableDrivers = [...store.drivers.values()].filter(
        (d) => d.online && d.connected && d.state === 'available' && d.zone === z.key,
      ).length;

      const ratio = openRequests / Math.max(1, availableDrivers);

      let surge = 1;
      if (cfg.enabled && openRequests > 0) {
        surge = clamp(1 + (ratio - cfg.floorRatio) * cfg.sensitivity, 1, cfg.maxMultiplier);
        surge = Math.round(surge * 10) / 10;
      }
      this.multipliers[z.key] = surge;

      const completed = [...store.trips.values()].filter(
        (t) => t.state === 'completed' && t.pickupZone === z.key && t.finalFare,
      );
      const avgFareCents = completed.length
        ? Math.round(completed.reduce((a, t) => a + t.finalFare!.totalCents, 0) / completed.length)
        : 0;

      stats.push({
        zone: z.key, name: z.name, openRequests, availableDrivers,
        ratio: Math.round(ratio * 100) / 100, surge, avgFareCents,
      });
    }
    return stats;
  }
}
