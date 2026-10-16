import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { RequirePerm } from '../auth/perm.decorator';
import { AppError } from '../common/errors';
import { ZodPipe } from '../common/zod.pipe';
import { KYSELY, type Database } from '../db/database.module';
import { OpLog } from '../oplog/oplog.decorator';
import { PRIORITIES } from './task-state';

const Target = z.union([
  z.object({ poiId: z.string().uuid() }).strict(),
  z.object({ pathId: z.string().uuid() }).strict(),
  z.object({ x: z.number().finite(), y: z.number().finite() }).strict(),
]);
const TemplateBody = z.object({
  name: z.string().trim().min(1).max(32),
  kind: z.string().trim().min(1).max(32),
  priority: z.enum(PRIORITIES),
  floorId: z.string().regex(/^[a-z0-9]{1,8}$/).nullable().optional(),
  target: Target.nullable().optional(),
});

/** 任務範本（介面規格：CRUD /task-templates，dispatch）。派工頁點範本帶入建單表單 */
@Controller('task-templates')
@RequirePerm('dispatch')
export class TemplatesController {
  constructor(@Inject(KYSELY) private readonly db: Database) {}

  @Get()
  async list() {
    const rows = await this.db.selectFrom('task_templates').selectAll().orderBy('name').execute();
    return rows.map(view);
  }

  @Post()
  @OpLog('task_template.create', (_req, res) => `task_template:${(res as { id?: string } | undefined)?.id}`)
  async create(@Body(new ZodPipe(TemplateBody)) b: z.infer<typeof TemplateBody>) {
    const r = await this.db
      .insertInto('task_templates')
      .values({ name: b.name, kind: b.kind, priority: b.priority, floor_id: b.floorId ?? null, target: b.target ? JSON.stringify(b.target) : null })
      .returningAll()
      .executeTakeFirstOrThrow();
    return view(r);
  }

  @Patch(':id')
  @OpLog('task_template.update', (req) => `task_template:${req.params.id}`)
  async update(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(TemplateBody.partial())) b: Partial<z.infer<typeof TemplateBody>>) {
    const r = await this.db
      .updateTable('task_templates')
      .set({
        ...(b.name !== undefined && { name: b.name }),
        ...(b.kind !== undefined && { kind: b.kind }),
        ...(b.priority !== undefined && { priority: b.priority }),
        ...(b.floorId !== undefined && { floor_id: b.floorId }),
        ...(b.target !== undefined && { target: b.target ? JSON.stringify(b.target) : null }),
      })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
    if (!r) throw new AppError('NOT_FOUND', '找不到範本');
    return view(r);
  }

  @Delete(':id')
  @HttpCode(204)
  @OpLog('task_template.delete', (req) => `task_template:${req.params.id}`)
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    const r = await this.db.deleteFrom('task_templates').where('id', '=', id).executeTakeFirst();
    if (!r.numDeletedRows) throw new AppError('NOT_FOUND', '找不到範本');
  }
}

function view(r: { id: string; name: string; kind: string; priority: string; floor_id: string | null; target: unknown }) {
  return { id: r.id, name: r.name, kind: r.kind, priority: r.priority, floorId: r.floor_id, target: r.target ?? null };
}
