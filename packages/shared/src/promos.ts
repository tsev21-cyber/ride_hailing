import { cents } from './pricing';
import type { Cents, Promo, PromoResult } from './types';

export interface PromoContext {
  isFirstRide: boolean;
  fareCents: Cents;
  nowSec: number;
}

/**
 * Returns a typed rejection, not a boolean. The rider sees *why* a code was
 * refused, and support can read the same reason in the ticket.
 */
export function validatePromo(promo: Promo | undefined, ctx: PromoContext): PromoResult {
  if (!promo) {
    return { ok: false, reason: 'PROMO_NOT_FOUND', message: "That code doesn't exist. Check the spelling?" };
  }
  if (!promo.active) {
    return { ok: false, reason: 'PROMO_INACTIVE', message: 'This code is no longer being offered.' };
  }
  if (promo.expiresAtSec != null && ctx.nowSec > promo.expiresAtSec) {
    return { ok: false, reason: 'PROMO_EXPIRED', message: 'This code expired.' };
  }
  if (promo.firstRideOnly && !ctx.isFirstRide) {
    return { ok: false, reason: 'PROMO_FIRST_RIDE_ONLY', message: 'This code is for your first ride only.' };
  }
  // Hard state before cart state: never tell someone to spend $5 more to
  // unlock a code that has already been fully claimed.
  if (promo.usageLimit != null && promo.used >= promo.usageLimit) {
    return { ok: false, reason: 'PROMO_USAGE_LIMIT_REACHED', message: 'This code has been fully claimed.' };
  }
  if (promo.minFareCents != null && ctx.fareCents < promo.minFareCents) {
    return {
      ok: false,
      reason: 'PROMO_MIN_FARE_NOT_MET',
      message: `Add ${cents(promo.minFareCents - ctx.fareCents)} more to use this code — it needs a ${cents(promo.minFareCents)} fare.`,
    };
  }
  return { ok: true, promo };
}

export const describePromo = (p: Promo) =>
  p.kind === 'percent'
    ? `${p.value}% off${p.maxDiscountCents ? ` up to ${cents(p.maxDiscountCents)}` : ''}`
    : `${cents(p.value)} off`;
