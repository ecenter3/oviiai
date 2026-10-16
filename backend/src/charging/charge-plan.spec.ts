import { describe, expect, it } from 'vitest';
import { type ChargerInfo, manualDone, needsCharge, pickCharger, queueOrder, type RobotChargeView, shouldYield, waitPoint } from './charge-plan';

const S = { returnAt: 25, resumeAt: 90 };
const robot = (over: Partial<RobotChargeView> = {}): RobotChargeView => ({
  robotId: 'r1',
  code: 'ANBOT-001',
  floor: 'b1',
  brand: 'anbot',
  online: true,
  state: 'idle',
  battery: 20,
  x: 10,
  y: 5,
  teleopLocked: false,
  ...over,
});
const charger = (over: Partial<ChargerInfo> = {}): ChargerInfo => ({
  id: 'c1',
  code: 'CHG-B1-1',
  floor: 'b1',
  x: 2,
  y: 2,
  brand: 'anbot',
  enabled: true,
  robotDock: {},
  ...over,
});

describe('needsCharge：觸發回充', () => {
  it('電量 ≤ 回充門檻（25%）且沒在充電 → 回充；26% 不用', () => {
    expect(needsCharge(robot({ battery: 25 }), S)).toBe(true);
    expect(needsCharge(robot({ battery: 26 }), S)).toBe(false);
  });
  it.each([['充電中', { state: 'charging' }], ['返航中', { state: 'returning' }], ['急停', { state: 'estop' }], ['遙控中', { teleopLocked: true }], ['離線', { online: false }]])(
    '%s → 不觸發',
    (_, over) => {
      expect(needsCharge(robot(over), S)).toBe(false);
    },
  );
  it('執行任務中電量過低也會觸發（任務暫停）', () => {
    expect(needsCharge(robot({ state: 'navigating', battery: 24 }), S)).toBe(true);
  });
});

describe('pickCharger：同樓層、同品牌、未佔用、最近', () => {
  const list = [
    charger({ id: 'far', x: 40, y: 20 }),
    charger({ id: 'near', x: 8, y: 5 }),
    charger({ id: 'other-brand', x: 10, y: 5, brand: 'unitree' }),
    charger({ id: 'other-floor', x: 10, y: 5, floor: '1f' }),
    charger({ id: 'off', x: 10, y: 6, enabled: false }),
  ];
  it('選最近的可用樁', () => {
    expect(pickCharger(robot(), list, new Set())?.id).toBe('near');
  });
  it('最近的被佔用 → 下一座', () => {
    expect(pickCharger(robot(), list, new Set(['near']))?.id).toBe('far');
  });
  it('全部佔滿 → null（排隊）', () => {
    expect(pickCharger(robot(), list, new Set(['near', 'far']))).toBeNull();
  });
});

describe('排隊與讓位', () => {
  it('電量由低到高；同電量先排先充', () => {
    const q = [
      { id: 'a', battery: 18, since: 1 },
      { id: 'b', battery: 9, since: 3 },
      { id: 'c', battery: 18, since: 0 },
    ];
    expect([...q].sort(queueOrder).map((x) => x.id)).toEqual(['b', 'c', 'a']);
  });
  it('充到 90% 且有人排隊才讓位；沒人排隊留在樁上', () => {
    expect(shouldYield(90, S, 1)).toBe(true);
    expect(shouldYield(89, S, 1)).toBe(false);
    expect(shouldYield(95, S, 0)).toBe(false);
  });
  it('等候點：從樁往樓層中心退 1.5 公尺，排第二再多 1 公尺', () => {
    // 往中心 (21,14) 的方向 (19,12)，1.5 公尺 → (3.27, 2.80)
    expect(waitPoint({ x: 2, y: 2 }, { w: 42, h: 28 }, 0)).toEqual({ x: 3.27, y: 2.8 });
    const p1 = waitPoint({ x: 2, y: 2 }, { w: 42, h: 28 }, 1);
    expect(Math.hypot(p1.x - 2, p1.y - 2)).toBeCloseTo(2.5, 1);
  });
  it('人工充電完成：電量跳升 20 點以上或達 90%', () => {
    expect(manualDone(15, 36, S)).toBe(true);
    expect(manualDone(15, 30, S)).toBe(false);
    expect(manualDone(80, 90, S)).toBe(true);
  });
});
