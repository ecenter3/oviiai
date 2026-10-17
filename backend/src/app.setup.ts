import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { HttpExceptionFilter } from './common/http-exception.filter';
import { ForbiddenAuditService } from './oplog/forbidden-audit.service';

/** main.ts 與測試共用的應用程式設定 */
export function configureApp(app: NestExpressApplication): void {
  // path-to-regexp v8（Express 5、Nest 11 起）：萬用字元要具名，{} 表示可省略
  app.setGlobalPrefix('api/v1', { exclude: ['internal/{*path}'] });
  app.set('trust proxy', process.env.TRUST_PROXY ?? 'loopback');
  app.use(cookieParser());
  app.useGlobalFilters(new HttpExceptionFilter(app.get(ForbiddenAuditService, { strict: false })));
}
