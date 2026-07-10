import { Module } from '@nestjs/common';
import {
  AdminController, DriverController, RidesController, SupportController, SystemController,
} from './api/api.controller';
import { EventsService } from './core/events.service';
import { StateService } from './core/state.service';
import { StoreService } from './core/store.service';
import { AiService } from './engine/ai.service';
import { AnalyticsService } from './engine/analytics.service';
import { DispatchService } from './engine/dispatch.service';
import { DriversService } from './engine/drivers.service';
import { PaymentsService } from './engine/payments.service';
import { PromosService } from './engine/promos.service';
import { SupportService } from './engine/support.service';
import { SurgeService } from './engine/surge.service';
import { TripsService } from './engine/trips.service';
import { VerificationService } from './engine/verification.service';
import { RealtimeGateway } from './realtime/realtime.gateway';
import { WorldService } from './world/world.service';

@Module({
  controllers: [SystemController, RidesController, DriverController, SupportController, AdminController],
  providers: [
    StoreService, EventsService, StateService,
    AiService, SurgeService, PaymentsService, PromosService, VerificationService,
    TripsService, DispatchService, DriversService, SupportService, AnalyticsService,
    WorldService, RealtimeGateway,
  ],
})
export class AppModule {}
