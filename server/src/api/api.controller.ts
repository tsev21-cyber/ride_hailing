import {
  BadRequestException, Body, Controller, Get, NotFoundException, Param, Patch, Post,
} from '@nestjs/common';
import { clamp, type PlatformConfig, type ProductKey, type Promo, type Ticket, type Vec } from '@tylo/shared';
import { EventsService } from '../core/events.service';
import { StateService } from '../core/state.service';
import { StoreService } from '../core/store.service';
import { AnalyticsService } from '../engine/analytics.service';
import { DispatchService } from '../engine/dispatch.service';
import { DriversService } from '../engine/drivers.service';
import { PaymentsService } from '../engine/payments.service';
import { PromosService } from '../engine/promos.service';
import { SupportService } from '../engine/support.service';
import { TripsService } from '../engine/trips.service';
import { VerificationService } from '../engine/verification.service';
import { WorldService } from '../world/world.service';

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function deepMerge<T>(target: T, patch: unknown): T {
  if (!isPlain(patch)) return target;
  for (const [k, v] of Object.entries(patch)) {
    const cur = (target as Record<string, unknown>)[k];
    if (isPlain(v) && isPlain(cur)) deepMerge(cur, v);
    else if (v !== undefined) (target as Record<string, unknown>)[k] = v;
  }
  return target;
}

/* ============================================================ system */

@Controller()
export class SystemController {
  constructor(
    private readonly state: StateService,
    private readonly store: StoreService,
    private readonly world: WorldService,
    private readonly promos: PromosService,
    private readonly payments: PaymentsService,
  ) {}

  @Get('state')
  snapshot() { return this.state.snapshot(); }

  @Post('sim/speed')
  speed(@Body() b: { speed: number }) {
    this.world.setSpeed(Number(b.speed) || 0);
    return { speed: this.store.speed };
  }

  @Post('sim/reset')
  reset() { this.world.reset(); return this.state.snapshot(); }

  @Post('promos/check')
  check(@Body() b: { code: string; fareCents: number }) {
    return this.promos.check(this.store.humanRiderId, b.code, b.fareCents);
  }

  @Post('membership/subscribe')
  subscribe() { this.payments.subscribeMembership(this.store.humanRider); return this.store.humanRider; }

  @Post('membership/cancel')
  unsubscribe() { this.payments.cancelMembership(this.store.humanRider); return this.store.humanRider; }
}

/* ============================================================ rider */

interface RequestBody {
  product: ProductKey;
  pickup: Vec;
  dropoff: Vec;
  pickupLabel: string;
  dropoffLabel: string;
  promoCode?: string | null;
}

@Controller('rides')
export class RidesController {
  constructor(
    private readonly trips: TripsService,
    private readonly store: StoreService,
  ) {}

  @Post('quote')
  quote(@Body() b: { pickup: Vec; dropoff: Vec; promoCode?: string | null }) {
    return this.trips.quoteAll(this.store.humanRiderId, b.pickup, b.dropoff, b.promoCode ?? null);
  }

  @Post()
  request(@Body() b: RequestBody) {
    return this.trips.request(
      this.store.humanRiderId, b.product, b.pickup, b.dropoff,
      { pickup: b.pickupLabel, dropoff: b.dropoffLabel }, b.promoCode ?? null, false,
    );
  }

  @Get(':id/cancellation')
  policy(@Param('id') id: string) { return this.trips.cancellationQuote(id); }

  @Post(':id/cancel')
  cancel(@Param('id') id: string) { return this.trips.cancelByRider(id); }

  @Post(':id/tip')
  tip(@Param('id') id: string, @Body() b: { cents: number }) {
    return this.trips.addTip(id, Math.max(0, Math.round(b.cents)));
  }

  @Post(':id/rate')
  rate(@Param('id') id: string, @Body() b: { stars: number }) { return this.trips.rate(id, b.stars); }
}

/* ============================================================ driver */

@Controller('driver')
export class DriverController {
  constructor(
    private readonly drivers: DriversService,
    private readonly dispatch: DispatchService,
    private readonly trips: TripsService,
    private readonly payments: PaymentsService,
    private readonly world: WorldService,
    private readonly store: StoreService,
    private readonly verification: VerificationService,
  ) {}

  private get me() { return this.store.humanDriver; }

  @Get('me')
  self() {
    const { route, ...rest } = this.me;
    return { ...rest, blockReason: this.verification.blockReason(this.me), autoAccept: this.world.autoAcceptHuman };
  }

