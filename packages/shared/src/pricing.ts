import type { Cents, FareBreakdown, FareLine, PlatformConfig, ProductKey, Promo } from './types';

export const cents = (c: Cents) => `$${(c / 100).toFixed(2)}`;
export const centsShort = (c: Cents) => `$${Math.round(c / 100)}`;

export function promoDiscountFor(promo: Promo, baseCents: Cents): Cents {
  const raw = promo.kind === 'percent'
    ? Math.round((baseCents * promo.value) / 100)
    : promo.value;
  const capped = promo.maxDiscountCents != null ? Math.min(raw, promo.maxDiscountCents) : raw;
  return Math.max(0, Math.min(capped, baseCents));
}

export interface QuoteInput {
  config: PlatformConfig;
  product: ProductKey;
  miles: number;
  minutes: number;
  surgeMultiplier: number;
  isMember: boolean;
  promo?: Promo | null;
  airport: boolean;
}

/**
 * The single source of fare truth. Runs unchanged in the browser (for the
 * live quote) and on the server (for the charge), so a rider is never shown
 * a price the backend won't honour.
 */
export function quoteFare(input: QuoteInput): FareBreakdown {
  const { config, miles, minutes, isMember, promo, airport } = input;
  const p = config.products[input.product];
  const surge = Math.max(1, input.surgeMultiplier);

  const baseCents = p.baseCents;
  const distanceCents = Math.round(miles * p.perMileCents);
  const timeCents = Math.round(minutes * p.perMinuteCents);

  const rideCents = baseCents + distanceCents + timeCents;
  const surgeCents = Math.round(rideCents * (surge - 1));

  const preMin = rideCents + surgeCents;
  const minFareAdjustmentCents = Math.max(0, p.minFareCents - preMin);
  const fareSubtotal = preMin + minFareAdjustmentCents;

  const bookingFeeCents = p.bookingFeeCents;
  const airportSurchargeCents = airport ? config.airportSurchargeCents : 0;
  const gross = fareSubtotal + bookingFeeCents + airportSurchargeCents;

  // Membership discounts the fare, never the fees.
  const membershipDiscountCents = isMember
    ? -Math.round(fareSubtotal * config.membership.discountPct)
    : 0;

  const afterMember = gross + membershipDiscountCents;
  let promoDiscountCents = promo ? -promoDiscountFor(promo, afterMember) : 0;

  // A rider is never charged less than the fees the platform must remit.
  const floor = bookingFeeCents + airportSurchargeCents;
  let totalCents = afterMember + promoDiscountCents;
  if (totalCents < floor) {
    totalCents = floor;
    promoDiscountCents = totalCents - afterMember;
  }

  const lines: FareLine[] = [
    { label: 'Base fare', amount: baseCents, kind: 'charge' },
    { label: `Distance · ${miles.toFixed(1)} mi`, amount: distanceCents, kind: 'charge' },
    { label: `Time · ${minutes.toFixed(0)} min`, amount: timeCents, kind: 'charge' },
  ];
  if (surgeCents > 0) lines.push({ label: `Surge · ${surge.toFixed(1)}×`, amount: surgeCents, kind: 'surge' });
  if (minFareAdjustmentCents > 0) lines.push({ label: 'Minimum fare adjustment', amount: minFareAdjustmentCents, kind: 'adjustment' });
  lines.push({ label: 'Booking fee', amount: bookingFeeCents, kind: 'fee' });
  if (airportSurchargeCents > 0) lines.push({ label: 'Airport surcharge', amount: airportSurchargeCents, kind: 'fee' });
  if (membershipDiscountCents < 0) lines.push({ label: `Tylo+ member · ${Math.round(config.membership.discountPct * 100)}% off`, amount: membershipDiscountCents, kind: 'discount' });
  if (promoDiscountCents < 0 && promo) lines.push({ label: `Promo · ${promo.code}`, amount: promoDiscountCents, kind: 'discount' });

  return {
    baseCents, distanceCents, timeCents, surgeCents, bookingFeeCents,
    airportSurchargeCents, minFareAdjustmentCents, membershipDiscountCents,
    promoDiscountCents, totalCents, lines,
    surgeMultiplier: surge, miles, minutes,
  };
}

/** The fare the driver is paid on — pre-discount. Promos are a platform cost. */
export function driverFareBase(f: FareBreakdown): Cents {
  return f.baseCents + f.distanceCents + f.timeCents + f.surgeCents + f.minFareAdjustmentCents;
}
