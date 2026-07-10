/* ------------------------------------------------------------------
 * Core domain types. Money is ALWAYS integer cents — never a float.
 * ------------------------------------------------------------------ */

export type Cents = number;
export type Vec = { x: number; y: number };

export type ZoneKey =
  | 'brickell' | 'downtown' | 'wynwood' | 'design'
  | 'havana' | 'grove' | 'beach' | 'mia';

export type ProductKey = 'tylo_x' | 'tylo_black' | 'tylo_xl';

/* ---------------------------------- trips */

export type TripState =
  | 'requested'
  | 'searching'
  | 'matched'
  | 'en_route_to_pickup'
  | 'driver_arrived'
  | 'in_progress'
  | 'completed'
  | 'cancelled_by_rider'
  | 'cancelled_by_driver'
  | 'no_drivers_available'
  | 'driver_unreachable';

export interface TripEvent {
  state: TripState;
  at: number;              // sim seconds
  note?: string;
}

export interface Trip {
  id: string;
  riderId: string;
  driverId: string | null;
  product: ProductKey;
  state: TripState;
  history: TripEvent[];

  pickup: Vec;
  dropoff: Vec;
  pickupZone: ZoneKey;
  dropoffZone: ZoneKey;
  pickupLabel: string;
  dropoffLabel: string;

  requestedAt: number;
  matchedAt?: number;
  arrivedAt?: number;
  startedAt?: number;
  endedAt?: number;

  /** Free-flow ETA the router produced, before the learned correction. */
  rawPickupEtaSec: number;
  /** What we told the rider (raw × learned zone factor). */
  predictedPickupEtaSec: number;
  /** What actually happened. Feeds the ETA model. */
  actualPickupEtaSec?: number;

  quotedFare: FareBreakdown;
  finalFare?: FareBreakdown;
  surgeMultiplier: number;
  promoCode?: string | null;

  estMiles: number;
  estMinutes: number;
  actualMiles?: number;
  actualMinutes?: number;

  tipCents: Cents;
  rating?: number;
  split?: ConnectSplit;
  cancelFeeCents?: Cents;
  refundedCents?: Cents;

  offersSent: number;
  isSimulated: boolean;
}

/* ---------------------------------- people */

export type DocStatus = 'missing' | 'pending' | 'verified' | 'rejected';
export type BackgroundCheckStatus = 'not_started' | 'pending' | 'clear' | 'consider' | 'suspended';

export interface DriverVerification {
  documents: Record<'drivers_license' | 'insurance' | 'vehicle_registration' | 'profile_photo', DocStatus>;
  backgroundCheck: {
    id: string;               // chk_xxx — Checkr-shaped
    status: BackgroundCheckStatus;
    submittedAt: number | null;
    completedAt: number | null;
    adjudication: 'engaged' | 'pre_adverse_action' | 'post_adverse_action' | null;
    findings: string[];
  };
  approvedByAdmin: boolean;
}

export type DriverState = 'offline' | 'available' | 'offered' | 'en_route' | 'on_trip';

export interface Driver {
  id: string;
  name: string;
  initials: string;
  vehicle: { make: string; model: string; year: number; plate: string; color: string };
  products: ProductKey[];
  rating: number;
  /** Observed statistic: an EMA of how they actually answered offers. Ranking reads this. */
  acceptanceRate: number;
  /** Hidden temperament that drives the decision. Never shown, never decayed. */
  acceptPropensity: number;
  completedTrips: number;

  state: DriverState;
  pos: Vec;
  heading: number;             // radians
  zone: ZoneKey;
  online: boolean;
  connected: boolean;          // socket heartbeat
  lastPingAt: number;

  route: Route | null;
  routeElapsedSec: number;
  tripId: string | null;

  verification: DriverVerification;
  stripeAccountId: string;     // acct_xxx
  wallet: { availableCents: Cents; pendingCents: Cents; lifetimeCents: Cents };

  isHuman: boolean;            // the one the demo user drives
}

export interface Rider {
  id: string;
  name: string;
  initials: string;
  rating: number;
  isMember: boolean;
  memberSince: number | null;
  completedTrips: number;
  walletCents: Cents;
  pos: Vec;
  isHuman: boolean;
}

/* ---------------------------------- money */

export type FareLineKind = 'charge' | 'fee' | 'discount' | 'surge' | 'adjustment';

