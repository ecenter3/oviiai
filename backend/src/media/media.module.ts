import { Module } from '@nestjs/common';
import { AlarmsModule } from '../alarms/alarms.module';
import { OpLogModule } from '../oplog/oplog.module';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';
import { MediaMtxClient } from './mediamtx.client';
import { MediaAuthController, StreamsController } from './streams.controller';
import { StreamsService } from './streams.service';

@Module({
  imports: [AlarmsModule, OpLogModule],
  controllers: [StreamsController, MediaAuthController, MediaController],
  providers: [MediaMtxClient, StreamsService, MediaService],
  exports: [StreamsService, MediaService, MediaMtxClient],
})
export class MediaModule {}
