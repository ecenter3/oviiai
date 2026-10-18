import { Module } from '@nestjs/common';
import { EmqxApi } from '../mqtt/emqx-api';
import { AdapterRevoker } from './adapter-revoker.service';
import { FleetService } from './fleet.service';
import { RobotRegistry } from './robot-registry';
import { TelemetryWriter } from './telemetry-writer';

@Module({
  providers: [RobotRegistry, TelemetryWriter, FleetService, EmqxApi, AdapterRevoker],
  exports: [FleetService, RobotRegistry],
})
export class FleetModule {}
