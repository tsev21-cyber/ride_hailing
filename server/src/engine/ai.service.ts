import { Injectable } from '@nestjs/common';
import {
  DEMAND_BY_HOUR, WORLD, ZONES, ZONE_BY_KEY, clamp, dijkstraFrom, nearestNode, simHour,
  type Driver, type EtaModelStats, type Vec, type ZoneKey, type ZoneRecommendation,
} from '@tylo/shared';
import { HEAT_COLS, HEAT_ROWS, StoreService } from '../core/store.service';

/**
 * The "AI-assisted driver tools" from the brief, kept honest.
 *
 * There is no magic here, and there shouldn't be. Three things earn their
 * keep in a real fleet:
 *
 *  1. A demand heatmap — a decaying spatial histogram of ride requests.
 *  2. A smart ETA — the router only knows free-flow speed limits. Reality has
 *     traffic. We learn a per-zone correction factor online from completed
 *     pickups and multiply the router's estimate by it. Measurable: the MAPE
 *     of the corrected estimate drops below the raw one within ~30 trips.
 *  3. An earnings optimiser — expected $/hour per zone, ranked, with the
 *     arithmetic shown to the driver rather than hidden behind a vibe.
 */
@Injectable()
export class AiService {
  constructor(private readonly store: StoreService) {}

  /* ------------------------------------------------ demand heatmap */

  noteRequest(p: Vec): void {
    const cx = (p.x / WORLD.w) * (HEAT_COLS - 1);
    const cy = (p.y / WORLD.h) * (HEAT_ROWS - 1);
    for (let j = 0; j < HEAT_ROWS; j++) {
      for (let i = 0; i < HEAT_COLS; i++) {
        const d2 = (i - cx) ** 2 + (j - cy) ** 2;
        if (d2 > 9) continue;
        this.store.heat[j * HEAT_COLS + i] += Math.exp(-d2 / 2.2);
      }
    }
  }

  decayHeat(dt: number): void {
    const k = Math.exp(-dt / 420); // ~7 minute half-life
    for (let i = 0; i < this.store.heat.length; i++) this.store.heat[i] *= k;
  }

  heatSnapshot(): { cols: number; rows: number; max: number; cells: number[] } {
    let max = 0;
    for (const v of this.store.heat) if (v > max) max = v;
    return {
      cols: HEAT_COLS,
      rows: HEAT_ROWS,
      max,
      cells: Array.from(this.store.heat, (v) => Math.round(v * 100) / 100),
    };
  }

  /* ------------------------------------------------ smart ETA */

  /** Router seconds → what we actually promise the rider. */
  correctEta(zone: ZoneKey, rawSec: number): number {
    return rawSec * this.store.etaFactors[zone];
  }

  /** One completed pickup leg. Exponential moving average, α = 0.25. */
  learnEta(zone: ZoneKey, rawSec: number, actualSec: number): void {
    if (rawSec < 5 || actualSec < 5) return;
    const corrected = this.correctEta(zone, rawSec);
    this.store.etaSamples.push({ zone, raw: rawSec, corrected, actual: actualSec });
    if (this.store.etaSamples.length > 400) this.store.etaSamples.shift();

    const observed = actualSec / rawSec;
    const prior = this.store.etaFactors[zone];
    this.store.etaFactors[zone] = clamp(prior * 0.75 + observed * 0.25, 0.8, 2.2);
  }

  etaStats(): EtaModelStats {
    const s = this.store.etaSamples;
    if (!s.length) {
      return { samples: 0, mapeRaw: 0, mapeCorrected: 0, factors: { ...this.store.etaFactors } };
    }
    const pct = (pred: number, act: number) => Math.abs(pred - act) / act;
    const mapeRaw = s.reduce((a, x) => a + pct(x.raw, x.actual), 0) / s.length;
    const mapeCorrected = s.reduce((a, x) => a + pct(x.corrected, x.actual), 0) / s.length;
    return {
      samples: s.length,
      mapeRaw: mapeRaw * 100,
      mapeCorrected: mapeCorrected * 100,
      factors: { ...this.store.etaFactors },
    };
  }

  /* ------------------------------------------------ earnings optimiser */

  zoneRecommendations(driver: Driver, surgeByZone: Record<ZoneKey, number>): ZoneRecommendation[] {
    const { store } = this;
    const hour = simHour(store.simSec);
    const g = store.graph;
    const sp = dijkstraFrom(g, nearestNode(g, driver.pos));

    const out: ZoneRecommendation[] = ZONES.map((z) => {
      const centre = { x: (z.rect.x0 + z.rect.x1) / 2, y: (z.rect.y0 + z.rect.y1) / 2 };
      const deadheadSec = sp.dist[nearestNode(g, centre)];
      const deadheadMin = deadheadSec / 60;

      const demandPerHour = z.demandPerHour * DEMAND_BY_HOUR[hour];
      const driversNearby = [...store.drivers.values()].filter(
        (d) => d.online && d.zone === z.key && d.state !== 'on_trip',
      ).length;

      const surge = surgeByZone[z.key] ?? 1;
      const avgFare = this.zoneAvgFareCents(z.key);

      // Rides an idle driver can realistically catch here, per hour.
      const contention = 1 + driversNearby * 0.85;
      const catchable = clamp(demandPerHour / contention, 0, 4.2);
      const driverShare = 1 - store.config.commissionPct;

      // Deadheading eats the hour before you earn anything in it.
      const usableFraction = clamp(1 - deadheadMin / 60, 0.15, 1);
      const expectedHourlyCents = Math.round(
        catchable * avgFare * surge * driverShare * usableFraction,
      );

      const bits: string[] = [];
      bits.push(`${demandPerHour.toFixed(0)} req/hr`);
      bits.push(`${driversNearby} driver${driversNearby === 1 ? '' : 's'} idle`);
      if (surge > 1.05) bits.push(`${surge.toFixed(1)}× surge`);
      bits.push(`${deadheadMin.toFixed(0)} min away`);

      return {
        zone: z.key,
        name: z.name,
        expectedHourlyCents,
        surge,
        demandPerHour,
        driversNearby,
        deadheadMin,
        rationale: bits.join(' · '),
      };
    });

    return out.sort((a, b) => b.expectedHourlyCents - a.expectedHourlyCents).slice(0, 3);
  }

  private zoneAvgFareCents(zone: ZoneKey): number {
    const done = [...this.store.trips.values()].filter(
      (t) => t.state === 'completed' && t.pickupZone === zone && t.finalFare,
    );
    if (done.length >= 3) {
      return Math.round(done.reduce((a, t) => a + t.finalFare!.totalCents, 0) / done.length);
    }
    // Cold start: distance from the zone centroid to the city centre is a
    // decent prior for trip length before we have our own data.
    const z = ZONE_BY_KEY[zone];
    const cx = (z.rect.x0 + z.rect.x1) / 2;
    const cy = (z.rect.y0 + z.rect.y1) / 2;
    const miles = Math.hypot(cx - 3.2, cy - 2.4) + 1.6;
    return Math.round(185 + miles * 118 + miles * 3.4 * 26 + 249);
  }
}
