/**
 * 建立初始系統管理員帳號（T-03）。角色、樓層、設定由 migration 建立。
 * 用法：npm run seed（讀 .env 的 ADMIN_USERNAME、ADMIN_PASSWORD）
 * 帳號已存在時不做任何變更，可重複執行。
 */
import { createDatabase } from '../db/database.module';
import { hashPassword, PasswordPolicy } from '../auth/password';
import { loadEnv } from '../config';

async function main() {
  loadEnv();
  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD ?? '';
  const pw = PasswordPolicy.safeParse(password);
  if (!pw.success) {
    throw new Error(`ADMIN_PASSWORD 不符密碼規則：${pw.error.issues.map((i) => i.message).join('、')}`);
  }

  const db = createDatabase();
  try {
    const role = await db.selectFrom('roles').select('id').where('name', '=', '系統管理員').executeTakeFirst();
    if (!role) throw new Error('找不到「系統管理員」角色，請先執行 make migrate');

    const r = await db
      .insertInto('users')
      .values({
        username,
        display_name: '系統管理員',
        password_hash: await hashPassword(password),
        role_id: role.id,
      })
      .onConflict((oc) => oc.column('username').doNothing())
      .returning('id')
      .executeTakeFirst();
    console.log(r ? `已建立系統管理員帳號 ${username}` : `帳號 ${username} 已存在，未變更`);
  } finally {
    await db.destroy();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
