import { Module } from '@nestjs/common';
import { FleetModule } from '../fleet/fleet.module';
import { VersionsController } from './versions.controller';

/** 版本管理（T-42） */
@Module({ imports: [FleetModule], controllers: [VersionsController] })
export class VersionsModule {}
