import type { Route, RouteLeg, Vec, ZoneKey } from './types';
import { BAY, WORLD, isBay, zoneAt } from './zones';

/* ------------------------------------------------------------------
 * A deterministic road network. Both the server (which routes on it)
 * and the browser (which draws it) build the identical graph from the
 * same seed, so no geometry is ever sent over the wire.
 * ------------------------------------------------------------------ */

export type RoadClass = 'street' | 'avenue' | 'boulevard' | 'causeway';

export const SPEED_MPH: Record<RoadClass, number> = {
  street: 19,
  avenue: 34,
  boulevard: 30,
  causeway: 52,
};

export interface GNode { id: number; i: number; j: number; pos: Vec; zone: ZoneKey }
export interface GEdge { a: number; b: number; miles: number; seconds: number; cls: RoadClass }
export interface RoadGraph {
  nodes: GNode[];
  edges: GEdge[];
  adj: Array<Array<{ to: number; edge: number }>>;
}

const COLS = 17;
const ROWS = 13;
const DX = WORLD.w / (COLS - 1);
const DY = WORLD.h / (ROWS - 1);
const SEED = 20260709;

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const dist = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.y - b.y);

function classOf(horizontal: boolean, i: number, j: number): RoadClass {
  if (horizontal) return j % 4 === 0 ? 'boulevard' : 'street';
  return i % 4 === 0 ? 'avenue' : 'street';
}

let cached: RoadGraph | null = null;

export function buildRoadGraph(): RoadGraph {
  if (cached) return cached;
  const rnd = mulberry32(SEED);

  // Grid nodes, jittered so the city doesn't read as graph paper.
  const slot = new Map<number, number>(); // gridKey -> node index
  const nodes: GNode[] = [];
  for (let j = 0; j < ROWS; j++) {
    for (let i = 0; i < COLS; i++) {
      const jx = (rnd() - 0.5) * 0.09;
      const jy = (rnd() - 0.5) * 0.09;
      const pos = {
        x: Math.min(WORLD.w, Math.max(0, i * DX + (i === 0 || i === COLS - 1 ? 0 : jx))),
        y: Math.min(WORLD.h, Math.max(0, j * DY + (j === 0 || j === ROWS - 1 ? 0 : jy))),
      };
      if (isBay(pos)) continue; // no roads on water
      const id = nodes.length;
      slot.set(j * COLS + i, id);
      nodes.push({ id, i, j, pos, zone: zoneAt(pos) });
    }
  }

  const edges: GEdge[] = [];
  const adj: RoadGraph['adj'] = nodes.map(() => []);
  const link = (a: number, b: number, cls: RoadClass) => {
    const miles = dist(nodes[a].pos, nodes[b].pos);
    const seconds = (miles / SPEED_MPH[cls]) * 3600;
    const e = edges.length;
    edges.push({ a, b, miles, seconds, cls });
    adj[a].push({ to: b, edge: e });
    adj[b].push({ to: a, edge: e });
  };

  for (let j = 0; j < ROWS; j++) {
    for (let i = 0; i < COLS; i++) {
      const here = slot.get(j * COLS + i);
      if (here === undefined) continue;
      const east = slot.get(j * COLS + i + 1);
      if (i + 1 < COLS && east !== undefined) link(here, east, classOf(true, i, j));
      const north = slot.get((j + 1) * COLS + i);
      if (j + 1 < ROWS && north !== undefined) link(here, north, classOf(false, i, j));
    }
  }

  // Two causeways span the bay — the only way to Miami Beach up north.
  for (const j of [5, 9]) {
    const west = slot.get(j * COLS + 11);
    const east = slot.get(j * COLS + 14);
    if (west !== undefined && east !== undefined) link(west, east, 'causeway');
  }

  cached = { nodes, edges, adj };
  return cached;
}

export function nearestNode(g: RoadGraph, p: Vec): number {
  let best = 0;
  let bestD = Infinity;
  for (const n of g.nodes) {
    const d = (n.pos.x - p.x) ** 2 + (n.pos.y - p.y) ** 2;
    if (d < bestD) { bestD = d; best = n.id; }
  }
  return best;
}

export interface ShortestPaths { dist: Float64Array; prev: Int32Array; prevEdge: Int32Array }

