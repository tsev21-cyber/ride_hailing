import { Injectable, NotFoundException } from '@nestjs/common';
import { cents, sid, type Cents, type Ticket } from '@tylo/shared';
import { EventsService } from '../core/events.service';
import { StoreService } from '../core/store.service';
import { PaymentsService } from './payments.service';

const PRIORITY: Record<Ticket['category'], Ticket['priority']> = {
  safety: 'urgent',
  driver_conduct: 'high',
  fare_dispute: 'normal',
  lost_item: 'high',
  app_issue: 'normal',
};

@Injectable()
export class SupportService {
  constructor(
    private readonly store: StoreService,
    private readonly events: EventsService,
    private readonly payments: PaymentsService,
  ) {}

  list(): Ticket[] {
    return [...this.store.tickets.values()].sort((a, b) => b.openedAt - a.openedAt);
  }

  open(riderId: string, tripId: string | null, category: Ticket['category'], subject: string, body: string): Ticket {
    const ticket: Ticket = {
      id: sid('tkt', 8).toUpperCase(),
      tripId, riderId, category, subject,
      status: 'open',
      priority: PRIORITY[category],
      messages: [{ from: 'rider', body, at: this.store.simSec }],
      refundedCents: 0,
      openedAt: this.store.simSec,
    };
    this.store.tickets.set(ticket.id, ticket);
    this.broadcast();
    this.events.emit('notify', {
      id: ticket.id, audience: 'admin', title: `New ${ticket.priority} ticket`,
      body: `${subject} · ${tripId ?? 'no trip'}`,
      tone: ticket.priority === 'urgent' ? 'error' : 'info', at: this.store.simSec,
    });
    return ticket;
  }

  reply(id: string, body: string): Ticket {
    const t = this.get(id);
    t.messages.push({ from: 'agent', body, at: this.store.simSec });
    t.status = 'pending_rider';
    this.broadcast();
    this.events.emit('notify', {
      id: `${id}-r`, audience: 'rider', target: t.riderId,
      title: 'Support replied', body, tone: 'info', at: this.store.simSec,
    });
    return t;
  }

  /** Resolving with money attached actually moves money. */
  resolve(id: string, refundCents: Cents = 0): Ticket {
    const t = this.get(id);
    const rider = this.store.riders.get(t.riderId);
    if (!rider) throw new NotFoundException('rider');

    if (refundCents > 0) {
      const trip = t.tripId ? this.store.trips.get(t.tripId) ?? null : null;
      this.payments.refund(trip, rider, refundCents, `Support refund · ticket ${t.id}`);
      t.refundedCents += refundCents;
      t.messages.push({
        from: 'agent',
        body: `We've refunded ${cents(refundCents)} to your Tylo wallet. Sorry about that.`,
        at: this.store.simSec,
      });
      this.events.emit('notify', {
        id: `${id}-ref`, audience: 'rider', target: t.riderId,
        title: 'Refund issued', body: `${cents(refundCents)} added to your wallet`,
        tone: 'success', at: this.store.simSec,
      });
    }
    t.status = 'resolved';
    this.broadcast();
    return t;
  }

  private get(id: string): Ticket {
    const t = this.store.tickets.get(id);
    if (!t) throw new NotFoundException('ticket');
    return t;
  }

  private broadcast() { this.events.emit('tickets:update', this.list()); }
}
