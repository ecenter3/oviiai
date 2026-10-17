import { Controller, Get } from '@nestjs/common';
import { SettingsService } from '../settings/settings.service';
import { CurrentUser } from './current-user.decorator';
import { Authenticated } from './perm.decorator';
import type { Principal } from './principal';
import { AllowPendingPassword } from './public.decorator';

@Controller('me')
export class MeController {
  constructor(private readonly settings: SettingsService) {}

  /** 目前使用者與權限碼（Guard 每次請求從資料庫讀）；前端據此隱藏選單與按鈕，權限仍以後端檢查為準 */
  @Authenticated()
  @AllowPendingPassword()
  @Get()
  async me(@CurrentUser() p: Principal) {
    return {
      user: { id: p.sub, username: p.username, displayName: p.displayName, role: { id: p.rid, name: p.roleName } },
      perms: p.perms,
      mustChangePassword: p.mustChangePassword,
      idleMinutes: await this.settings.idleMinutes(),
    };
  }
}
