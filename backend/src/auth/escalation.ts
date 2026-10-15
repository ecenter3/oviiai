import { AppError } from '../common/errors';
import type { Principal } from './principal';

/**
 * 防止權限提升：只能授予、指派、管理「權限不超過自己」的角色。
 * 系統管理員擁有全部權限，不受限制；持有 users／roles 權限的其他角色無法把自己或別人升級，
 * 也無法重設、停用權限比自己高的帳號（例如重設系統管理員密碼後冒用）。
 */
export function assertWithinOwnPerms(actor: Pick<Principal, 'perms'>, perms: readonly string[], what: string): void {
  const missing = perms.filter((p) => !actor.perms.includes(p));
  if (missing.length) {
    throw new AppError('FORBIDDEN', `${what}超出你自己的權限`, { missing });
  }
}
