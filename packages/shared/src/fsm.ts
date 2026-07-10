import type { Cents, PlatformConfig, Trip, TripState } from './types';

/**
 * The trip state machine. Every state change in the platform goes through
 * `transition()` — there is no other way to mutate `trip.state`. An illegal
 * edge is rejected and logged rather than silently applied, which is what
 * keeps a trip from ending up "in progress" with no driver attached after a
 * reconnect, a double-tap, or a race between rider and driver cancelling.
 */
export const TRANSITIONS: Record<TripState, TripState[]> = {
  requested:          ['searching', 'cancelled_by_rider'],
  searching:          ['matched', 'no_drivers_available', 'cancelled_by_rider'],
  matched:            ['en_route_to_pickup', 'cancelled_by_rider', 'cancelled_by_driver'],
  en_route_to_pickup: ['driver_arrived', 'driver_unreachable', 'cancelled_by_rider', 'cancelled_by_driver'],
  driver_arrived:     ['in_progress', 'cancelled_by_rider', 'cancelled_by_driver'],
  in_progress:        ['completed', 'driver_unreachable'],
  driver_unreachable: ['en_route_to_pickup', 'in_progress', 'searching', 'cancelled_by_driver'],
  completed:           [],
  cancelled_by_rider:  [],
  cancelled_by_driver: [],
  no_drivers_available: [],
};

export const TERMINAL_STATES: TripState[] = [
  'completed', 'cancelled_by_rider', 'cancelled_by_driver', 'no_drivers_available',
];

export const isTerminal = (s: TripState) => TERMINAL_STATES.includes(s);
export const isActive = (s: TripState) => !isTerminal(s);
export const hasDriver = (s: TripState) =>
  ['matched', 'en_route_to_pickup', 'driver_arrived', 'in_progress', 'driver_unreachable'].includes(s);

export const canTransition = (from: TripState, to: TripState) => TRANSITIONS[from].includes(to);

export type TransitionResult =
  | { ok: true; from: TripState; to: TripState }
  | { ok: false; from: TripState; to: TripState; error: string };

export function transition(trip: Trip, to: TripState, at: number, note?: string): TransitionResult {
  const from = trip.state;
  if (!canTransition(from, to)) {
    return { ok: false, from, to, error: `illegal transition ${from} → ${to}` };
  }
  trip.state = to;
  trip.history.push({ state: to, at, note });
  return { ok: true, from, to };
}

export const STATE_LABEL: Record<TripState, string> = {
  requested: 'Requested',
  searching: 'Finding a driver',
  matched: 'Driver matched',
  en_route_to_pickup: 'Driver on the way',
  driver_arrived: 'Driver arrived',
  in_progress: 'On trip',
  completed: 'Completed',
  cancelled_by_rider: 'Cancelled by rider',
  cancelled_by_driver: 'Cancelled by driver',
  no_drivers_available: 'No drivers available',
  driver_unreachable: 'Driver connection lost',
};

export type Tone = 'info' | 'good' | 'warn' | 'bad' | 'neutral';

export const STATE_TONE: Record<TripState, Tone> = {
  requested: 'info',
  searching: 'info',
  matched: 'info',
  en_route_to_pickup: 'info',
  driver_arrived: 'good',
  in_progress: 'good',
  completed: 'good',
  cancelled_by_rider: 'neutral',
  cancelled_by_driver: 'bad',
  no_drivers_available: 'bad',
  driver_unreachable: 'warn',
};

export interface CancellationPolicy { feeCents: Cents; free: boolean; reason: string }

/** What a rider pays to walk away, and why. Shown before they confirm. */
export function riderCancellationPolicy(
  trip: Trip,
  config: PlatformConfig,
  isMember: boolean,
  now: number,
): CancellationPolicy {
  if (trip.state === 'requested' || trip.state === 'searching') {
    return { feeCents: 0, free: true, reason: 'No driver has been matched yet.' };
  }
  if (isMember && config.membership.freeCancellation) {
    return { feeCents: 0, free: true, reason: 'Free cancellation is a Tylo+ benefit.' };
  }
  const sinceMatch = now - (trip.matchedAt ?? now);
  if (sinceMatch <= config.dispatch.arrivalGraceSec) {
    const left = Math.ceil(config.dispatch.arrivalGraceSec - sinceMatch);
    return { feeCents: 0, free: true, reason: `Free for another ${left}s after matching.` };
  }
  const fee = config.products[trip.product].cancelFeeCents;
  return { feeCents: fee, free: false, reason: 'Your driver is already on the way.' };
}
