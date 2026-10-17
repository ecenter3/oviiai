import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { dataEncKey } from '../config';
import { KYSELY, type Database } from '../db/database.module';
import { RULE_KEYS } from '../dispatch/rules';

export type StepKey = 'floors' | 'plans' | 'robots' | 'chargers' | 'cameras' | 'calibration' | 'rules';
export interface Step {
  key: StepKey;
  done: boolean;
  /** 尚未完成的項目（顯示在精靈上，例：「1F 辦公室：沒有平面圖」） */
  missing: string[];
}

/** 系統規格書「新場域設定精靈」：樓層 → 平面圖 → 機器人 → 充電樁 → 攝影機 → 座標校正 → 規則 */
export const STEPS: StepKey[] = ['floors', 'plans', 'robots', 'chargers', 'cameras', 'calibration', 'rules'];

/**
 * 設定精靈用的完成狀態（介面規格 GET /site/setup-status；T-46）。每次即時查資料庫，不另外存「已完成」旗標：
 * 管理頁或匯入改了資料，精靈的勾選就跟著變。
 */
@Injectable()
export class SetupStatusService {
  constructor(@Inject(KYSELY) private readonly db: Database) {}

  async status(): Promise<{ blank: boolean; done: number; total: number; steps: Step[] }> {
    const db = this.db;
    const floors = await db.selectFrom('floors').select(['id', 'name', 'plan_key', 'width_m', 'height_m']).orderBy('sort').execute();
    const robots = await db.selectFrom('robots').select(['id', 'code', 'floor_id']).where('enabled', '=', true).orderBy('code').execute();
    const chargers = await db.selectFrom('chargers').select(['floor_id']).where('enabled', '=', true).execute();
    const cameras = await db
      .selectFrom('cameras')
      .select(['code'])
      .select(sql<boolean>`octet_length(rtsp_url) > 0 AND pgp_sym_decrypt(rtsp_url, ${dataEncKey()}) <> ''`.as('has_rtsp'))
      .where('enabled', '=', true)
      .orderBy('code')
      .execute();
    const calibrated = new Set((await db.selectFrom('robot_map_calib').select('robot_id').execute()).map((r) => r.robot_id));
    const rulesSaved = await db.selectFrom('settings').select('key').where('key', 'in', RULE_KEYS).where('updated_by', 'is not', null).limit(1).executeTakeFirst();
    const floorName = new Map(floors.map((f) => [f.id, f.name]));
    const robotFloors = [...new Set(robots.map((r) => r.floor_id))];
    const chargerFloors = new Set(chargers.map((c) => c.floor_id));

    const steps: Step[] = [
      { key: 'floors', done: floors.length > 0, missing: floors.length ? [] : ['還沒有樓層'] },
      {
        key: 'plans',
        done: floors.length > 0 && floors.every((f) => f.plan_key && f.width_m && f.height_m),
        missing: floors.flatMap((f) => [...(f.plan_key ? [] : [`${f.name}：沒有平面圖`]), ...(f.width_m && f.height_m ? [] : [`${f.name}：沒有設定實際尺寸`])]),
      },
      { key: 'robots', done: robots.length > 0, missing: robots.length ? [] : ['還沒有機器人'] },
      {
        key: 'chargers',
        done: robotFloors.length > 0 && robotFloors.every((f) => chargerFloors.has(f)),
        missing: robotFloors.length ? robotFloors.filter((f) => !chargerFloors.has(f)).map((f) => `${floorName.get(f) ?? f}：有機器人但沒有充電樁`) : ['先新增機器人'],
      },
      {
        key: 'cameras',
        done: cameras.length > 0 && cameras.every((c) => c.has_rtsp),
        missing: cameras.length ? cameras.filter((c) => !c.has_rtsp).map((c) => `${c.code}：沒有 RTSP 位址（匯入的攝影機要重新輸入帳密）`) : ['還沒有攝影機'],
      },
      {
        key: 'calibration',
        done: robots.length > 0 && robots.every((r) => calibrated.has(r.id)),
        missing: robots.length ? robots.filter((r) => !calibrated.has(r.id)).map((r) => `${r.code}：還沒做座標校正`) : ['先新增機器人'],
      },
      { key: 'rules', done: !!rulesSaved, missing: rulesSaved ? [] : ['確認派工與充電規則後按「儲存」'] },
    ];
    // 每一步最多列 20 項，避免 100 支攝影機都沒帳密時清單太長
    for (const s of steps) if (s.missing.length > 20) s.missing = [...s.missing.slice(0, 20), `…還有 ${s.missing.length - 20} 項`];
    return { blank: robots.length === 0 && cameras.length === 0, done: steps.filter((s) => s.done).length, total: steps.length, steps };
  }
}
