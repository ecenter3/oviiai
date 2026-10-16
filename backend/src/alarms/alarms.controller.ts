import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequireAnyPerm, RequirePerm } from '../auth/perm.decorator';
import type { Principal } from '../auth/principal';
import { AppError } from '../common/errors';
import { PageQuery } from '../common/pagination';
import { ZodPipe } from '../common/zod.pipe';
import { KYSELY, type Database } from '../db/database.module';
import { OpLog } from '../oplog/oplog.decorator';
import { ALARM_STATUSES } from './alarm-state';
import { type AlarmCategory, AlarmsService } from './alarms.service';

const csvList = <T extends z.ZodTypeAny>(item: T) =>
  z
    .string()
    .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean))
    .pipe(z.array(item))
    .optional();

const AlarmQuery = PageQuery.extend({
  category: z.enum(['system', 'business']).optional(),
  level: csvList(z.coerce.number().int().min(1).max(3)),
  type: csvList(z.string().regex(/^[a-z0-9_]{1,32}$/)),
  status: csvList(z.enum(ALARM_STATUSES)),
  floor: z.string().regex(/^[a-z0-9]{1,8}$/).optional(),
  robot: z.string().uuid().optional(),
  from: z.string().datetime({ offset: true }).transform((s) => new Date(s)).optional(),
  to: z.string().datetime({ offset: true }).transform((s) => new Date(s)).optional(),
  q: z.string().trim().min(1).max(64).optional(),
  format: z.enum(['json', 'csv']).default('json'),
});

const TransitionBody = z.object({
  to: z.enum(ALARM_STATUSES),
  note: z.string().trim().max(500).nullable().optional(),
});
const NoteBody = z.object({ note: z.string().trim().max(500).nullable().optional() }).default({});

const RuleBody = z.object({
  type: z.string().regex(/^[a-z0-9_]{1,32}$/),
  level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  popup: z.boolean(),
  sound: z.boolean(),
  needHandle: z.boolean(),
  smsUserIds: z.array(z.string().uuid()).max(50),
  dedupSec: z.number().int().min(0).max(3600),
});
const PutRules = z.object({ rules: z.array(RuleBody).min(1).max(100) });

/** 操作日誌動作：alarm.handling、alarm.closed…（body 不合法時記 alarm.transition） */
const transitionAction = (to: unknown) => `alarm.${(ALARM_STATUSES as readonly unknown[]).includes(to) ? String(to) : 'transition'}`;

const alarmTarget = (id: unknown) => (id ? `alarm:${id}` : null);

/**
 * 看得到哪些類別：系統告警頁 sysalarm、業務告警頁 bizalarm；
 * 實時監控頁的告警快訊兩類都要顯示，monitor 也可讀（與 GET /tasks 放寬給 monitor 相同）。
 */
export function visibleCategories(perms: readonly string[]): AlarmCategory[] {
  const out: AlarmCategory[] = [];
  if (perms.includes('sysalarm') || perms.includes('monitor')) out.push('system');
  if (perms.includes('bizalarm') || perms.includes('monitor')) out.push('business');
  return out;
}

@Controller('alarms')
export class AlarmsController {
  constructor(
    private readonly alarms: AlarmsService,
    @Inject(KYSELY) private readonly db: Database,
  ) {}

  /** 告警頁篩選欄的選項：機器人（只看告警的帳號沒有 robots 權限，不能用 GET /robots）、告警項目 */
  @Get('options')
  @RequireAnyPerm('sysalarm', 'bizalarm', 'monitor')
  async options(@CurrentUser() user: Principal) {
    const robots = await this.db.selectFrom('robots').select(['id', 'code', 'floor_id']).orderBy('floor_id').orderBy('code').execute();
    const visible = visibleCategories(user.perms);
    return {
      robots: robots.map((r) => ({ id: r.id, code: r.code, floorId: r.floor_id })),
      types: (await this.alarms.rules()).filter((r) => visible.includes(r.category)).map((r) => ({ type: r.type, name: r.name, category: r.category })),
    };
  }

