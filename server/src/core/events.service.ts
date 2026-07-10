import { Injectable } from '@nestjs/common';
import { Subject } from 'rxjs';

export interface ServerEvent { name: string; payload: unknown }

/**
 * One bus between the engines and the socket gateway. Services never touch
 * socket.io directly, so the dispatch engine is testable without a transport.
 */
@Injectable()
export class EventsService {
  readonly bus = new Subject<ServerEvent>();

  emit(name: string, payload: unknown): void {
    this.bus.next({ name, payload });
  }
}