  @Post('online')
  online(@Body() b: { online: boolean }) { return this.drivers.setOnline(this.me.id, !!b.online); }

  /** Simulates the phone losing signal — the console itself stays connected. */
  @Post('connection')
  connection(@Body() b: { connected: boolean }) { return this.world.setConnected(this.me.id, !!b.connected); }

  @Post('autoaccept')
  autoAccept(@Body() b: { enabled: boolean }) {
    this.world.autoAcceptHuman = !!b.enabled;
    return { enabled: this.world.autoAcceptHuman };
  }

  @Post('offers/:offerId/accept')
  accept(@Param('offerId') offerId: string) { return this.dispatch.accept(this.me.id, offerId); }

  @Post('offers/:offerId/decline')
  decline(@Param('offerId') offerId: string) {
    this.dispatch.decline(this.me.id, offerId);
    return { ok: true };
  }

  @Post('trip/start')
  start() {
    const trip = this.currentTrip();
    if (trip.state !== 'driver_arrived') throw new BadRequestException(`Cannot start from "${trip.state}"`);
    this.trips.startTrip(trip);
    return trip;
  }

  @Post('trip/complete')
  complete() {
    const trip = this.currentTrip();
    if (trip.state !== 'in_progress') throw new BadRequestException(`Cannot complete from "${trip.state}"`);
    this.trips.completeTrip(trip);
    return trip;
  }

  @Post('trip/cancel')
  cancel() { return this.trips.cancelByDriver(this.currentTrip().id); }

  @Get('recommendations')
  recommendations() { return this.drivers.recommendations(this.me.id); }

  @Post('payout/instant')
  payout() { return this.payments.instantPayout(this.me); }

  private currentTrip() {
    const id = this.me.tripId;
    if (!id) throw new NotFoundException('You are not on a trip');
    const trip = this.store.trips.get(id);
    if (!trip) throw new NotFoundException('trip');
    return trip;
  }
}

/* ============================================================ support */

@Controller('support')
export class SupportController {
  constructor(private readonly support: SupportService, private readonly store: StoreService) {}

  @Post('tickets')
  open(@Body() b: { tripId: string | null; category: Ticket['category']; subject: string; body: string }) {
    return this.support.open(this.store.humanRiderId, b.tripId ?? null, b.category, b.subject, b.body);
  }
}

/* ============================================================ admin */

@Controller('admin')
export class AdminController {
  constructor(
    private readonly store: StoreService,
    private readonly events: EventsService,
    private readonly analytics: AnalyticsService,
    private readonly promos: PromosService,
    private readonly support: SupportService,
    private readonly payments: PaymentsService,
    private readonly verification: VerificationService,
  ) {}

  @Get('metrics')
  metrics() { return this.analytics.metrics(); }

  /** Editing pricing here changes the next quote every rider sees. */
  @Patch('config')
  config(@Body() patch: Partial<PlatformConfig>) {
    deepMerge(this.store.config, patch);
    this.store.config.commissionPct = clamp(this.store.config.commissionPct, 0, 0.9);
    this.events.emit('config:update', this.store.config);
    return this.store.config;
  }

  @Post('promos')
  upsertPromo(@Body() promo: Promo) { return this.promos.upsert(promo); }

  @Post('promos/:code/active')
  togglePromo(@Param('code') code: string, @Body() b: { active: boolean }) {
    return this.promos.setActive(code.toUpperCase(), !!b.active);
  }

  @Get('tickets')
  tickets() { return this.support.list(); }

  @Post('tickets/:id/reply')
  reply(@Param('id') id: string, @Body() b: { body: string }) { return this.support.reply(id, b.body); }

  @Post('tickets/:id/resolve')
  resolve(@Param('id') id: string, @Body() b: { refundCents?: number }) {
    return this.support.resolve(id, Math.max(0, Math.round(b.refundCents ?? 0)));
  }

  @Post('drivers/:id/documents/:doc')
  document(@Param('id') id: string, @Param('doc') doc: string, @Body() b: { status: 'verified' | 'rejected' | 'pending' }) {
    return this.verification.setDocument(id, doc as never, b.status);
  }

  @Post('drivers/:id/adjudicate')
  adjudicate(@Param('id') id: string, @Body() b: { decision: 'clear' | 'suspend' }) {
    return this.verification.adjudicate(id, b.decision);
  }

  @Post('payouts/batch')
  batch() { return this.payments.runStandardPayoutBatch(); }
}
