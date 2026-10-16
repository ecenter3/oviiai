import { describe, expect, it } from 'vitest';
import { type Candidate, eligible, pickPreemptVictim, pickRobot, planRound, type QueuedTask, queueOrder } from './pick-robot';
import { canTransition, initialStatus, sourcesOf } from './task-state';

const S = { minAccept: 40 };
const robot = (over: Partial<Candidate>): Candidate => ({
  robotId: 'r1',
  code: 'B2-001',
  floor: '1f',
  online: true,
  enabled: true,
  state: 'idle',
  battery: 80,
  x: 0,
  y: 0,
  caps: [],
  teleopLocked: false,
  busy: false,
  ...over,
});
const task = (over: Partial<QueuedTask> = {}): QueuedTask => ({
  id: 't1',
  priority: 'P3',
  createdAt: new Date('2026-10-15T00:00:00Z'),
  floorId: '1f',
  robotId: null,
  pinnedRobot: false,
  target: { x: 10, y: 0 },
  requiredCaps: [],
  ...over,
});

describe('eligible：可接任務的條件', () => {
  it.each([
    ['別樓層', { floor: 'b1' }],
    ['離線', { online: false }],
    ['已停用', { enabled: false }],
    ['不是待命', { state: 'navigating' }],
    ['充電中', { state: 'charging' }],
    ['急停', { state: 'estop' }],
    ['遙控中', { teleopLocked: true }],
    ['已有任務', { busy: true }],
    ['電量低於接單門檻 40%', { battery: 39.9 }],
  ])('%s → 不可', (_, over) => {
    expect(eligible(robot(over), task(), S)).toBe(false);
  });

  it('電量剛好 40% 可以', () => {
    expect(eligible(robot({ battery: 40 }), task(), S)).toBe(true);
  });

  it('任務需要的能力機器人沒有 → 不可', () => {
    expect(eligible(robot({ caps: ['ptz'] }), task({ requiredCaps: ['ptz', 'talk'] }), S)).toBe(false);
    expect(eligible(robot({ caps: ['ptz', 'talk'] }), task({ requiredCaps: ['ptz', 'talk'] }), S)).toBe(true);
  });
});

describe('pickRobot：選最近、電量夠的', () => {
  it('距離為主', () => {
    const r = pickRobot(task(), [robot({ robotId: 'far', x: 30 }), robot({ robotId: 'near', x: 8 })], S);
    expect(r?.robotId).toBe('near');
  });

  it('最近那台電量不足 → 選次近的', () => {
    const r = pickRobot(task(), [robot({ robotId: 'near', x: 9, battery: 30 }), robot({ robotId: 'mid', x: 4, battery: 90 })], S);
    expect(r?.robotId).toBe('mid');
  });

  it('同距離選電量高', () => {
    const r = pickRobot(task(), [robot({ robotId: 'a', x: 5, battery: 50 }), robot({ robotId: 'b', x: 15, battery: 90 })], S);
    expect(r?.robotId).toBe('b');
  });

  it('沒有可用的 → null（任務留在佇列）', () => {
    expect(pickRobot(task(), [robot({ state: 'charging' }), robot({ battery: 10 })], S)).toBeNull();
  });

  it('指定機器人：只派那一台，不可用就等', () => {
    const t = task({ pinnedRobot: true, robotId: 'far' });
    expect(pickRobot(t, [robot({ robotId: 'near', x: 9 }), robot({ robotId: 'far', x: 30 })], S)?.robotId).toBe('far');
    expect(pickRobot(t, [robot({ robotId: 'near', x: 9 }), robot({ robotId: 'far', x: 30, battery: 10 })], S)).toBeNull();
  });

  it('暫停後續做：原本那台可用就派回同一台，不可用就照常選最近', () => {
    const t = task({ robotId: 'prev' });
    const list = [robot({ robotId: 'near', x: 9 }), robot({ robotId: 'prev', x: 30 })];
    expect(pickRobot(t, list, S)?.robotId).toBe('prev');
    expect(pickRobot(t, [list[0], { ...list[1], state: 'estop' }], S)?.robotId).toBe('near');
  });
});

describe('queueOrder 與 planRound', () => {
  it('P1 > P2 > P3 > P4，同級先建先做', () => {
    const at = (m: number) => new Date(Date.UTC(2026, 9, 15, 0, m));
    const list = [
      task({ id: 'p3-late', priority: 'P3', createdAt: at(5) }),
      task({ id: 'p1', priority: 'P1', createdAt: at(9) }),
      task({ id: 'p3-early', priority: 'P3', createdAt: at(1) }),
      task({ id: 'p4', priority: 'P4', createdAt: at(0) }),
      task({ id: 'p2', priority: 'P2', createdAt: at(8) }),
    ];
    expect([...list].sort(queueOrder).map((t) => t.id)).toEqual(['p1', 'p2', 'p3-early', 'p3-late', 'p4']);
  });

  it('同一輪不會把同一台派給兩筆；車不夠時高優先先拿到', () => {
    const tasks = [task({ id: 'low', priority: 'P4' }), task({ id: 'high', priority: 'P2' }), task({ id: 'mid', priority: 'P3' })];
    const robots = [robot({ robotId: 'a', x: 9 }), robot({ robotId: 'b', x: 2 })];
    const plan = planRound(tasks, robots, S);
    expect(plan.map(([t, r]) => [t.id, r.robotId])).toEqual([
      ['high', 'a'],
      ['mid', 'b'],
    ]);
    expect(new Set(plan.map(([, r]) => r.robotId)).size).toBe(plan.length);
  });
});

