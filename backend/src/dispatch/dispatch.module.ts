import { Module } from '@nestjs/common';
import { CommandsModule } from '../commands/commands.module';
import { FleetModule } from '../fleet/fleet.module';
import { DispatchService } from './dispatch.service';
import { RobotsController } from './robots.controller';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';

@Module({
  imports: [FleetModule, CommandsModule],
  controllers: [TasksController, RobotsController],
  providers: [TasksService, DispatchService],
  exports: [TasksService, DispatchService],
})
export class DispatchModule {}
