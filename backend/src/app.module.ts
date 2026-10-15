import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { DatabaseModule } from './db/database.module';
import { HealthController } from './health/health.controller';
import { OpLogModule } from './oplog/oplog.module';

// 模組依工程開發手冊「後端」章節逐步加入：
// users, floors, robots, telemetry, commands, dispatch, charging, alarms,
// cameras, media, face, site, reports, integrations
@Module({
  imports: [DatabaseModule, OpLogModule, AuthModule],
  controllers: [HealthController],
})
export class AppModule {}
