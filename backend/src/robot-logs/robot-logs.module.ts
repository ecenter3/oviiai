import { Module } from '@nestjs/common';
import { CommandsModule } from '../commands/commands.module';
import { FleetModule } from '../fleet/fleet.module';
import { StorageModule } from '../storage/storage.module';
import { RobotLogsController } from './robot-logs.controller';
import { RobotLogsService } from './robot-logs.service';

/** 日誌管理（T-42） */
@Module({ imports: [FleetModule, CommandsModule, StorageModule], controllers: [RobotLogsController], providers: [RobotLogsService], exports: [RobotLogsService] })
export class RobotLogsModule {}
