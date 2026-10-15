import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { OpLogController } from './oplog.controller';
import { OpLogInterceptor } from './oplog.interceptor';
import { OpLogService } from './oplog.service';

@Module({
  controllers: [OpLogController],
  providers: [OpLogService, { provide: APP_INTERCEPTOR, useClass: OpLogInterceptor }],
  exports: [OpLogService],
})
export class OpLogModule {}
