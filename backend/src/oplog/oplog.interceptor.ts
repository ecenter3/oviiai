import { CallHandler, ExecutionContext, HttpException, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { catchError, concatMap, from, Observable, throwError } from 'rxjs';
import type { Principal } from '../auth/principal';
import { AppError } from '../common/errors';
import { OPLOG, type OpLogMeta } from './oplog.decorator';
import { OpLogService } from './oplog.service';
import { isEmpty, summarize } from './summarize';

/** 執行 @OpLog 標記的處理函式後寫入 op_logs；成功、失敗都記。日誌寫入失敗不影響操作本身。 */
@Injectable()
export class OpLogInterceptor implements NestInterceptor {
  private readonly log = new Logger('OpLog');

  constructor(
    private readonly reflector: Reflector,
    private readonly oplog: OpLogService,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const meta = this.reflector.get<OpLogMeta | undefined>(OPLOG, ctx.getHandler());
    if (!meta) return next.handle();
    const req = ctx.switchToHttp().getRequest<Request & { user?: Principal }>();

    return next.handle().pipe(
      concatMap(async (result) => {
        await this.record(meta, req, result, undefined);
        return result;
      }),
      catchError((err) => from(this.record(meta, req, undefined, err)).pipe(concatMap(() => throwError(() => err)))),
    );
  }

  private async record(meta: OpLogMeta, req: Request & { user?: Principal; oplogged?: boolean }, result: unknown, err: unknown) {
    // 失敗已記在這筆：403 不再另記 auth.forbidden
    if (err !== undefined) req.oplogged = true;
    try {
      const detail: Record<string, unknown> = { ok: err === undefined };
      if (err !== undefined) detail.error = errorCode(err);
      if (!isEmpty(req.params)) detail.params = req.params;
      if (!isEmpty(req.body)) detail.body = summarize(req.body);
      await this.oplog.write({
        userId: req.user?.sub ?? null,
        username: req.user?.username ?? '(未登入)',
        action: typeof meta.action === 'function' ? meta.action(req) : meta.action,
        target: meta.target?.(req, result) ?? null,
        detail,
        ip: req.ip ?? null,
      });
    } catch (e) {
      this.log.error(`寫入操作日誌失敗：${e instanceof Error ? e.message : e}`);
    }
  }
}

function errorCode(err: unknown): string {
  if (err instanceof AppError) return err.code;
  if (err instanceof HttpException) return `HTTP_${err.getStatus()}`;
  return 'INTERNAL';
}
