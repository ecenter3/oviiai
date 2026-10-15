import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { AccessPayload } from './auth.service';

export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AccessPayload => ctx.switchToHttp().getRequest().user,
);
