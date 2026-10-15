import { Module } from '@nestjs/common';
import { HealthController } from './health/health.controller';

// 模組依工程開發手冊「後端」章節逐步加入：
// auth, users, floors, robots, telemetry, commands, dispatch, charging, alarms,
// cameras, media, face, site, reports, integrations
@Module({
  controllers: [HealthController],
})
export class AppModule {}
