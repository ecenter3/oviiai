import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CommandsModule } from '../commands/commands.module';
import { FleetModule } from '../fleet/fleet.module';
import { RealtimeGateway } from './realtime.gateway';

@Module({
  imports: [AuthModule, FleetModule, CommandsModule],
  providers: [RealtimeGateway],
})
export class RealtimeModule {}
