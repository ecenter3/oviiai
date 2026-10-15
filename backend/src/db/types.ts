import type { ColumnType, Generated } from 'kysely';

// 對應 db/migrations。只列後端已用到的表，模組加入時再補。
type Timestamp = ColumnType<Date, Date | string, Date | string>;

export interface RolesTable {
  id: Generated<string>;
  name: string;
  description: string | null;
  perms: ColumnType<string[], string[] | undefined, string[]>;
  is_system: ColumnType<boolean, boolean | undefined, boolean>;
  created_at: ColumnType<Date, never, never>;
}

export interface UsersTable {
  id: Generated<string>;
  username: string;
  display_name: string;
  password_hash: string;
  role_id: string;
  phone: string | null;
  email: string | null;
  enabled: ColumnType<boolean, boolean | undefined, boolean>;
  failed_logins: ColumnType<number, number | undefined, number>;
  locked_until: Timestamp | null;
  last_login_at: Timestamp | null;
  created_at: ColumnType<Date, never, never>;
}

export interface RefreshTokensTable {
  id: Generated<string>;
  user_id: string;
  token_hash: string;
  expires_at: Timestamp;
  revoked_at: Timestamp | null;
}

export interface OpLogsTable {
  id: Generated<string>;
  at: ColumnType<Date, never, never>;
  user_id: string | null;
  username: string;
  action: string;
  target: string | null;
  detail: unknown;
  ip: string | null;
}

export interface SettingsTable {
  key: string;
  value: unknown;
  updated_by: string | null;
  updated_at: ColumnType<Date, never, Date | string>;
}

export interface DB {
  roles: RolesTable;
  users: UsersTable;
  refresh_tokens: RefreshTokensTable;
  op_logs: OpLogsTable;
  settings: SettingsTable;
}
