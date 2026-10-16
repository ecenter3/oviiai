import { Module } from '@nestjs/common';
import { ChargingModule } from '../charging/charging.module';
import { CommandsModule } from '../commands/commands.module';
import { DispatchModule } from '../dispatch/dispatch.module';
import { FleetModule } from '../fleet/fleet.module';
import { AlarmSourcesService } from './alarm-sources.service';
import { AlarmRulesController, AlarmsController } from './alarms.controller';
import { AlarmsService } from './alarms.service';

@Module({
  imports: [FleetModule, CommandsModule, DispatchModule, ChargingModule],
  controllers: [AlarmsController, AlarmRulesController],
  providers: [AlarmsService, AlarmSourcesService],
  exports: [AlarmsService],
})
export class AlarmsModule {}
