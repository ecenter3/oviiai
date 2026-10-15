import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService, TokenExpiredError } from '@nestjs/jwt';
import type { Request } from 'express';
import { AppError } from '../common/errors';
import type { AccessPayload } from './auth.service';
import { IS_PUBLIC } from './public.decorator';

/** 全域 Guard：驗 Bearer access token，放進 req.user。權限碼檢查（@RequirePerm）在 T-05。 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()])) return true;

    const req = ctx.switchToHttp().getRequest<Request & { user?: AccessPayload }>();
    const [scheme, token] = (req.headers.authorization ?? '').split(' ');
    if (scheme !== 'Bearer' || !token) throw new AppError('UNAUTHENTICATED', '未登入');

    try {
      req.user = await this.jwt.verifyAsync<AccessPayload>(token);
    } catch (e) {
      // 前端收到 TOKEN_EXPIRED 就呼叫 /auth/refresh 後重送
      if (e instanceof TokenExpiredError) throw new AppError('TOKEN_EXPIRED', '登入已過期');
      throw new AppError('UNAUTHENTICATED', '未登入');
    }
    return true;
  }
}
