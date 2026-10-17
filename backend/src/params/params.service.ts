import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { type ParamSubsystem, type RobotParams, type SubsystemValues, withDefaults } from '@oviiai/contracts';
import type { Subscription } from 'rxjs';
import { CommandBus } from '../commands/command-bus.service';
import { AppError } from '../common/errors';
import { KYSELY, type Database } from '../db/database.module';
import { FleetService } from '../fleet/fleet.service';
import { RobotRegistry } from '../fleet/robot-registry';
import { SettingsService } from '../settings/settings.service';
import type { RobotInfo } from '../fleet/types';

/** 送到機器人的結果：已送出、離線（上線時自動補送）、送出失敗 */
export type SyncStatus = 'sent' | 'offline' | 'failed';

/**
 * 機器人參數（T-27、介面規格 /robots/:id/params）。四個子系統存在 robots.params（jsonb）。
 * 儲存後送 set_params（四個子系統的完整值）；離線的機器人在上線時補送，轉接器重啟也會拿到最新參數。
 */
@Injectable()
export class ParamsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Params');
  private sub?: Subscription;

  constructor(
    @Inject(KYSELY) private readonly db: Database,
    private readonly registry: RobotRegistry,
    private readonly fleet: FleetService,
    private readonly bus: CommandBus,
    private readonly settings: SettingsService,
  ) {}

  onModuleInit() {
    this.sub = this.fleet.events$.subscribe((e) => {
      if (e.type !== 'online') return;
      void this.push(e.robot, null).then(
        (s) => s === 'sent' && this.log.log(`${e.robot.code} 上線，補送參數`),
        (err) => this.log.warn(`${e.robot.code} 補送參數失敗：${err instanceof Error ? err.message : err}`),
      );
    });
  }

  onModuleDestroy() {
    this.sub?.unsubscribe();
  }

  /** chargeReturnAt：行走子系統的「回充電量」是全廠設定（派工與充電規則），一併回傳給只有 params 權限的人看 */
  async get(robotId: string) {
    const r = await this.row(robotId);
    const chargeReturnAt = await this.settings.getNumber('charge.returnAt', 25);
    return { robotId: r.id, code: r.code, floorId: r.floor_id, params: withDefaults(r.params), chargeReturnAt };
  }

  /** 儲存一個子系統（值已依 subsystemSchema 驗證）並送到機器人 */
  async save(robotId: string, sub: ParamSubsystem, values: SubsystemValues, userId: string) {
    const r = await this.row(robotId);
    const params = withDefaults(r.params);
    params[sub] = values;
    await this.db.updateTable('robots').set({ params: JSON.stringify(params) }).where('id', '=', robotId).execute();
    const robot = await this.registry.resolveId(robotId);
    const sync: SyncStatus = robot ? await this.push(robot, userId, params) : 'offline';
    return { params, sync };
  }

  /** 把來源機器人已儲存的某個子系統，套用到同樓層全部（啟用中的）機器人 */
  async applyFloor(fromRobotId: string, floorId: string, sub: ParamSubsystem, userId: string) {
    const src = await this.row(fromRobotId);
    if (src.floor_id !== floorId) throw new AppError('VALIDATION_FAILED', `${src.code} 不在這個樓層`, { floorId });
    const values = withDefaults(src.params)[sub];
    const targets = await this.db
      .selectFrom('robots')
      .select(['id', 'code', 'params'])
      .where('floor_id', '=', floorId)
      .where('enabled', '=', true)
      .orderBy('code')
      .execute();
    const saved: { id: string; code: string; params: RobotParams }[] = [];
    await this.db.transaction().execute(async (trx) => {
      for (const t of targets) {
        const params = withDefaults(t.params);
        params[sub] = values;
        await trx.updateTable('robots').set({ params: JSON.stringify(params) }).where('id', '=', t.id).execute();
        saved.push({ id: t.id, code: t.code, params });
      }
    });
    const results: { code: string; sync: SyncStatus }[] = [];
    for (const t of saved) {
      const robot = await this.registry.resolveId(t.id);
      results.push({ code: t.code, sync: robot ? await this.push(robot, userId, t.params) : 'offline' });
    }
    return { updated: saved.length, results };
  }

  /** 送 set_params；離線不送（上線時由 onModuleInit 的訂閱補送） */
  private async push(robot: RobotInfo, userId: string | null, params?: RobotParams): Promise<SyncStatus> {
    if (!this.fleet.get(robot.code)?.online) return 'offline';
    try {
      const p = params ?? withDefaults((await this.row(robot.id)).params);
      await this.bus.send(robot, 'set_params', { params: p }, userId);
      return 'sent';
    } catch (e) {
      this.log.warn(`${robot.code} 送參數失敗：${e instanceof Error ? e.message : e}`);
      return 'failed';
    }
  }

  private async row(robotId: string) {
    const r = await this.db.selectFrom('robots').select(['id', 'code', 'floor_id', 'params']).where('id', '=', robotId).executeTakeFirst();
    if (!r) throw new AppError('NOT_FOUND', '找不到機器人');
    return r;
  }
}
