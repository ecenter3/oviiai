import { Body, Controller, HttpCode, Inject, Post, Put, Req, Res } from '@nestjs/common';
import type { CookieOptions, Request, Response } from 'express';
import { z } from 'zod';
import type { AuthConfig } from '../config';
import { ZodPipe } from '../common/zod.pipe';
import { AUTH_CONFIG, AuthService, type AccessPayload } from './auth.service';
import { CurrentUser } from './current-user.decorator';
import { PasswordPolicy } from './password';
import { Authenticated } from './perm.decorator';
import { AllowPendingPassword, Public } from './public.decorator';
import { REFRESH_COOKIE, REFRESH_COOKIE_PATH } from './refresh-token';

const LoginBody = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(128),
});

const ChangePasswordBody = z.object({
  oldPassword: z.string().min(1).max(128),
  newPassword: PasswordPolicy,
});

@Controller('auth')
export class AuthController {
  private readonly cookie: CookieOptions;

  constructor(
    private readonly auth: AuthService,
    @Inject(AUTH_CONFIG) cfg: AuthConfig,
  ) {
    this.cookie = { httpOnly: true, secure: cfg.cookieSecure, sameSite: 'strict', path: REFRESH_COOKIE_PATH };
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(
    @Body(new ZodPipe(LoginBody)) body: z.infer<typeof LoginBody>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const r = await this.auth.login(body.username, body.password, req.ip ?? null);
    res.cookie(REFRESH_COOKIE, r.refreshToken, { ...this.cookie, expires: r.refreshExpiresAt });
    return { accessToken: r.accessToken, user: r.user, perms: r.perms, mustChangePassword: r.mustChangePassword };
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    try {
      const r = await this.auth.refresh(req.cookies?.[REFRESH_COOKIE]);
      res.cookie(REFRESH_COOKIE, r.refreshToken, { ...this.cookie, expires: r.refreshExpiresAt });
      return { accessToken: r.accessToken };
    } catch (e) {
      res.clearCookie(REFRESH_COOKIE, this.cookie);
      throw e;
    }
  }

  @Authenticated()
  @AllowPendingPassword()
  @Post('logout')
  @HttpCode(204)
  async logout(@CurrentUser() user: AccessPayload, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(user, req.cookies?.[REFRESH_COOKIE], req.ip ?? null);
    res.clearCookie(REFRESH_COOKIE, this.cookie);
  }

  @Authenticated()
  @AllowPendingPassword()
  @Put('password')
  @HttpCode(204)
  async changePassword(
    @CurrentUser() user: AccessPayload,
    @Body(new ZodPipe(ChangePasswordBody)) body: z.infer<typeof ChangePasswordBody>,
    @Req() req: Request,
  ) {
    await this.auth.changePassword(user, body.oldPassword, body.newPassword, req.cookies?.[REFRESH_COOKIE], req.ip ?? null);
  }
}
