import { Module } from '@nestjs/common';
import { OpLogModule } from '../oplog/oplog.module';
import { FloorsController } from './floors.controller';

@Module({ imports: [OpLogModule], controllers: [FloorsController] })
export class FloorsModule {}
