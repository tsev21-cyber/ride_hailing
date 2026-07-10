import { BadRequestException, Injectable } from '@nestjs/common';
import {
  cents, instantPayoutFee, sid, splitDestinationCharge,
  type Cents, type ConnectSplit, type Driver, type LedgerEntry, type LedgerType,
  type Payout, type Rider, type Trip,
} from '@tylo/shared';
import { EventsService } from '../core/events.service';
import { StoreService } from '../core/store.service';

@Injectable()
export class PaymentsService {
  constructor(private readonly store: StoreService, private readonly events: EventsService) {}

  private post(type: LedgerType, amountCents: Cents, account: string, memo: string, tripId?: string, stripeObject?: string): LedgerEntry {
    const e: LedgerEntry = {
      id: sid('txn', 10), at: this.store.simSec, type, amountCents, account, memo, tripId, stripeObject,
    };
    this.store.ledger.unshift(e);
    if (this.store.ledger.length > 600) this.store.ledger.pop();
    this.events.emit('ledger:entry', e);
    return e;
  }

  /**
   * Settle a completed trip as a Stripe Connect destination charge.
   * Three ledger rows, and they sum exactly to the platform's net on the trip.
   */
  settleTrip(trip: Trip, driver: Driver, rider: Rider): ConnectSplit {
    const split = splitDestinationCharge(this.store.config, trip.finalFare!, trip.tipCents, driver.stripeAccountId);

    this.post('charge', split.chargeCents, `rider:${rider.id}`,
      `Charged ${rider.name} · ${cents(split.fareTotalCents)} fare${split.tipCents ? ` + ${cents(split.tipCents)} tip` : ''}`,
      trip.id, split.objects.paymentIntent);

    this.post('processing_fee', -split.stripeFeeCents, 'stripe',
      `Stripe 2.9% + $0.30 on ${cents(split.chargeCents)}`, trip.id, split.objects.charge);

    this.post('transfer', -split.driverPayoutCents, `driver:${driver.id}`,
      `Transfer to ${driver.stripeAccountId}${split.platformSubsidyCents ? ` (incl. ${cents(split.platformSubsidyCents)} promo subsidy)` : ''}`,
      trip.id, split.objects.transfer);

    driver.wallet.availableCents += split.driverPayoutCents;
    driver.wallet.lifetimeCents += split.driverPayoutCents;

    trip.split = split;
    return split;
  }

  /**
   * A tip is its own PaymentIntent after the fact. It is never commissioned —
   * the driver receives 100% and the platform eats the processing fee on it.
   */
  settleTip(trip: Trip, driver: Driver, rider: Rider, tipCents: Cents): void {
    if (tipCents <= 0 || !trip.split) return;
    const fee = Math.round(tipCents * this.store.config.stripe.percent) + this.store.config.stripe.fixedCents;

    this.post('charge', tipCents, `rider:${rider.id}`, `Tip from ${rider.name}`, trip.id, sid('pi'));
    this.post('processing_fee', -fee, 'stripe', `Stripe fee on ${cents(tipCents)} tip`, trip.id, sid('ch'));
    this.post('transfer', -tipCents, `driver:${driver.id}`, `Tip passthrough to ${driver.stripeAccountId}`, trip.id, sid('tr'));

    driver.wallet.availableCents += tipCents;
    driver.wallet.lifetimeCents += tipCents;

    const s = trip.split;
    s.tipCents += tipCents;
    s.chargeCents += tipCents;
    s.stripeFeeCents += fee;
    s.driverPayoutCents += tipCents;
    s.platformNetCents -= fee;
    s.takeRate = s.chargeCents > 0 ? s.platformNetCents / s.chargeCents : 0;
  }

  chargeCancellationFee(trip: Trip, rider: Rider, driver: Driver | null, feeCents: Cents): void {
    if (feeCents <= 0) return;
    trip.cancelFeeCents = feeCents;
    this.post('cancellation_fee', feeCents, `rider:${rider.id}`,
      `Cancellation fee · ${cents(feeCents)}`, trip.id, sid('pi'));

    if (driver) {
      // The driver already burned fuel getting there. They keep 80%.
      const driverShare = Math.round(feeCents * 0.8);
      this.post('transfer', -driverShare, `driver:${driver.id}`,
        `Cancellation compensation to ${driver.name}`, trip.id, sid('tr'));
      driver.wallet.availableCents += driverShare;
    }
  }

  subscribeMembership(rider: Rider): void {
    const price = this.store.config.membership.priceCents;
    rider.isMember = true;
    rider.memberSince = this.store.simSec;
    this.post('subscription', price, `rider:${rider.id}`, `Tylo+ membership · ${cents(price)}/mo`, undefined, sid('sub'));
    this.events.emit('rider:update', rider);
  }

  cancelMembership(rider: Rider): void {
    rider.isMember = false;
    rider.memberSince = null;
    this.events.emit('rider:update', rider);
  }

  refund(trip: Trip | null, rider: Rider, amountCents: Cents, memo: string): void {
    if (amountCents <= 0) throw new BadRequestException('Refund must be positive');
    const max = trip?.split?.chargeCents ?? amountCents;
    const amount = Math.min(amountCents, max);
    rider.walletCents += amount;
    if (trip) trip.refundedCents = (trip.refundedCents ?? 0) + amount;
    this.post('refund', -amount, `rider:${rider.id}`, memo, trip?.id, sid('re'));
    this.events.emit('rider:update', rider);
  }

  instantPayout(driver: Driver): Payout {
    const amount = driver.wallet.availableCents;
    if (amount < 100) throw new BadRequestException('Minimum instant payout is $1.00');

    const fee = instantPayoutFee(this.store.config, amount);
    const net = amount - fee;
    driver.wallet.availableCents = 0;

    const payout: Payout = {
      id: sid('po'), driverId: driver.id, amountCents: amount, feeCents: fee, netCents: net,
      method: 'instant', at: this.store.simSec, status: 'paid',
      arrivalNote: 'Arrives in your bank within 30 minutes',
    };
    this.store.payouts.unshift(payout);

    this.post('payout', 0, `driver:${driver.id}`, `Instant payout ${cents(net)} to ${driver.stripeAccountId}`, undefined, payout.id);
    this.post('payout_fee', fee, `driver:${driver.id}`, `Instant payout fee · 1.5% (min $0.50)`, undefined, payout.id);

    this.events.emit('driver:update', driver);
    this.events.emit('payouts:update', this.store.payouts);
    return payout;
  }

  /** The Friday batch. Free for the driver; it is just an ACH transfer. */
  runStandardPayoutBatch(): Payout[] {
    const made: Payout[] = [];
    for (const driver of this.store.drivers.values()) {
      const amount = driver.wallet.availableCents;
      if (amount < 100) continue;
      driver.wallet.availableCents = 0;
      const payout: Payout = {
        id: sid('po'), driverId: driver.id, amountCents: amount, feeCents: 0, netCents: amount,
        method: 'standard', at: this.store.simSec, status: 'in_transit',
        arrivalNote: 'Standard ACH · arrives in 1–2 business days',
      };
      this.store.payouts.unshift(payout);
      this.post('payout', 0, `driver:${driver.id}`, `Standard payout ${cents(amount)} to ${driver.stripeAccountId}`, undefined, payout.id);
      made.push(payout);
      this.events.emit('driver:update', driver);
    }
    this.events.emit('payouts:update', this.store.payouts);
    return made;
  }
}
