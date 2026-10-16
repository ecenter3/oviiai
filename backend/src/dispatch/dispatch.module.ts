import { Module } from '@nestjs/common';
import { CommandsModule } from '../commands/commands.module';
import { FleetModule } from '../fleet/fleet.module';
import { OpLogModule } from '../oplog/oplog.module';
import { DispatchModeController } from './dispatch-mode.controller';
import { DispatchService } from './dispatch.service';
import { RobotsController } from './robots.controller';
import { RulesController } from './rules.controller';
import { TemplatesController } from './templates.controller';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';

@Module({
  imports: [FleetModule, CommandsModule, OpLogModule],
  controllers: [TasksController, RobotsController, DispatchModeController, RulesController, TemplatesController],
  providers: [TasksService, DispatchService],
  exports: [TasksService, DispatchService],
})
export class DispatchModule {}
