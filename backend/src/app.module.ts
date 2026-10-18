import { Module } from '@nestjs/common';
import { AlarmsModule } from './alarms/alarms.module';
import { AuthModule } from './auth/auth.module';
import { CalibrationModule } from './calibration/calibration.module';
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
import { MaintenanceModule } from './maintenance/maintenance.module';
import { IntercomModule } from './intercom/intercom.module';
import { MediaModule } from './media/media.module';
import { NavModule } from './nav/nav.module';
import { ParamsModule } from './params/params.module';
import { SiteModule } from './site/site.module';
import { SiteSetupModule } from './site-setup/site-setup.module';
import { StorageModule } from './storage/storage.module';

// 模組依工程開發手冊「後端」章節逐步加入：
// face, reports, integrations
import { ReportsModule } from './reports/reports.module';
import { StatsModule } from './stats/stats.module';
import { AssetsModule } from './assets/assets.module';
import { RobotLogsModule } from './robot-logs/robot-logs.module';
import { VersionsModule } from './versions/versions.module';

@Module({
  imports: [
    DatabaseModule,
    RedisModule,
    MqttModule,
    SettingsModule,
    StorageModule,
    OpLogModule,
    AuthModule,
    UsersModule,
    RolesModule,
    FloorsModule,
    MapsModule,
    FleetModule,
    CommandsModule,
    ParamsModule,
    IntercomModule,
    DispatchModule,
    ChargingModule,
    AlarmsModule,
    NavModule,
    SiteModule,
    SiteSetupModule,
    CalibrationModule,
    MediaModule,
    MaintenanceModule,
    ReportsModule,
    StatsModule,
    AssetsModule,
    RobotLogsModule,
    VersionsModule,
    RealtimeModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
