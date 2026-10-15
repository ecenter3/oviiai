import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'auth:public';
/** 不需登入的端點（登入、refresh、健康檢查）。其餘端點預設都要 access token。 */
export const Public = () => SetMetadata(IS_PUBLIC, true);
