import { Module } from '@nestjs/common';
import { CommandsModule } from '../commands/commands.module';
import { DispatchModule } from '../dispatch/dispatch.module';
import { FleetModule } from '../fleet/fleet.module';
import { ChargingController } from './charging.controller';
import { ChargingService } from './charging.service';

@Module({
  imports: [FleetModule, CommandsModule, DispatchModule],
  controllers: [ChargingController],
  providers: [ChargingService],
  exports: [ChargingService],
})
export class ChargingModule {}
