import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { DatabaseModule } from './db/database.module';
import { DispatchModule } from './dispatch/dispatch.module';
import { ChargingModule } from './charging/charging.module';
import { CommandsModule } from './commands/commands.module';
import { FleetModule } from './fleet/fleet.module';
import { FloorsModule } from './floors/floors.module';
import { HealthController } from './health/health.controller';
import { MqttModule } from './mqtt/mqtt.module';
import { OpLogModule } from './oplog/oplog.module';
import { RealtimeModule } from './realtime/realtime.module';
import { RedisModule } from './redis/redis.module';
import { RolesModule } from './roles/roles.module';
import { SettingsModule } from './settings/settings.module';
import { MapsModule } from './maps/maps.module';
import { UsersModule } from './users/users.module';

// 模組依工程開發手冊「後端」章節逐步加入：
// alarms,
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
    FloorsModule,
    MapsModule,
    FleetModule,
    CommandsModule,
    DispatchModule,
    ChargingModule,
    RealtimeModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
