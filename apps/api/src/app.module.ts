import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { DbService } from './db/db.service.js';
import { MqttService } from './mqtt.service.js';
import { CommandsService } from './commands.service.js';
import { PriceChangesService } from './price-changes.service.js';
import { AuthGuard } from './auth.js';
import { NotifierService } from './notifier.service.js';
import { ManualController, ManualService, PhotosController } from './manual.js';
import { GridsController, GridsService } from './grids.js';
import {
  AlertsController, CommandsController, HealthController, PriceChangesController, StationsController,
} from './controllers.js';

@Module({
  controllers: [
    HealthController, StationsController, PriceChangesController, CommandsController, PhotosController, AlertsController,
    ManualController, GridsController,
  ],
  providers: [
    DbService, MqttService, NotifierService, CommandsService, PriceChangesService, ManualService, GridsService,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}
