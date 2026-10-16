import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ChargingModule } from '../charging/charging.module';
import { CommandsModule } from '../commands/commands.module';
import { DispatchModule } from '../dispatch/dispatch.module';
import { FleetModule } from '../fleet/fleet.module';
import { RealtimeGateway } from './realtime.gateway';
import { StatsService } from './stats.service';

@Module({
  imports: [AuthModule, FleetModule, CommandsModule, DispatchModule, ChargingModule],
  providers: [RealtimeGateway, StatsService],
})
export class RealtimeModule {}
