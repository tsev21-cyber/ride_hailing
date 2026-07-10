import {
  sid, zoneAt,
  type Driver, type DriverVerification, type Promo, type Rider, type RoadGraph, type ProductKey,
} from '@tylo/shared';

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x9e3779b9) >>> 0;
    let t = Math.imul(a ^ (a >>> 16), 0x21f0aaad);
    t = Math.imul(t ^ (t >>> 15), 0x735a2d97);
    return ((t ^ (t >>> 15)) >>> 0) / 4294967296;
  };
}

const verified = (approved = true): DriverVerification => ({
  documents: {
    drivers_license: 'verified',
    insurance: 'verified',
    vehicle_registration: 'verified',
    profile_photo: 'verified',
  },
  backgroundCheck: {
    id: sid('chk'), status: 'clear', submittedAt: -86400, completedAt: -84600,
    adjudication: null, findings: [],
  },
  approvedByAdmin: approved,
});

interface Spec {
  id: string; name: string; make: string; model: string; year: number; color: string; plate: string;
  products: ProductKey[]; rating: number; accept: number; trips: number;
  online: boolean; human?: boolean; verification: DriverVerification;
}

const SPECS: Spec[] = [
  {
    id: 'D-01', name: 'Marcus Lowe', make: 'Tesla', model: 'Model 3', year: 2023, color: 'Midnight Silver',
    plate: 'TYL 4471', products: ['tylo_x', 'tylo_black'], rating: 4.94, accept: 0.91, trips: 1284,
    online: false, human: true,
    // Blocked on purpose: one document is still in review. The driver cannot
    // go online until an admin clears it — the gate is enforced server-side.
    verification: {
      documents: {
        drivers_license: 'verified', insurance: 'pending',
        vehicle_registration: 'verified', profile_photo: 'verified',
      },
      backgroundCheck: {
        id: sid('chk'), status: 'clear', submittedAt: -86400, completedAt: -84200,
        adjudication: null, findings: [],
      },
      approvedByAdmin: true,
    },
  },
  { id: 'D-02', name: 'Yesenia Cruz',  make: 'Toyota', model: 'Camry',     year: 2022, color: 'Celestite', plate: 'JHK 8820', products: ['tylo_x'],                        rating: 4.88, accept: 0.84, trips: 2310, online: true,  verification: verified() },
  { id: 'D-03', name: 'Andre Baptiste', make: 'Honda',  model: 'Accord',    year: 2021, color: 'Graphite',  plate: 'QRT 1195', products: ['tylo_x'],                        rating: 4.79, accept: 0.72, trips: 883,  online: true,  verification: verified() },
  { id: 'D-04', name: 'Priya Raman',   make: 'Lexus',  model: 'ES 350',    year: 2024, color: 'Obsidian',  plate: 'LXS 3308', products: ['tylo_x', 'tylo_black'],          rating: 4.97, accept: 0.95, trips: 1542, online: true,  verification: verified() },
  { id: 'D-05', name: 'Tomás Reyes',   make: 'Chevrolet', model: 'Suburban', year: 2022, color: 'Onyx',    plate: 'SUB 7712', products: ['tylo_x', 'tylo_xl'],             rating: 4.81, accept: 0.68, trips: 640,  online: true,  verification: verified() },
  { id: 'D-06', name: 'Dana Whitfield', make: 'Kia',   model: 'Telluride', year: 2023, color: 'Everlasting', plate: 'KIA 2240', products: ['tylo_x', 'tylo_xl'],          rating: 4.90, accept: 0.88, trips: 1105, online: true,  verification: verified() },
  {
    id: 'D-07', name: 'Nadia Roshan',  make: 'BMW',    model: '5 Series',  year: 2024, color: 'Carbon',    plate: 'BMW 5510', products: ['tylo_x', 'tylo_black'],
    rating: 4.99, accept: 0.93, trips: 96, online: false,
    // A background check that came back "consider": needs human adjudication
    // before she can drive. Sits in the admin verification queue.
    verification: {
      documents: {
        drivers_license: 'verified', insurance: 'verified',
        vehicle_registration: 'verified', profile_photo: 'verified',
      },
      backgroundCheck: {
        id: sid('chk'), status: 'consider', submittedAt: -172800, completedAt: -169200,
        adjudication: 'engaged',
        findings: [
          'Motor vehicle report: 1 moving violation (speeding, 11 mph over) — 2021-04-18',
          'County criminal search: no records',
          'National sex offender registry: clear',
          'SSN trace + address history: verified',
        ],
      },
      approvedByAdmin: false,
    },
  },
  { id: 'D-08', name: 'Kofi Mensah',   make: 'Hyundai', model: 'Sonata',   year: 2023, color: 'Hampton Grey', plate: 'HYU 6633', products: ['tylo_x'],                     rating: 4.72, accept: 0.61, trips: 412,  online: true,  verification: verified() },
  { id: 'D-09', name: 'Elena Petrova', make: 'Mercedes-Benz', model: 'E-Class', year: 2024, color: 'Selenite', plate: 'MB 9004', products: ['tylo_x', 'tylo_black'],       rating: 4.96, accept: 0.90, trips: 1890, online: true,  verification: verified() },
  { id: 'D-10', name: 'Ruben Ortiz',   make: 'Ford',   model: 'Explorer',  year: 2022, color: 'Iconic Silver', plate: 'FRD 5187', products: ['tylo_x', 'tylo_xl'],         rating: 4.85, accept: 0.79, trips: 977,  online: true,  verification: verified() },
  { id: 'D-11', name: 'Hana Suzuki',   make: 'Nissan', model: 'Altima',    year: 2021, color: 'Gun Metallic', plate: 'NSN 3421', products: ['tylo_x'],                     rating: 4.83, accept: 0.76, trips: 1330, online: true,  verification: verified() },
  { id: 'D-12', name: 'Samir Haddad',  make: 'Cadillac', model: 'Escalade', year: 2024, color: 'Black Raven', plate: 'CAD 8001', products: ['tylo_black', 'tylo_xl'],      rating: 4.92, accept: 0.87, trips: 733,  online: true,  verification: verified() },
];

