import { Module } from '@nestjs/common';
import { FleetModule } from '../fleet/fleet.module';
import { OpLogModule } from '../oplog/oplog.module';
import { AdapterConfigController } from './adapter-config.controller';
import { RobotAdminController } from './robot-admin.controller';

@Module({ imports: [FleetModule, OpLogModule], controllers: [RobotAdminController, AdapterConfigController] })
export class SiteModule {}
