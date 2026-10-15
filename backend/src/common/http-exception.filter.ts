import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { AppError, type ErrorBody, type ErrorCode } from './errors';

const BY_STATUS: Record<number, ErrorCode> = {
  400: 'VALIDATION_FAILED',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
};

/** 所有錯誤統一成 `{ error: { code, message, details } }` */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly log = new Logger('HttpException');

  catch(err: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    if (err instanceof AppError) {
      res.status(err.getStatus()).json(err.getResponse());
      return;
    }
    if (err instanceof HttpException) {
      const status = err.getStatus();
      const body: ErrorBody = {
        error: { code: BY_STATUS[status] ?? 'INTERNAL', message: err.message, details: {} },
      };
      res.status(status).json(body);
      return;
    }
    this.log.error(err instanceof Error ? err.stack : String(err));
    const body: ErrorBody = { error: { code: 'INTERNAL', message: '系統錯誤', details: {} } };
    res.status(500).json(body);
  }
}
