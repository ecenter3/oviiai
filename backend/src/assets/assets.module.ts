import { Module } from '@nestjs/common';
import { CommandsModule } from '../commands/commands.module';
import { FleetModule } from '../fleet/fleet.module';
import { StorageModule } from '../storage/storage.module';
import { AssetsController } from './assets.controller';
import { AssetsService } from './assets.service';

/** 音視頻管理（T-42） */
@Module({ imports: [FleetModule, CommandsModule, StorageModule], controllers: [AssetsController], providers: [AssetsService] })
export class AssetsModule {}
