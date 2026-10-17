import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ForbiddenAuditService } from './forbidden-audit.service';
import { OpLogController } from './oplog.controller';
import { OpLogInterceptor } from './oplog.interceptor';
import { OpLogService } from './oplog.service';

@Module({
  controllers: [OpLogController],
  providers: [OpLogService, ForbiddenAuditService, { provide: APP_INTERCEPTOR, useClass: OpLogInterceptor }],
  exports: [OpLogService, ForbiddenAuditService],
})
export class OpLogModule {}
