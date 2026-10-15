import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FleetGateway } from './fleet.gateway';
import { FleetService } from './fleet.service';
import { RobotRegistry } from './robot-registry';
import { TelemetryWriter } from './telemetry-writer';

@Module({
  imports: [AuthModule],
  providers: [RobotRegistry, TelemetryWriter, FleetService, FleetGateway],
  exports: [FleetService],
})
export class FleetModule {}