export interface FareLine {
  label: string;
  amount: Cents;               // negative for discounts
  kind: FareLineKind;
}

export interface FareBreakdown {
  baseCents: Cents;
  distanceCents: Cents;
  timeCents: Cents;
  surgeCents: Cents;
  bookingFeeCents: Cents;
  airportSurchargeCents: Cents;
  minFareAdjustmentCents: Cents;
  membershipDiscountCents: Cents;   // <= 0
  promoDiscountCents: Cents;        // <= 0
  totalCents: Cents;
  lines: FareLine[];
  surgeMultiplier: number;
  miles: number;
  minutes: number;
}

export interface ConnectSplit {
  /** What the rider's card is charged (fare + tip). */
  chargeCents: Cents;
  fareTotalCents: Cents;
  tipCents: Cents;
  /** 2.9% + 30c, borne by the platform on a destination charge. */
  stripeFeeCents: Cents;
  /** The pre-discount fare the driver's cut is calculated on. */
  driverFareBaseCents: Cents;
  platformCommissionCents: Cents;
  bookingFeeCents: Cents;
  airportSurchargeCents: Cents;
  /** application_fee_amount on the PaymentIntent. Never negative. */
  applicationFeeCents: Cents;
  /** When promos push the fee below zero, the platform funds the gap. */
  platformSubsidyCents: Cents;
  /** Lands in the driver's connected account. Tips pass through 100%. */
  driverPayoutCents: Cents;
  platformNetCents: Cents;
  takeRate: number;
  objects: {
    paymentIntent: string;
    charge: string;
    transfer: string;
    applicationFee: string;
    destination: string;
  };
}

export type LedgerType =
  | 'charge' | 'application_fee' | 'transfer' | 'processing_fee'
  | 'payout' | 'payout_fee' | 'refund' | 'subscription' | 'cancellation_fee';

export interface LedgerEntry {
  id: string;
  at: number;
  type: LedgerType;
  amountCents: Cents;          // signed, from the platform's point of view
  account: string;             // platform | driver:<id> | rider:<id> | stripe
  tripId?: string;
  memo: string;
  stripeObject?: string;
}

export interface Payout {
  id: string;                  // po_xxx
  driverId: string;
  amountCents: Cents;
  feeCents: Cents;
  netCents: Cents;
  method: 'instant' | 'standard';
  at: number;
  status: 'paid' | 'in_transit';
  arrivalNote: string;
}

/* ---------------------------------- promos */

export interface Promo {
  code: string;
  kind: 'percent' | 'flat';
  value: number;               // percent (0-100) or flat cents
  maxDiscountCents: Cents | null;
  minFareCents: Cents | null;
  firstRideOnly: boolean;
  usageLimit: number | null;
  used: number;
  active: boolean;
  expiresAtSec: number | null;
  description: string;
}

export type PromoRejection =
  | 'PROMO_NOT_FOUND' | 'PROMO_INACTIVE' | 'PROMO_EXPIRED'
  | 'PROMO_FIRST_RIDE_ONLY' | 'PROMO_MIN_FARE_NOT_MET' | 'PROMO_USAGE_LIMIT_REACHED';

export type PromoResult =
  | { ok: true; promo: Promo }
  | { ok: false; reason: PromoRejection; message: string };

/* ---------------------------------- support */

export interface TicketMessage { from: 'rider' | 'agent'; body: string; at: number }

export interface Ticket {
  id: string;
  tripId: string | null;
  riderId: string;
  category: 'fare_dispute' | 'lost_item' | 'safety' | 'driver_conduct' | 'app_issue';
  subject: string;
  status: 'open' | 'pending_rider' | 'resolved';
  priority: 'normal' | 'high' | 'urgent';
  messages: TicketMessage[];
  refundedCents: Cents;
  openedAt: number;
}

/* ---------------------------------- routing */

export interface RouteLeg { from: number; to: number; miles: number; seconds: number }

export interface Route {
  nodes: number[];
  points: Vec[];
  legs: RouteLeg[];
  miles: number;
  seconds: number;             // free-flow
}

/* ---------------------------------- dispatch */

export interface DispatchCandidate {
  driverId: string;
  driverName: string;
  distanceMi: number;
  rawEtaSec: number;
  smartEtaSec: number;
  rating: number;
  acceptanceRate: number;
  score: number;
  outcome: 'offered' | 'accepted' | 'declined' | 'timed_out' | 'skipped' | 'queued';
  reason?: string;
}