describe('任務狀態機', () => {
  it('合法與非法轉換', () => {
    expect(canTransition('queued', 'assigned')).toBe(true);
    expect(canTransition('assigned', 'running')).toBe(true);
    expect(canTransition('running', 'done')).toBe(true);
    expect(canTransition('running', 'paused')).toBe(true);
    expect(canTransition('paused', 'queued')).toBe(true);
    expect(canTransition('pending_approval', 'queued')).toBe(true);
    expect(canTransition('pending_approval', 'rejected')).toBe(true);
    expect(canTransition('done', 'queued')).toBe(false);
    expect(canTransition('queued', 'running')).toBe(false);
    expect(canTransition('rejected', 'queued')).toBe(false);
    expect(sourcesOf('cancelled').sort()).toEqual(['assigned', 'paused', 'pending_approval', 'queued', 'running']);
  });

  it('初始狀態：審批開啟時非 P1 待審批、P1 直接排隊；排程來源不再審批；超過 approvalUntil 自動關閉', () => {
    const on = { approval: true, approvalUntil: '2027-01-31' };
    const now = new Date('2026-10-15T04:00:00Z');
    expect(initialStatus({ priority: 'P3', source: 'manual' }, on, now)).toBe('pending_approval');
    expect(initialStatus({ priority: 'P1', source: 'manual' }, on, now)).toBe('queued');
    expect(initialStatus({ priority: 'P3', source: 'schedule' }, on, now)).toBe('queued');
    expect(initialStatus({ priority: 'P3', source: 'manual' }, { ...on, approval: false }, now)).toBe('queued');
    // 2027-01-31 台北時間當天仍審批，隔天（UTC 1/31 16:00 = 台北 2/1 00:00）起關閉
    expect(initialStatus({ priority: 'P3', source: 'manual' }, on, new Date('2027-01-31T15:59:00Z'))).toBe('pending_approval');
    expect(initialStatus({ priority: 'P3', source: 'manual' }, on, new Date('2027-01-31T16:00:00Z'))).toBe('queued');
  });
});

describe('續做保留（PR #6 審查第 2 點）', () => {
  const now = 1_000_000;
  it('保留期內只派原本那台；它停在 paused 也可以', () => {
    const t = task({ robotId: 'prev', reservedUntil: now + 30_000 });
    const list = [robot({ robotId: 'near', x: 9 }), robot({ robotId: 'prev', x: 30, state: 'paused' })];
    expect(pickRobot(t, list, S, now)?.robotId).toBe('prev');
  });

  it('保留期內原本那台暫時不能接（例如還在遙控過渡）→ 等，不給別台', () => {
    const t = task({ robotId: 'prev', reservedUntil: now + 30_000 });
    const list = [robot({ robotId: 'near', x: 9 }), robot({ robotId: 'prev', x: 30, state: 'teleop' })];
    expect(pickRobot(t, list, S, now)).toBeNull();
    // 保留期過後照常選最近
    expect(pickRobot(t, list, S, now + 31_000)?.robotId).toBe('near');
  });

  it('原本那台電量不足，保留期內也不派它', () => {
    const t = task({ robotId: 'prev', reservedUntil: now + 30_000 });
    expect(pickRobot(t, [robot({ robotId: 'prev', battery: 20, state: 'paused' })], S, now)).toBeNull();
  });

  it('別台停在 paused 不算可用（只有原本那台例外）', () => {
    expect(pickRobot(task(), [robot({ robotId: 'x', state: 'paused' })], S, now)).toBeNull();
  });
});

describe('P1 插隊對象（T-17）', () => {
  const p1 = task({ priority: 'P1', target: { x: 10, y: 0 } });
  const busy = (over: Partial<Candidate>) => robot({ busy: true, state: 'navigating', taskPriority: 'P3', ...over });

  it('選離 P1 目標最近、執行非 P1 任務、電量足夠的', () => {
    const r = pickPreemptVictim(p1, [busy({ robotId: 'far', x: 30 }), busy({ robotId: 'near', x: 12 })], S);
    expect(r?.robotId).toBe('near');
  });

  it.each([
    ['執行 P1 任務', { taskPriority: 'P1' as const }],
    ['電量不足', { battery: 30 }],
    ['遙控中', { teleopLocked: true }],
    ['急停', { state: 'estop' }],
    ['離線', { online: false }],
    ['別樓層', { floor: 'b1' }],
    ['沒有任務（空閒的應由一般選車處理）', { busy: false, taskPriority: null }],
  ])('%s → 不中斷', (_, over) => {
    expect(pickPreemptVictim(p1, [busy(over)], S)).toBeNull();
  });
});

describe('在樁上但 state 仍是 idle（真機回報 charging=true，PR #8 審查第 1 點）', () => {
  const s = { minAccept: 40, resumeAt: 90 };
  it('電量未達 resumeAt 不接任務', () => {
    expect(eligible(robot({ state: 'idle', charging: true, battery: 60 }), task(), s)).toBe(false);
  });
  it('充到 resumeAt 可接任務', () => {
    expect(eligible(robot({ state: 'idle', charging: true, battery: 92 }), task(), s)).toBe(true);
  });
});
