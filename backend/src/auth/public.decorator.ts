import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'auth:public';
/** 不需登入的端點（登入、refresh、健康檢查）。其餘端點預設都要 access token。 */
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const ALLOW_PENDING_PASSWORD = 'auth:allow-pending-password';
/** 必須先改密碼（管理員建立或重設後）時仍可呼叫的端點：/me、改密碼、登出 */
export const AllowPendingPassword = () => SetMetadata(ALLOW_PENDING_PASSWORD, true);
