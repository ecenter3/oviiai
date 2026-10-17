import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { ForbiddenAuditService } from '../oplog/forbidden-audit.service';
import { AppError, type ErrorBody, type ErrorCode } from './errors';

const BY_STATUS: Record<number, ErrorCode> = {
  400: 'VALIDATION_FAILED',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  413: 'VALIDATION_FAILED',
};

/** 所有錯誤統一成 `{ error: { code, message, details } }` */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly log = new Logger('HttpException');

  /** audit：403 寫進操作日誌（安全收尾 b） */
  constructor(private readonly audit?: ForbiddenAuditService) {}

  catch(err: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    if (err instanceof AppError) {
      if (err.code === 'FORBIDDEN' && this.audit) {
        const req = host.switchToHttp().getRequest<Request>();
        void this.audit.record(req, { message: err.message, ...err.details });
      }
      res.status(err.getStatus()).json(err.getResponse());
      return;
    }
    if (err instanceof HttpException) {
      const status = err.getStatus();
      if (status === 403 && this.audit) void this.audit.record(host.switchToHttp().getRequest<Request>(), { message: err.message });
      const body: ErrorBody = {
        error: { code: BY_STATUS[status] ?? 'INTERNAL', message: status === 413 ? '檔案太大' : err.message, details: {} },
      };
      res.status(status).json(body);
      return;
    }
    this.log.error(err instanceof Error ? err.stack : String(err));
    const body: ErrorBody = { error: { code: 'INTERNAL', message: '系統錯誤', details: {} } };
    res.status(500).json(body);
  }
}
