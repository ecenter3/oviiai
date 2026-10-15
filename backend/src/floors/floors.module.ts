import { Module } from '@nestjs/common';
import { FloorsController } from './floors.controller';

@Module({ controllers: [FloorsController] })
export class FloorsModule {}
