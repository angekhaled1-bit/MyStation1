import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { DbService } from './db/db.service.js';
import { MqttService } from './mqtt.service.js';
import { CommandsService } from './commands.service.js';
import { PriceChangesService } from './price-changes.service.js';
import { AuthGuard } from './auth.js';
import {
  AlertsController, CommandsController, HealthController, PriceChangesController, StationsController,
} from './controllers.js';

@Module({
  controllers: [HealthController, StationsController, PriceChangesController, CommandsController, AlertsController],
  providers: [DbService, MqttService, CommandsService, PriceChangesService, { provide: APP_GUARD, useClass: AuthGuard }],
})
export class AppModule {}
