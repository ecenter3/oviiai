import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { adapterAllowedCidrs, authConfig, dataEncKey, loadEnv } from './config';

async function bootstrap() {
  loadEnv();
  authConfig(); // 設定有誤（如正式環境 JWT_SECRET 不安全）在建立應用程式前就中止
  dataEncKey(); // 正式環境沒有資料加密金鑰也中止
  adapterAllowedCidrs(); // 網段格式錯誤在啟動時就中止
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  configureApp(app);
  app.enableShutdownHooks();
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  console.log(`backend listening on :${port}`);
}

bootstrap().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
