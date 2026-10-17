import { Module } from '@nestjs/common';
import { CommandsModule } from '../commands/commands.module';
import { FleetModule } from '../fleet/fleet.module';
import { ParamsController } from './params.controller';
import { ParamsService } from './params.service';

@Module({ imports: [FleetModule, CommandsModule], controllers: [ParamsController], providers: [ParamsService] })
export class ParamsModule {}
