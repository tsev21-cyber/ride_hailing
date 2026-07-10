import { Logger, OnModuleInit } from '@nestjs/common';
import {
  OnGatewayConnection, OnGatewayDisconnect, WebSocketGateway, WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { StateService } from '../core/state.service';
import { EventsService } from '../core/events.service';

/**
 * The only place socket.io is mentioned. Engines publish domain events on the
 * bus; this relays them. Rooms are unnecessary here because the demo console
 * is deliberately omniscient — it renders the rider app, the driver app and
 * the ops dashboard side by side. In production the same events are scoped to
 * `rider:<id>`, `driver:<id>` and `admin`.
 */
@WebSocketGateway({ cors: { origin: true, credentials: true } })
export class RealtimeGateway implements OnModuleInit, OnGatewayConnection, OnGatewayDisconnect {
  private readonly log = new Logger('Realtime');

  @WebSocketServer()
  server: Server;

  constructor(private readonly events: EventsService, private readonly state: StateService) {}

  onModuleInit(): void {
    this.events.bus.subscribe(({ name, payload }) => {
      if (name.startsWith('internal:')) return;
      this.server?.emit(name, payload);
    });
  }

  handleConnection(client: Socket): void {
    this.log.log(`console connected · ${client.id}`);
    client.emit('world:snapshot', this.state.snapshot());
  }

  handleDisconnect(client: Socket): void {
    this.log.log(`console disconnected · ${client.id}`);
  }
}
