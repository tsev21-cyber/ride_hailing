import type { Vec, ZoneKey } from './types';

/** Planar world in miles. x = east, y = north. Roughly Miami's shape. */
export const WORLD = { w: 6.0, h: 4.6 };

/** The bay. Nothing routes through it except the two causeways. */
export const BAY = { x0: 4.28, y0: 0.9, x1: 5.18, y1: WORLD.h };

export interface ZoneDef {
  key: ZoneKey;
  name: string;
  short: string;
  rect: { x0: number; y0: number; x1: number; y1: number };
  /** Baseline ride requests per hour at 1.0 demand. */
  demandPerHour: number;
  /**
   * Hidden congestion multiplier. The router never sees this — it only knows
   * free-flow times. The ETA model has to *learn* it from completed trips,
   * which is exactly the job it does in production.
   */
  trafficFactor: number;
  airport: boolean;
}

export const ZONES: ZoneDef[] = [
  { key: 'mia',      name: 'MIA Airport',     short: 'MIA',      rect: { x0: 0.00, y0: 2.00, x1: 0.90, y1: 3.60 }, demandPerHour: 18, trafficFactor: 1.18, airport: true },
  { key: 'wynwood',  name: 'Wynwood',         short: 'Wynwood',  rect: { x0: 1.50, y0: 3.20, x1: 3.20, y1: 4.60 }, demandPerHour: 22, trafficFactor: 1.15, airport: false },
  { key: 'design',   name: 'Design District', short: 'Design',   rect: { x0: 3.20, y0: 3.40, x1: 4.28, y1: 4.60 }, demandPerHour: 12, trafficFactor: 1.12, airport: false },
  { key: 'downtown', name: 'Downtown',        short: 'Downtown', rect: { x0: 3.00, y0: 2.10, x1: 4.28, y1: 3.40 }, demandPerHour: 34, trafficFactor: 1.38, airport: false },
  { key: 'brickell', name: 'Brickell',        short: 'Brickell', rect: { x0: 3.00, y0: 1.00, x1: 4.28, y1: 2.10 }, demandPerHour: 30, trafficFactor: 1.30, airport: false },
  { key: 'havana',   name: 'Little Havana',   short: 'Havana',   rect: { x0: 0.90, y0: 1.40, x1: 3.00, y1: 3.20 }, demandPerHour: 14, trafficFactor: 1.08, airport: false },
  { key: 'grove',    name: 'Coconut Grove',   short: 'Grove',    rect: { x0: 0.90, y0: 0.00, x1: 3.00, y1: 1.40 }, demandPerHour: 10, trafficFactor: 1.05, airport: false },
  { key: 'beach',    name: 'Miami Beach',     short: 'Beach',    rect: { x0: 5.18, y0: 0.00, x1: 6.00, y1: 4.60 }, demandPerHour: 26, trafficFactor: 1.22, airport: false },
];

export const ZONE_BY_KEY: Record<ZoneKey, ZoneDef> = Object.fromEntries(
  ZONES.map((z) => [z.key, z]),
) as Record<ZoneKey, ZoneDef>;

const inRect = (p: Vec, r: ZoneDef['rect']) => p.x >= r.x0 && p.x <= r.x1 && p.y >= r.y0 && p.y <= r.y1;

export function zoneAt(p: Vec): ZoneKey {
  for (const z of ZONES) if (inRect(p, z.rect)) return z.key;
  // Outside every named neighbourhood: attach to the nearest centroid.
  let best: ZoneKey = 'havana';
  let bestD = Infinity;
  for (const z of ZONES) {
    const cx = (z.rect.x0 + z.rect.x1) / 2;
    const cy = (z.rect.y0 + z.rect.y1) / 2;
    const d = (p.x - cx) ** 2 + (p.y - cy) ** 2;
    if (d < bestD) { bestD = d; best = z.key; }
  }
  return best;
}

