import { Module } from '@nestjs/common';
import { MapObjectsController } from './map-objects.controller';

@Module({ controllers: [MapObjectsController] })
export class MapsModule {}
