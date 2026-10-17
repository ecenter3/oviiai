import { describe, expect, it } from 'vitest';
import { PARAM_SCHEMA, PARAM_SUBSYSTEMS, isParamField, paramDefaults, subsystemSchema, withDefaults } from '../src';

describe('機器人參數（T-27）', () => {
  it('每個子系統的預設值都通過驗證；欄位名稱不重複', () => {
    for (const sub of PARAM_SUBSYSTEMS) {
      expect(subsystemSchema(sub).safeParse(paramDefaults(sub)).success).toBe(true);
      const keys = PARAM_SCHEMA[sub].filter(isParamField).map((f) => f.k);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it('驗證：範圍、選項、時間格式、未知欄位', () => {
    const walk = subsystemSchema('walk');
    const ok = paramDefaults('walk');
    expect(walk.safeParse({ ...ok, speed: 1.6 }).success).toBe(false);
    expect(walk.safeParse({ ...ok, collide: '安全模式' }).success).toBe(false);
    expect(walk.safeParse({ ...ok, strobeTime: ['25:00', '06:00'] }).success).toBe(false);
    expect(walk.safeParse({ ...ok, extra: 1 }).success).toBe(false);
    const { speed: _drop, ...missing } = ok;
    expect(walk.safeParse(missing).success).toBe(false);
    const ext = subsystemSchema('ext');
    expect(ext.safeParse({ ...paramDefaults('ext'), reBlack: ['explode', true] }).success).toBe(false);
    expect(subsystemSchema('video').safeParse({ ...paramDefaults('video'), face: ['front', 'front'] }).success).toBe(false);
  });

  it('withDefaults：補預設、不合法的欄位回預設、丟掉未知欄位與子系統', () => {
    const p = withDefaults({ walk: { speed: 1.2, collide: 'bogus', gone: true }, junk: {} });
    expect(p.walk.speed).toBe(1.2);
    expect(p.walk.collide).toBe('normal');
    expect('gone' in p.walk).toBe(false);
    expect(Object.keys(p)).toEqual([...PARAM_SUBSYSTEMS]);
    expect(withDefaults(null).talk).toEqual(paramDefaults('talk'));
    // 預設陣列不共用參照
    withDefaults({}).video.face && (withDefaults({}).video.face as string[]).push('rear');
    expect(paramDefaults('video').face).toEqual(['front']);
  });
});
