import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { HttpExceptionFilter } from './common/http-exception.filter';

/** main.ts 與測試共用的應用程式設定 */
export function configureApp(app: NestExpressApplication): void {
  app.setGlobalPrefix('api/v1', { exclude: ['internal/(.*)'] });
  app.set('trust proxy', process.env.TRUST_PROXY ?? 'loopback');
  app.use(cookieParser());
  app.useGlobalFilters(new HttpExceptionFilter());
}
