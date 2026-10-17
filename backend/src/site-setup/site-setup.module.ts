import { Module } from '@nestjs/common';
import { FleetModule } from '../fleet/fleet.module';
import { MediaModule } from '../media/media.module';
import { NavModule } from '../nav/nav.module';
import { OpLogModule } from '../oplog/oplog.module';
import { StorageModule } from '../storage/storage.module';
import { BulkImportService } from './bulk-import.service';
import { SetupStatusService } from './setup-status.service';
import { SiteSetupController } from './site-setup.controller';
import { SiteTransferService } from './site-transfer.service';

/** 場域快速設定：批次匯入（T-45）、場域設定匯出匯入（T-44）、設定精靈（T-46） */
@Module({
  imports: [FleetModule, MediaModule, NavModule, StorageModule, OpLogModule],
  controllers: [SiteSetupController],
  providers: [BulkImportService, SiteTransferService, SetupStatusService],
})
export class SiteSetupModule {}
