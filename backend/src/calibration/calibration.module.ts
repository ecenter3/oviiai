import { Module } from '@nestjs/common';
import { FleetModule } from '../fleet/fleet.module';
import { OpLogModule } from '../oplog/oplog.module';
import { CalibrationController } from './calibration.controller';

@Module({ imports: [FleetModule, OpLogModule], controllers: [CalibrationController] })
export class CalibrationModule {}
