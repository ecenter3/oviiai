import { Module } from '@nestjs/common';
import { FleetModule } from '../fleet/fleet.module';
import { CommandBus } from './command-bus.service';
import { CommandsController } from './commands.controller';
import { CommandsService } from './commands.service';
import { TeleopLock } from './teleop-lock.service';

@Module({
  imports: [FleetModule],
  controllers: [CommandsController],
  providers: [CommandBus, TeleopLock, CommandsService],
  exports: [CommandBus, TeleopLock, CommandsService],
})
export class CommandsModule {}
