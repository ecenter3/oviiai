import { describe, expect, it } from 'vitest';
import { cronOf, inFloor, onceAt, parseTime, pathLength, unavailableReason } from './nav-plan';

describe('巡邏排程 cron', () => {
  it('每日、週一至週五、週末；僅一次沒有 cron', () => {
    expect(cronOf('08:30', 'daily')).toBe('30 8 * * *');
    expect(cronOf('22:05:00', 'weekdays')).toBe('5 22 * * 1-5');
    expect(cronOf('00:00', 'weekends')).toBe('0 0 * * 0,6');
    expect(cronOf('08:30', 'once')).toBeNull();
  });
  it('時間格式檢查', () => {
    expect(() => parseTime('24:00')).toThrow();
    expect(() => parseTime('8:30')).toThrow();
  });
  it('僅一次以台北時間計', () => {
    expect(new Date(onceAt('2026-10-20', '09:15')).toISOString()).toBe('2026-10-20T01:15:00.000Z');
  });
});

describe('路徑', () => {
  it('長度為相鄰航點距離總和', () => {
    expect(pathLength([{ x: 0, y: 0 }, { x: 3, y: 4 }, { x: 3, y: 10 }])).toBe(11);
    expect(pathLength([{ x: 1, y: 1 }])).toBe(0);
  });
  it('航點必須在樓層內', () => {
    expect(inFloor([{ x: 1, y: 1 }, { x: 40, y: 20 }], { w: 40, h: 20 })).toBe(true);
    expect(inFloor([{ x: 41, y: 1 }], { w: 40, h: 20 })).toBe(false);
    expect(inFloor([{ x: 500, y: 1 }], { w: null, h: null })).toBe(true);
    expect(inFloor([{ x: -1, y: 1 }], { w: null, h: null })).toBe(false);
  });
});

describe('指定機器人不能執行的原因', () => {
  const ok = { online: true, state: 'idle', battery: 80, teleopLocked: false };
  it('可以執行', () => expect(unavailableReason(ok, 40)).toBeNull());
  it('離線、急停、遙控、電量不足', () => {
    expect(unavailableReason(null, 40)).toBe('離線');
    expect(unavailableReason({ ...ok, online: false }, 40)).toBe('離線');
    expect(unavailableReason({ ...ok, state: 'estop' }, 40)).toBe('急停中');
    expect(unavailableReason({ ...ok, teleopLocked: true }, 40)).toBe('遙控中');
    expect(unavailableReason({ ...ok, battery: 30 }, 40)).toBe('電量 30% 低於接單門檻 40%');
  });
});
