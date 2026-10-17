import { Module } from '@nestjs/common';
import { MediaModule } from '../media/media.module';
import { OpLogModule } from '../oplog/oplog.module';
import { MapAdminController } from './map-admin.controller';
import { MapObjectsController } from './map-objects.controller';

@Module({ imports: [OpLogModule, MediaModule], controllers: [MapObjectsController, MapAdminController] })
export class MapsModule {}