export const isBay = (p: Vec) => p.x > BAY.x0 && p.x < BAY.x1 && p.y > BAY.y0 && p.y < BAY.y1;

/** Ride demand across the day, indexed by hour. Two commute peaks + a nightlife tail. */
export const DEMAND_BY_HOUR = [
  0.30, 0.22, 0.16, 0.12, 0.14, 0.28, 0.62, 1.10,
  1.35, 1.00, 0.78, 0.80, 0.92, 0.88, 0.86, 0.98,
  1.28, 1.52, 1.40, 1.12, 0.95, 0.92, 0.88, 0.62,
];

/** Congestion on top of the zone's own factor. Rush hours bite. */
export function hourTrafficMultiplier(hour: number): number {
  if (hour >= 7 && hour < 10) return 1.16;
  if (hour >= 16 && hour < 19) return 1.20;
  if (hour >= 22 || hour < 5) return 0.90;
  return 1.0;
}

export function congestion(zone: ZoneKey, hour: number): number {
  return ZONE_BY_KEY[zone].trafficFactor * hourTrafficMultiplier(hour);
}

export interface Poi { id: string; name: string; zone: ZoneKey; pos: Vec }

export const POIS: Poi[] = [
  { id: 'mia_term_d',  name: 'MIA · Terminal D',        zone: 'mia',      pos: { x: 0.42, y: 2.85 } },
  { id: 'mia_rental',  name: 'MIA · Rental Car Center',  zone: 'mia',      pos: { x: 0.55, y: 2.25 } },
  { id: 'brickell_cc', name: 'Brickell City Centre',     zone: 'brickell', pos: { x: 3.62, y: 1.72 } },
  { id: 'mary_brickell', name: 'Mary Brickell Village',  zone: 'brickell', pos: { x: 3.38, y: 1.32 } },
  { id: 'kaseya',      name: 'Kaseya Center',            zone: 'downtown', pos: { x: 3.95, y: 3.05 } },
  { id: 'bayside',     name: 'Bayside Marketplace',      zone: 'downtown', pos: { x: 4.10, y: 2.72 } },
  { id: 'gov_center',  name: 'Government Center',        zone: 'downtown', pos: { x: 3.42, y: 2.55 } },
  { id: 'wynwood_walls', name: 'Wynwood Walls',          zone: 'wynwood',  pos: { x: 2.65, y: 3.85 } },
  { id: 'wynwood_yard', name: 'The Wynwood Yard',        zone: 'wynwood',  pos: { x: 2.05, y: 3.52 } },
  { id: 'design_plaza', name: 'Design District Plaza',   zone: 'design',   pos: { x: 3.70, y: 4.05 } },
  { id: 'calle_ocho',  name: 'Calle Ocho · SW 8th St',   zone: 'havana',   pos: { x: 1.85, y: 2.15 } },
  { id: 'domino_park', name: 'Domino Park',              zone: 'havana',   pos: { x: 2.35, y: 2.62 } },
  { id: 'cocowalk',    name: 'CocoWalk',                 zone: 'grove',    pos: { x: 1.95, y: 0.72 } },
  { id: 'grove_marina', name: 'Dinner Key Marina',       zone: 'grove',    pos: { x: 2.70, y: 0.35 } },
  { id: 'lincoln_rd',  name: 'Lincoln Road',             zone: 'beach',    pos: { x: 5.55, y: 3.05 } },
  { id: 'ocean_dr',    name: 'Ocean Drive · 8th',        zone: 'beach',    pos: { x: 5.70, y: 2.10 } },
  { id: 'south_pointe', name: 'South Pointe Park',       zone: 'beach',    pos: { x: 5.62, y: 1.15 } },
  { id: 'fontainebleau', name: 'Fontainebleau',          zone: 'beach',    pos: { x: 5.50, y: 4.10 } },
];

export const POI_BY_ID: Record<string, Poi> = Object.fromEntries(POIS.map((p) => [p.id, p]));
