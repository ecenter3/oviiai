import { Module } from '@nestjs/common';
import { FleetModule } from '../fleet/fleet.module';
import { MediaModule } from '../media/media.module';
import { OpLogModule } from '../oplog/oplog.module';
import { AdapterConfigController } from './adapter-config.controller';
import { RobotAdminController } from './robot-admin.controller';

@Module({ imports: [FleetModule, OpLogModule, MediaModule], controllers: [RobotAdminController, AdapterConfigController] })
export class SiteModule {}
