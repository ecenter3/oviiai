import { Module } from '@nestjs/common';
import { DailyStatsService } from './daily-stats.service';
import { StatsController } from './stats.controller';
import { StatsService } from './stats.service';

@Module({ controllers: [StatsController], providers: [StatsService, DailyStatsService], exports: [DailyStatsService] })
export class StatsModule {}
