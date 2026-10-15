import { Module } from '@nestjs/common';
import { CommandsModule } from '../commands/commands.module';
import { FleetModule } from '../fleet/fleet.module';
import { DispatchModeController } from './dispatch-mode.controller';
import { DispatchService } from './dispatch.service';
import { RobotsController } from './robots.controller';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';

@Module({
  imports: [FleetModule, CommandsModule],
  controllers: [TasksController, RobotsController, DispatchModeController],
  providers: [TasksService, DispatchService],
  exports: [TasksService, DispatchService],
})
export class DispatchModule {}
