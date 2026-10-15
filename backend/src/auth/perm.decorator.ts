import { SetMetadata } from '@nestjs/common';
import type { PermCode } from './perms';

export const PERMS = 'auth:perms';
export const AUTHENTICATED = 'auth:authenticated';

export interface PermRequirement {
  mode: 'all' | 'any';
  codes: PermCode[];
}

/** 需同時具備全部權限碼，例：@RequirePerm('settings', 'op.config') */
export const RequirePerm = (...codes: [PermCode, ...PermCode[]]) =>
  SetMetadata(PERMS, { mode: 'all', codes } satisfies PermRequirement);

/** 具備任一權限碼即可，例：@RequireAnyPerm('sysalarm', 'bizalarm') */
export const RequireAnyPerm = (...codes: [PermCode, ...PermCode[]]) =>
  SetMetadata(PERMS, { mode: 'any', codes } satisfies PermRequirement);

/** 只需登入、不需特定權限（介面規格權限欄寫「登入」的端點）。每個端點必須標 @Public、@Authenticated 或 @RequirePerm 之一。 */
export const Authenticated = () => SetMetadata(AUTHENTICATED, true);

export function satisfies(perms: readonly string[], req: PermRequirement): boolean {
  return req.mode === 'all' ? req.codes.every((c) => perms.includes(c)) : req.codes.some((c) => perms.includes(c));
}
