import { Module } from '@nestjs/common';
import { FleetService } from './fleet.service';
import { RobotRegistry } from './robot-registry';
import { TelemetryWriter } from './telemetry-writer';

@Module({
  providers: [RobotRegistry, TelemetryWriter, FleetService],
  exports: [FleetService, RobotRegistry],
})
export class FleetModule {}
