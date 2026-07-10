import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { Driver } from '@tylo/shared';
import { EventsService } from '../core/events.service';
import { StoreService } from '../core/store.service';
import { AiService } from './ai.service';
import { SurgeService } from './surge.service';
import { VerificationService } from './verification.service';

@Injectable()
export class DriversService {
  constructor(
    private readonly store: StoreService,
    private readonly events: EventsService,
    private readonly verification: VerificationService,
    private readonly surge: SurgeService,
    private readonly ai: AiService,
  ) {}

  get(id: string): Driver {
    const d = this.store.drivers.get(id);
    if (!d) throw new NotFoundException('driver');
    return d;
  }

  /** The verification gate lives here, on the server. The client cannot route around it. */
  setOnline(id: string, online: boolean): Driver {
    const d = this.get(id);
    if (online) {
      const reason = this.verification.blockReason(d);
      if (reason) throw new ConflictException(reason);
    }
    if (d.state === 'on_trip' || d.state === 'en_route') {
      throw new ConflictException('Finish your current trip first');
    }
    d.online = online;
    d.state = online ? 'available' : 'offline';
    if (!online) { d.route = null; d.routeElapsedSec = 0; }
    this.events.emit('driver:update', d);
    this.events.emit('notify', {
      id: `on-${d.id}-${this.store.simSec}`, audience: 'driver', target: d.id,
      title: online ? "You're online" : "You're offline",
      body: online ? 'Watching for ride offers near you.' : 'You will not receive offers.',
      tone: online ? 'supply' : 'info', at: this.store.simSec,
    });
    return d;
  }

  recommendations(id: string) {
    return this.ai.zoneRecommendations(this.get(id), this.surge.byZone);
  }
}