export interface DispatchTrace {
  tripId: string;
  riderIsMember: boolean;
  radiusMi: number;
  round: number;
  candidates: DispatchCandidate[];
  at: number;
}

export interface Offer {
  id: string;
  tripId: string;
  driverId: string;
  expiresAt: number;           // sim seconds
  issuedAt: number;
  etaSec: number;
  estimatedEarningsCents: Cents;
}

/* ---------------------------------- surge / AI */

export interface ZoneStat {
  zone: ZoneKey;
  name: string;
  openRequests: number;
  availableDrivers: number;
  ratio: number;
  surge: number;
  avgFareCents: Cents;
}

export interface ZoneRecommendation {
  zone: ZoneKey;
  name: string;
  expectedHourlyCents: Cents;
  surge: number;
  demandPerHour: number;
  driversNearby: number;
  deadheadMin: number;
  rationale: string;
}

export interface EtaModelStats {
  samples: number;
  mapeRaw: number;             // mean abs pct error, free-flow router
  mapeCorrected: number;       // ... after the learned zone factors
  factors: Record<string, number>;
}

/* ---------------------------------- notifications */

export interface Notification {
  id: string;
  audience: 'rider' | 'driver' | 'admin';
  target?: string;
  title: string;
  body: string;
  tone: 'info' | 'success' | 'warn' | 'error' | 'supply';
  at: number;
}

/* ---------------------------------- config */

export interface ProductConfig {
  key: ProductKey;
  name: string;
  blurb: string;
  seats: number;
  baseCents: Cents;
  perMileCents: Cents;
  perMinuteCents: Cents;
  bookingFeeCents: Cents;
  minFareCents: Cents;
  cancelFeeCents: Cents;
}

export interface PlatformConfig {
  products: Record<ProductKey, ProductConfig>;
  commissionPct: number;
  stripe: { percent: number; fixedCents: Cents };
  instantPayout: { percent: number; minFeeCents: Cents };
  membership: {
    priceCents: Cents;
    discountPct: number;
    priorityDispatch: boolean;
    freeCancellation: boolean;
  };
  dispatch: {
    offerTimeoutSec: number;
    maxOffersPerTrip: number;
    initialRadiusMi: number;
    radiusStepMi: number;
    maxRadiusMi: number;
    searchTimeoutSec: number;
    arrivalGraceSec: number;
    heartbeatTimeoutSec: number;
  };
  surge: { enabled: boolean; floorRatio: number; sensitivity: number; maxMultiplier: number };
  airportSurchargeCents: Cents;
}

/* ---------------------------------- analytics */

export interface MetricBucket {
  t: number;                   // bucket start, sim seconds
  requests: number;
  completed: number;
  driverPayoutCents: Cents;
  platformNetCents: Cents;
  stripeFeeCents: Cents;
  predictedEtaSec: number;
  actualEtaSec: number;
  etaSamples: number;
}

export interface Metrics {
  simSec: number;
  requests: number;
  completed: number;
  cancelledByRider: number;
  cancelledByDriver: number;
  noDrivers: number;
  activeTrips: number;

  gmvCents: Cents;
  driverPayoutCents: Cents;
  platformNetCents: Cents;
  stripeFeeCents: Cents;
  subsidyCents: Cents;
  refundedCents: Cents;
  tipsCents: Cents;

  avgFareCents: Cents;
  takeRate: number;
  acceptanceRate: number;
  cancellationRate: number;
  avgPickupEtaSec: number;

  onlineDrivers: number;
  busyDrivers: number;
  utilization: number;

  eta: EtaModelStats;
  buckets: MetricBucket[];
  zones: ZoneStat[];
}

/* ---------------------------------- realtime */

export interface DriverTick {
  id: string;
  x: number;
  y: number;
  heading: number;
  state: DriverState;
  connected: boolean;
}

export interface WorldTick {
  simSec: number;
  speed: number;
  drivers: DriverTick[];
}

export interface RoutePreview { tripId: string; points: Vec[]; phase: 'pickup' | 'trip' }

/* ---------------------------------- wire */

export interface WireFrame {
  id: number;
  at: number;
  dir: 'up' | 'down' | 'sys';
  event: string;
  payload: string;
  level?: 'info' | 'error' | 'warn';
}