/** Dijkstra over free-flow seconds. N ≈ 200, so the dense form is faster than a heap. */
export function dijkstraFrom(g: RoadGraph, src: number): ShortestPaths {
  const n = g.nodes.length;
  const d = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const prevEdge = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  d[src] = 0;

  for (let it = 0; it < n; it++) {
    let u = -1;
    let best = Infinity;
    for (let k = 0; k < n; k++) if (!done[k] && d[k] < best) { best = d[k]; u = k; }
    if (u === -1) break;
    done[u] = 1;
    for (const { to, edge } of g.adj[u]) {
      const nd = d[u] + g.edges[edge].seconds;
      if (nd < d[to]) { d[to] = nd; prev[to] = u; prevEdge[to] = edge; }
    }
  }
  return { dist: d, prev, prevEdge };
}

export function buildRoute(g: RoadGraph, sp: ShortestPaths, src: number, dst: number): Route | null {
  if (!isFinite(sp.dist[dst])) return null;
  const nodeIds: number[] = [];
  for (let at = dst; at !== -1; at = sp.prev[at]) {
    nodeIds.push(at);
    if (at === src) break;
  }
  nodeIds.reverse();
  if (nodeIds[0] !== src) return null;

  const legs: RouteLeg[] = [];
  let miles = 0;
  let seconds = 0;
  for (let k = 0; k + 1 < nodeIds.length; k++) {
    const a = nodeIds[k];
    const b = nodeIds[k + 1];
    const e = g.edges[sp.prevEdge[b]];
    const leg: RouteLeg = { from: a, to: b, miles: e.miles, seconds: e.seconds };
    legs.push(leg);
    miles += e.miles;
    seconds += e.seconds;
  }
  return { nodes: nodeIds, points: nodeIds.map((id) => g.nodes[id].pos), legs, miles, seconds };
}

export function routeBetween(g: RoadGraph, from: Vec, to: Vec): Route | null {
  const a = nearestNode(g, from);
  const b = nearestNode(g, to);
  if (a === b) return { nodes: [a], points: [g.nodes[a].pos], legs: [], miles: 0, seconds: 0 };
  return buildRoute(g, dijkstraFrom(g, a), a, b);
}

export interface RoutePosition { pos: Vec; heading: number; milesDone: number; legIndex: number; done: boolean }

/** Where a vehicle sits after `sec` of free-flow travel along `route`. */
export function positionAlong(route: Route, sec: number): RoutePosition {
  if (route.legs.length === 0) {
    return { pos: route.points[0], heading: 0, milesDone: 0, legIndex: 0, done: true };
  }
  let t = Math.max(0, sec);
  let milesDone = 0;
  for (let k = 0; k < route.legs.length; k++) {
    const leg = route.legs[k];
    if (t < leg.seconds || k === route.legs.length - 1) {
      const f = leg.seconds > 0 ? Math.min(1, t / leg.seconds) : 1;
      const a = route.points[k];
      const b = route.points[k + 1];
      return {
        pos: { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f },
        heading: Math.atan2(b.y - a.y, b.x - a.x),
        milesDone: milesDone + leg.miles * f,
        legIndex: k,
        done: sec >= route.seconds,
      };
    }
    t -= leg.seconds;
    milesDone += leg.miles;
  }
  const last = route.points[route.points.length - 1];
  return { pos: last, heading: 0, milesDone: route.miles, legIndex: route.legs.length - 1, done: true };
}

/** Human-readable next manoeuvre, for the driver's navigation card. */
export function nextManeuver(g: RoadGraph, route: Route, legIndex: number): string {
  const leg = route.legs[legIndex];
  if (!leg) return 'Arriving';
  const remaining = route.legs.length - legIndex - 1;
  if (remaining === 0) return 'Arriving at destination';
  const a = g.nodes[leg.from];
  const b = g.nodes[leg.to];
  const next = route.legs[legIndex + 1];
  const c = g.nodes[next.to];
  const cross = (b.pos.x - a.pos.x) * (c.pos.y - b.pos.y) - (b.pos.y - a.pos.y) * (c.pos.x - b.pos.x);
  const turn = Math.abs(cross) < 0.02 ? 'Continue' : cross > 0 ? 'Turn left' : 'Turn right';
  const dir = Math.abs(c.pos.x - b.pos.x) > Math.abs(c.pos.y - b.pos.y)
    ? (c.pos.x > b.pos.x ? 'E' : 'W')
    : (c.pos.y > b.pos.y ? 'N' : 'S');
  const street = next.to % 4 === 0 ? `${dir} Ave` : `${dir} ${10 + (next.to % 40)}th St`;
  return `${turn} onto ${street}`;
}

export { BAY, WORLD };
