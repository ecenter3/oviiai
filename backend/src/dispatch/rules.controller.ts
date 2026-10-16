import { Body, Controller, Get, Inject, Put } from '@nestjs/common';
import { sql } from 'kysely';
import { z } from 'zod';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequirePerm } from '../auth/perm.decorator';
import type { Principal } from '../auth/principal';
import { AppError } from '../common/errors';
import { ZodPipe } from '../common/zod.pipe';
import { KYSELY, type Database } from '../db/database.module';
import { OpLog } from '../oplog/oplog.decorator';
import { SettingsService } from '../settings/settings.service';
import { DispatchService } from './dispatch.service';
import { CHARGE_MODE, ChargeModeValue, checkOrder, RULE_KEYS, RULES, type RuleKey } from './rules';

const PutBody = z.object({ values: z.record(z.unknown()) });

/**
 * GET/PUT /settings（介面規格：讀取 settings、修改 op.config）。
 * 儲存後立即生效（設定快取失效）；關閉審批時待審批任務立即轉入佇列，回傳筆數。
 */
@Controller('settings')
export class RulesController {
  constructor(
    @Inject(KYSELY) private readonly db: Database,
    private readonly settings: SettingsService,
    private readonly dispatch: DispatchService,
  ) {}

  @Get()
  @RequirePerm('settings')
  async get() {
    return { values: await this.values(), defaults: this.defaults(), brands: await this.brands() };
  }

  @Put()
  @RequirePerm('settings', 'op.config')
  @OpLog('settings.update', () => 'settings')
  async put(@Body(new ZodPipe(PutBody)) body: z.infer<typeof PutBody>, @CurrentUser() actor: Principal) {
    const brands = await this.brands();
    const updates: [string, unknown][] = [];
    const fields: Record<string, string> = {};
    for (const [key, raw] of Object.entries(body.values)) {
      const m = CHARGE_MODE.exec(key);
      if (m) {
        if (!brands.includes(m[1])) fields[key] = '沒有這個品牌的機器人';
        else if (!ChargeModeValue.safeParse(raw).success) fields[key] = '只能是 auto 或 manual';
        else updates.push([key, raw]);
        continue;
      }
      if (!(RULE_KEYS as string[]).includes(key)) {
        fields[key] = '不可修改的設定';
        continue;
      }
      const r = RULES[key as RuleKey].schema.safeParse(raw);
      if (!r.success) fields[key] = r.error.issues[0]?.message ?? '格式錯誤';
      else updates.push([key, r.data]);
    }
    if (Object.keys(fields).length) throw new AppError('VALIDATION_FAILED', '設定值不合法', { fields });

    const merged = { ...(await this.values()), ...Object.fromEntries(updates) } as Record<string, number>;
    const order = checkOrder({ returnAt: merged['charge.returnAt'], minAccept: merged['charge.minAccept'], resumeAt: merged['charge.resumeAt'] });
    if (order) throw new AppError('VALIDATION_FAILED', order, { fields: { 'charge.minAccept': order } });

    for (const [key, value] of updates) {
      await this.db
        .insertInto('settings')
        .values({ key, value: JSON.stringify(value), updated_by: actor.sub })
        .onConflict((oc) => oc.column('key').doUpdateSet({ value: JSON.stringify(value), updated_by: actor.sub, updated_at: sql`now()` }))
        .execute();
    }
    this.settings.invalidate();
    // 關閉審批（或把期限改到過去）：待審批任務立即轉入佇列
    const released = await this.dispatch.closeApprovalIfExpired();
    return { values: await this.values(), released };
  }

  private defaults() {
    return Object.fromEntries(RULE_KEYS.map((k) => [k, RULES[k].default]));
  }

  private async values(): Promise<Record<string, unknown>> {
    const rows = await this.db.selectFrom('settings').select(['key', 'value']).execute();
    const out: Record<string, unknown> = this.defaults();
    for (const r of rows) if ((RULE_KEYS as string[]).includes(r.key) || CHARGE_MODE.test(r.key)) out[r.key] = r.value;
    for (const b of await this.brands()) out[`charge.mode.${b}`] ??= 'auto';
    return out;
  }

  /** 已登記機器人的品牌（資料值），充電模式依此列出 */
  private async brands(): Promise<string[]> {
    const rows = await this.db.selectFrom('robots').select('brand').distinct().orderBy('brand').execute();
    return rows.map((r) => r.brand);
  }
}