  /** `?category&level&type&status&floor&robot&from&to&q&page&size`；`?format=csv` 匯出符合條件的全部紀錄 */
  @Get()
  @RequireAnyPerm('sysalarm', 'bizalarm', 'monitor')
  async list(@Query(new ZodPipe(AlarmQuery)) q: z.infer<typeof AlarmQuery>, @CurrentUser() user: Principal, @Res() res: Response) {
    const visible = visibleCategories(user.perms);
    const categories = q.category ? visible.filter((c) => c === q.category) : visible;
    const filter = { categories, level: q.level, type: q.type, status: q.status, floor: q.floor, robot: q.robot, from: q.from, to: q.to, q: q.q };
    if (q.format === 'csv') {
      await this.alarms.exportCsv(filter, res);
      return;
    }
    res.json(await this.alarms.list(filter, q.page, q.size));
  }

  @Get(':id')
  @RequireAnyPerm('sysalarm', 'bizalarm', 'monitor')
  async get(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: Principal) {
    const a = await this.visible(id, user);
    return { ...a, events: await this.alarms.events(id) };
  }

  /** 狀態轉換 `{to, note}`；不合法回 409 */
  @Post(':id/transition')
  @HttpCode(200)
  @RequirePerm('op.alarm')
  @OpLog((req) => transitionAction((req.body as { to?: unknown } | undefined)?.to), (req) => alarmTarget(req.params.id))
  async transition(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(TransitionBody)) body: z.infer<typeof TransitionBody>,
    @CurrentUser() user: Principal,
  ) {
    await this.visible(id, user);
    return this.alarms.transition(id, body.to, body.note ?? null, { id: user.sub, name: user.displayName });
  }

  /** 回報上位系統（未處理的先轉處理中） */
  @Post(':id/report')
  @HttpCode(200)
  @RequirePerm('op.alarm')
  @OpLog('alarm.report', (req) => alarmTarget(req.params.id))
  async report(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(NoteBody)) body: z.infer<typeof NoteBody>, @CurrentUser() user: Principal) {
    await this.visible(id, user);
    return this.alarms.report(id, body.note ?? null, { id: user.sub, name: user.displayName });
  }

  /** 派最近機器人到告警位置 */
  @Post(':id/dispatch')
  @RequirePerm('op.dispatch')
  @OpLog('alarm.dispatch', (req) => alarmTarget(req.params.id))
  async dispatch(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: Principal) {
    await this.visible(id, user);
    return this.alarms.dispatch(id, { id: user.sub, username: user.username, name: user.displayName });
  }

  private async visible(id: string, user: Principal) {
    const a = await this.alarms.get(id);
    if (!visibleCategories(user.perms).includes(a.category)) throw new AppError('NOT_FOUND', '告警不存在');
    return a;
  }
}

/** 告警設置（介面規格 GET/PUT /alarm-rules，權限 alarmset） */
@Controller('alarm-rules')
export class AlarmRulesController {
  constructor(
    private readonly alarms: AlarmsService,
    @Inject(KYSELY) private readonly db: Database,
  ) {}

  /** 告警項目設定＋可選的簡訊接收人（穿梭框左欄） */
  @Get()
  @RequirePerm('alarmset')
  async get() {
    const users = await this.db
      .selectFrom('users')
      .select(['id', 'username', 'display_name', 'phone'])
      .where('enabled', '=', true)
      .orderBy('username')
      .execute();
    return {
      rules: await this.alarms.rules(),
      users: users.map((u) => ({ id: u.id, username: u.username, displayName: u.display_name, hasPhone: !!u.phone })),
    };
  }

  @Put()
  @RequirePerm('alarmset')
  @OpLog('alarm.rules', () => 'alarm-rules')
  async put(@Body(new ZodPipe(PutRules)) body: z.infer<typeof PutRules>) {
    return { rules: await this.alarms.updateRules(body.rules) };
  }
}
