import { Injectable, NotFoundException } from '@nestjs/common';
import type { DocStatus, Driver } from '@tylo/shared';
import { EventsService } from '../core/events.service';
import { StoreService } from '../core/store.service';

const DOC_LABEL: Record<string, string> = {
  drivers_license: "Driver's license",
  insurance: 'Proof of insurance',
  vehicle_registration: 'Vehicle registration',
  profile_photo: 'Profile photo',
};

/**
 * Driver trust & safety. In production `backgroundCheck` is a Checkr report
 * (invitation → report → clear / consider), and a "consider" result must be
 * adjudicated by a human under FCRA before any adverse action. The gate below
 * is enforced server-side: no client can flip a driver online around it.
 */
@Injectable()
export class VerificationService {
  constructor(private readonly store: StoreService, private readonly events: EventsService) {}

  /** Null when the driver may drive; otherwise the reason they may not. */
  blockReason(driver: Driver): string | null {
    const missing = Object.entries(driver.verification.documents)
      .filter(([, s]) => s !== 'verified')
      .map(([k, s]) => `${DOC_LABEL[k]} (${s})`);
    if (missing.length) return `Document review outstanding: ${missing.join(', ')}`;

    const bg = driver.verification.backgroundCheck;
    if (bg.status === 'pending') return 'Background check is still processing';
    if (bg.status === 'consider') return 'Background check returned "consider" — awaiting adjudication';
    if (bg.status === 'suspended') return 'Account suspended by Trust & Safety';
    if (bg.status === 'not_started') return 'Background check has not been submitted';

    if (!driver.verification.approvedByAdmin) return 'Awaiting final admin approval';
    return null;
  }

  canGoOnline(driver: Driver): boolean { return this.blockReason(driver) === null; }

  setDocument(driverId: string, doc: keyof Driver['verification']['documents'], status: DocStatus): Driver {
    const d = this.store.drivers.get(driverId);
    if (!d) throw new NotFoundException('driver');
    d.verification.documents[doc] = status;
    this.publish(d, `${DOC_LABEL[doc]} marked ${status}`);
    return d;
  }

  /** Clears or suspends a "consider" report. */
  adjudicate(driverId: string, decision: 'clear' | 'suspend'): Driver {
    const d = this.store.drivers.get(driverId);
    if (!d) throw new NotFoundException('driver');
    const bg = d.verification.backgroundCheck;

    if (decision === 'clear') {
      bg.status = 'clear';
      bg.adjudication = null;
      bg.completedAt = this.store.simSec;
      d.verification.approvedByAdmin = true;
      this.publish(d, `${d.name} cleared to drive`);
    } else {
      bg.status = 'suspended';
      bg.adjudication = 'post_adverse_action';
      d.verification.approvedByAdmin = false;
      if (d.online) { d.online = false; d.state = 'offline'; }
      this.publish(d, `${d.name} suspended after adverse action`);
    }
    return d;
  }

  approve(driverId: string): Driver {
    const d = this.store.drivers.get(driverId);
    if (!d) throw new NotFoundException('driver');
    d.verification.approvedByAdmin = true;
    this.publish(d, `${d.name} approved`);
    return d;
  }

  private publish(d: Driver, body: string) {
    this.events.emit('driver:update', d);
    this.events.emit('notify', {
      id: `${d.id}-${this.store.simSec}`, audience: 'admin', title: 'Verification updated',
      body, tone: 'info', at: this.store.simSec,
    });
  }
}
