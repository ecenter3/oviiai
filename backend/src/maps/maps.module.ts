import { Module } from '@nestjs/common';
import { OpLogModule } from '../oplog/oplog.module';
import { MapAdminController } from './map-admin.controller';
import { MapObjectsController } from './map-objects.controller';

@Module({ imports: [OpLogModule], controllers: [MapObjectsController, MapAdminController] })
export class MapsModule {}
