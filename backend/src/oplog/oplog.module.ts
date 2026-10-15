import { Module } from '@nestjs/common';
import { OpLogService } from './oplog.service';

@Module({
  providers: [OpLogService],
  exports: [OpLogService],
})
export class OpLogModule {}
