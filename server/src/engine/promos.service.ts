import { Injectable, NotFoundException } from '@nestjs/common';
import { validatePromo, type Cents, type Promo, type PromoResult } from '@tylo/shared';
import { EventsService } from '../core/events.service';
import { StoreService } from '../core/store.service';

@Injectable()
export class PromosService {
  constructor(private readonly store: StoreService, private readonly events: EventsService) {}

  list(): Promo[] { return [...this.store.promos.values()]; }

  check(riderId: string, code: string, fareCents: Cents): PromoResult {
    const rider = this.store.riders.get(riderId);
    if (!rider) throw new NotFoundException('rider');
    return validatePromo(this.store.promos.get(code.trim().toUpperCase()), {
      isFirstRide: rider.completedTrips === 0,
      fareCents,
      nowSec: this.store.simSec,
    });
  }

  consume(code: string): void {
    const p = this.store.promos.get(code);
    if (p) { p.used += 1; this.broadcast(); }
  }

  upsert(promo: Promo): Promo {
    promo.code = promo.code.trim().toUpperCase();
    const existing = this.store.promos.get(promo.code);
    const merged: Promo = { ...(existing ?? { used: 0 }), ...promo } as Promo;
    this.store.promos.set(merged.code, merged);
    this.broadcast();
    return merged;
  }

  setActive(code: string, active: boolean): Promo {
    const p = this.store.promos.get(code);
    if (!p) throw new NotFoundException('promo');
    p.active = active;
    this.broadcast();
    return p;
  }

  private broadcast() { this.events.emit('promos:update', this.list()); }
}
