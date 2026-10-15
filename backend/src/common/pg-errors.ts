/** PostgreSQL 錯誤碼 */
export const PG_UNIQUE_VIOLATION = '23505';
export const PG_FK_VIOLATION = '23503';

export function pgCode(e: unknown): string | undefined {
  return typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : undefined;
}
