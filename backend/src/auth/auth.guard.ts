import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService, TokenExpiredError } from '@nestjs/jwt';
import type { Request } from 'express';
import { AppError } from '../common/errors';
import { AuthRepository } from './auth.repository';
import type { AccessPayload } from './auth.service';
import { PERMS, satisfies, type PermRequirement } from './perm.decorator';
import type { Principal } from './principal';
import { IS_PUBLIC } from './public.decorator';

/**
 * 全域 Guard：驗 Bearer access token → 從資料庫讀使用者目前的角色與權限 → 檢查 @RequirePerm。
 * 權限不放在 token 裡，所以停用帳號、改角色、改角色權限都在下一個請求生效。
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
    private readonly repo: AuthRepository,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = ctx.switchToHttp().getRequest<Request & { user?: Principal }>();
    const [scheme, token] = (req.headers.authorization ?? '').split(' ');
    if (scheme !== 'Bearer' || !token) throw new AppError('UNAUTHENTICATED', '未登入');

    let payload: AccessPayload;
    try {
      payload = await this.jwt.verifyAsync<AccessPayload>(token);
    } catch (e) {
      // 前端收到 TOKEN_EXPIRED 就呼叫 /auth/refresh 後重送
      if (e instanceof TokenExpiredError) throw new AppError('TOKEN_EXPIRED', '登入已過期');
      throw new AppError('UNAUTHENTICATED', '未登入');
    }

    const user = await this.repo.findById(payload.sub);
    if (!user || !user.enabled) throw new AppError('UNAUTHENTICATED', '帳號已停用或不存在');
    req.user = {
      sub: user.id,
      username: user.username,
      rid: user.roleId,
      displayName: user.displayName,
      roleName: user.roleName,
      perms: user.perms,
    };

    const need = this.reflector.getAllAndOverride<PermRequirement | undefined>(PERMS, targets);
    if (need && !satisfies(user.perms, need)) {
      throw new AppError('FORBIDDEN', '沒有權限執行此操作', { required: need.codes, mode: need.mode });
    }
    return true;
  }
}
