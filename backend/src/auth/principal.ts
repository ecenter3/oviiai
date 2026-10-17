import type { AccessPayload } from './auth.service';

/** req.user：token 內容＋每次請求從資料庫讀的角色與權限（角色改權限即時生效） */
export interface Principal extends AccessPayload {
  displayName: string;
  roleName: string;
  isSystem: boolean;
  perms: string[];
  /** 管理員建立或重設密碼後、使用者還沒改密碼 */
  mustChangePassword?: boolean;
}
