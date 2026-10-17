import { Module } from '@nestjs/common';
import { CommandsModule } from '../commands/commands.module';
import { FleetModule } from '../fleet/fleet.module';
import { MediaModule } from '../media/media.module';
import { OpLogModule } from '../oplog/oplog.module';
import { StorageModule } from '../storage/storage.module';
import { IntercomController } from './intercom.controller';
import { IntercomService } from './intercom.service';

/** 雙向對講（T-31） */
@Module({ imports: [FleetModule, CommandsModule, MediaModule, OpLogModule, StorageModule], controllers: [IntercomController], providers: [IntercomService], exports: [IntercomService] })
export class IntercomModule {}
