import { PipeTransform } from '@nestjs/common';
import type { ZodType, ZodTypeDef } from 'zod';
import { AppError } from './errors';

/** `@Body(new ZodPipe(schema))`、`@Query(new ZodPipe(schema))`：驗證失敗回 400 VALIDATION_FAILED，details 列出欄位 */
export class ZodPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T, ZodTypeDef, unknown>) {}

  transform(value: unknown): T {
    const r = this.schema.safeParse(value);
    if (r.success) return r.data;
    const fields: Record<string, string> = {};
    for (const issue of r.error.issues) fields[issue.path.join('.') || '_'] = issue.message;
    throw new AppError('VALIDATION_FAILED', '欄位不合法', { fields });
  }
}
