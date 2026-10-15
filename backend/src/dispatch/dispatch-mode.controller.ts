import { Controller, Get } from '@nestjs/common';
import { RequireAnyPerm } from '../auth/perm.decorator';
import { DispatchService } from './dispatch.service';

/** 審批模式／自動派工（實時監控任務面板的標籤、派工頁的審批狀態） */
@Controller('dispatch')
export class DispatchModeController {
  constructor(private readonly dispatch: DispatchService) {}

  @Get('mode')
  @RequireAnyPerm('dispatch', 'monitor')
  mode() {
    return this.dispatch.mode();
  }
}
