import { sid } from './ids';
import { driverFareBase } from './pricing';
import type { Cents, ConnectSplit, FareBreakdown, PlatformConfig } from './types';

/**
 * Stripe Connect — destination charge.
 *
 * This is the part that separates a marketplace from a shop. We do not simply
 * charge the rider: we charge the rider, take an application fee, and settle
 * the remainder into the driver's connected account. Three consequences that
 * the code below makes explicit:
 *
 *   1. Processing fees are borne by the PLATFORM, not the driver.
 *   2. Tips pass through to the driver at 100% — they are never commissioned.
 *   3. The driver is paid on the PRE-discount fare. A promo is an acquisition
 *      cost the platform funds; it never comes out of the driver's pocket.
 *      When a promo is deep enough, the application fee floors at zero and the
 *      platform tops the transfer up. That trip is net-negative, on purpose.
 */
export function splitDestinationCharge(
  config: PlatformConfig,
  fare: FareBreakdown,
  tipCents: Cents,
  stripeAccountId: string,
): ConnectSplit {
  const fareTotalCents = fare.totalCents;
  const chargeCents = fareTotalCents + tipCents;

  const stripeFeeCents = Math.round(chargeCents * config.stripe.percent) + config.stripe.fixedCents;

  const driverFareBaseCents = driverFareBase(fare);
  const platformCommissionCents = Math.round(driverFareBaseCents * config.commissionPct);
  const driverPayoutCents = driverFareBaseCents - platformCommissionCents + tipCents;

  const rawApplicationFee = chargeCents - driverPayoutCents;
  const applicationFeeCents = Math.max(0, rawApplicationFee);
  const platformSubsidyCents = Math.max(0, -rawApplicationFee);

  const platformNetCents = applicationFeeCents - stripeFeeCents - platformSubsidyCents;

  return {
    chargeCents,
    fareTotalCents,
    tipCents,
    stripeFeeCents,
    driverFareBaseCents,
    platformCommissionCents,
    bookingFeeCents: fare.bookingFeeCents,
    airportSurchargeCents: fare.airportSurchargeCents,
    applicationFeeCents,
    platformSubsidyCents,
    driverPayoutCents,
    platformNetCents,
    takeRate: chargeCents > 0 ? platformNetCents / chargeCents : 0,
    objects: {
      paymentIntent: sid('pi'),
      charge: sid('ch'),
      transfer: sid('tr'),
      applicationFee: sid('fee'),
      destination: stripeAccountId,
    },
  };
}

export function instantPayoutFee(config: PlatformConfig, amountCents: Cents): Cents {
  return Math.max(config.instantPayout.minFeeCents, Math.round(amountCents * config.instantPayout.percent));
}
