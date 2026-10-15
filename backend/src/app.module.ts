import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { DatabaseModule } from './db/database.module';
import { FleetModule } from './fleet/fleet.module';
import { HealthController } from './health/health.controller';
import { MqttModule } from './mqtt/mqtt.module';
import { OpLogModule } from './oplog/oplog.module';
import { RedisModule } from './redis/redis.module';
import { RolesModule } from './roles/roles.module';
import { SettingsModule } from './settings/settings.module';
import { UsersModule } from './users/users.module';

// 模組依工程開發手冊「後端」章節逐步加入：
// floors, robots, commands, dispatch, charging, alarms,
// cameras, media, face, site, reports, integrations
@Module({
  imports: [
    DatabaseModule,
    RedisModule,
    MqttModule,
    SettingsModule,
    OpLogModule,
    AuthModule,
    UsersModule,
    RolesModule,
    FleetModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