export function seedDrivers(graph: RoadGraph): Driver[] {
  const rnd = rng(7717);
  // Spread the fleet over land nodes, biased away from the airport.
  const candidates = graph.nodes.filter((n) => n.zone !== 'mia');

  // SPECS is a module-level literal. Handing its nested objects straight to a
  // Driver would alias them, so approving a document or adjudicating a check
  // would mutate the seed and survive `reset()`. Clone on every seed.
  const fresh = (v: DriverVerification): DriverVerification => ({
    documents: { ...v.documents },
    backgroundCheck: { ...v.backgroundCheck, id: sid('chk'), findings: [...v.backgroundCheck.findings] },
    approvedByAdmin: v.approvedByAdmin,
  });

  return SPECS.map((s, k) => {
    const n = candidates[Math.floor(rnd() * candidates.length)];
    const pos = k === 0 ? { x: 3.35, y: 2.42 } : { ...n.pos };
    return {
      id: s.id,
      name: s.name,
      initials: s.name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase(),
      vehicle: { make: s.make, model: s.model, year: s.year, plate: s.plate, color: s.color },
      products: [...s.products],
      rating: s.rating,
      acceptanceRate: s.accept,
      acceptPropensity: s.accept,
      completedTrips: s.trips,
      state: s.online ? 'available' : 'offline',
      pos,
      heading: rnd() * Math.PI * 2,
      zone: zoneAt(pos),
      online: s.online,
      connected: true,
      lastPingAt: 0,
      route: null,
      routeElapsedSec: 0,
      tripId: null,
      verification: fresh(s.verification),
      stripeAccountId: sid('acct', 16),
      wallet: {
        availableCents: Math.round(rnd() * 24000) + 1200,
        pendingCents: 0,
        lifetimeCents: s.trips * 1650,
      },
      isHuman: !!s.human,
    } satisfies Driver;
  });
}

export function seedRider(): Rider {
  return {
    id: 'R-01',
    name: 'Jose S.',
    initials: 'JS',
    rating: 4.9,
    isMember: false,
    memberSince: null,
    completedTrips: 0,
    walletCents: 0,
    pos: { x: 3.62, y: 1.72 },     // Brickell City Centre
    isHuman: true,
  };
}

export function seedPromos(): Promo[] {
  return [
    {
      code: 'WELCOME50', kind: 'percent', value: 50, maxDiscountCents: 1000,
      minFareCents: null, firstRideOnly: true, usageLimit: null, used: 0,
      active: true, expiresAtSec: null, description: '50% off your first ride, up to $10',
    },
    {
      code: 'MIAMI5', kind: 'flat', value: 500, maxDiscountCents: null,
      minFareCents: 1200, firstRideOnly: false, usageLimit: 500, used: 143,
      active: true, expiresAtSec: null, description: '$5 off rides over $12',
    },
    {
      code: 'BEACHDAY', kind: 'percent', value: 20, maxDiscountCents: 800,
      minFareCents: 1500, firstRideOnly: false, usageLimit: 100, used: 100,
      active: true, expiresAtSec: null, description: '20% off to Miami Beach — fully claimed',
    },
    {
      code: 'SPRING24', kind: 'flat', value: 1000, maxDiscountCents: null,
      minFareCents: null, firstRideOnly: false, usageLimit: null, used: 2201,
      active: true, expiresAtSec: -1, description: 'Legacy spring campaign — expired',
    },
  ];
}
