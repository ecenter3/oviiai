import { Module } from '@nestjs/common';
import { AlarmsModule } from '../alarms/alarms.module';
import { DispatchModule } from '../dispatch/dispatch.module';
import { FleetModule } from '../fleet/fleet.module';
import { EnvController } from './env.controller';
import { EnvService } from './env.service';

/** 環境監測、定點檢測（第二期 T-41） */
@Module({ imports: [FleetModule, AlarmsModule, DispatchModule], controllers: [EnvController], providers: [EnvService], exports: [EnvService] })
export class EnvModule {}
