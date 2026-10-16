import { Module } from '@nestjs/common';
import { AlarmsModule } from '../alarms/alarms.module';
import { CommandsModule } from '../commands/commands.module';
import { DispatchModule } from '../dispatch/dispatch.module';
import { FleetModule } from '../fleet/fleet.module';
import { OpLogModule } from '../oplog/oplog.module';
import { NavController } from './nav.controller';
import { PatrolController } from './patrol.controller';
import { PatrolService } from './patrol.service';

@Module({
  imports: [FleetModule, CommandsModule, DispatchModule, AlarmsModule, OpLogModule],
  controllers: [NavController, PatrolController],
  providers: [PatrolService],
  exports: [PatrolService],
})
export class NavModule {}
