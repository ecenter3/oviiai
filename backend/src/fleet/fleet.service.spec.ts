import { Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../db/database.module';
import type { MqttService } from '../mqtt/mqtt.service';
import type { SettingsService } from '../settings/settings.service';
import { FleetService, type WsOut } from './fleet.service';
import type { RobotRegistry } from './robot-registry';
import type { TelemetryWriter } from './telemetry-writer';
import type { FleetEvent, RobotInfo } from './types';

const ROBOTS: RobotInfo[] = [
  { id: '11111111-1111-4111-8111-111111111111', code: 'B2-001', floor: '1f', adapter: 'mock', caps: [] },
  { id: '22222222-2222-4222-8222-222222222222', code: 'ANBOT-001', floor: 'b1', adapter: 'anbot', caps: [] },
];

function telemetry(over: Record<string, unknown> = {}) {
  return {
    ts: Date.now(),
    pose: { x: 1, y: 2, yaw: 0.5, floor: '1f' },
    battery: { pct: 80, charging: false },
    state: 'idle',
    faults: [],
    ...over,
  };
}

function setup() {
  const byCode = new Map(ROBOTS.map((r) => [r.code, r]));
  const removed$ = new Subject<RobotInfo>();
  const registry = {
    removed$,
    load: async () => {},
    all: () => ROBOTS,
    get: (c: string) => byCode.get(c),
    resolve: async (c: string) => byCode.get(c),
  } as unknown as RobotRegistry;
  const rows: Record<string, unknown>[] = [];
  const writer = { add: (r: Record<string, unknown>) => (rows.push(r), true) } as unknown as TelemetryWriter;
  const settings = { getNumber: async (_: string, d: number) => d } as unknown as SettingsService;
  const mqtt = { subscribe: () => {} } as unknown as MqttService;
  const redisStore = new Map<string, Record<string, unknown>>();
  const redis = {
    hset: async (k: string, v: Record<string, unknown>) => redisStore.set(k, { ...redisStore.get(k), ...v }),
    hget: async () => null,
    del: async (...keys: string[]) => keys.forEach((k) => redisStore.delete(k)),
  };
  const stateLog: Record<string, unknown>[] = [];
  const db = {
    insertInto: () => ({ values: (v: Record<string, unknown>) => ({ execute: async () => stateLog.push(v) }) }),
  } as unknown as Database;

  const svc = new FleetService(registry, writer, settings, mqtt, redis as never, db);
  const out: WsOut[] = [];
  const events: FleetEvent[] = [];
  svc.out$.subscribe((m) => out.push(m));
  svc.events$.subscribe((e) => events.push(e));
  return { svc, out, events, rows, stateLog, redisStore, removed$ };
}

describe('FleetService', () => {
  beforeEach(() => vi.useFakeTimers({ now: new Date('2026-10-15T08:00:00Z') }));
  afterEach(() => vi.useRealTimers());

  it('第一筆遙測：寫 Redis、排入 telemetry、記狀態、推 robot.online 與 robot.state', async () => {
    const { svc, out, events, rows, stateLog, redisStore } = setup();
    await svc.handleTelemetry('B2-001', telemetry({ net: { rssi: -61.6 }, taskRef: 'c_8f2' }));

    const live = svc.get('B2-001')!;
    expect(live).toMatchObject({ robotId: ROBOTS[0].id, floor: '1f', online: true, x: 1, battery: 80, rssi: -61.6, taskId: 'c_8f2' });
    expect(JSON.parse(redisStore.get('robot:B2-001')!.live as string)).toEqual(live);
    expect(redisStore.get('robot:B2-001')).toMatchObject({ online: 1, lastSeen: Date.now() });
    expect(rows[0]).toMatchObject({ robot_id: ROBOTS[0].id, state: 'idle', rssi: -62, task_id: null });
    expect(stateLog).toEqual([expect.objectContaining({ state: 'idle', reason: 'first_seen' })]);
    expect(out.map((m) => m.event)).toEqual(['robot.online', 'robot.state']);
    expect(out.every((m) => m.floor === '1f')).toBe(true);
    expect(events.map((e) => e.type)).toEqual(['online', 'state']);
  });

  it('格式錯誤、未登記的機器人一律丟棄', async () => {
    const { svc, out, rows } = setup();
    await svc.handleTelemetry('B2-001', telemetry({ battery: { pct: 150, charging: false } }));
    await svc.handleTelemetry('B2-999', telemetry());
    expect(svc.get('B2-001')).toBeUndefined();
    expect(out).toEqual([]);
    expect(rows).toEqual([]);
  });

  it('WebSocket 節流：500 ms 內多筆只送第一筆＋最後一筆', async () => {
    const { svc, out } = setup();
    await svc.handleTelemetry('B2-001', telemetry());
    out.length = 0;
    vi.advanceTimersByTime(600);
    for (let i = 1; i <= 5; i++) {
      await svc.handleTelemetry('B2-001', telemetry({ pose: { x: i, y: 0, yaw: 0, floor: '1f' } }));
      vi.advanceTimersByTime(50);
    }
    expect(out.filter((m) => m.event === 'robot.state').map((m) => (m.data as { x: number }).x)).toEqual([1]);
    vi.advanceTimersByTime(500);
    expect(out.filter((m) => m.event === 'robot.state').map((m) => (m.data as { x: number }).x)).toEqual([1, 5]);
  });

  it('狀態改變不受節流，立即推送並寫 robot_state_log', async () => {
    const { svc, out, stateLog, events } = setup();
    await svc.handleTelemetry('B2-001', telemetry());
    out.length = 0;
    await svc.handleTelemetry('B2-001', telemetry({ state: 'navigating' }));
    expect(out).toHaveLength(1);
    expect(stateLog.at(-1)).toMatchObject({ state: 'navigating', reason: null });
    expect(events.at(-1)).toMatchObject({ type: 'state', from: 'idle', to: 'navigating' });
  });

  it('超過 robot.offlineSec（10 秒）沒遙測 → 離線；10 秒內不會誤判', async () => {
    const { svc, out, events, stateLog } = setup();
    await svc.handleTelemetry('B2-001', telemetry());
    vi.advanceTimersByTime(10_000);
    await svc.checkOffline();
    expect(svc.get('B2-001')!.online).toBe(true);

    vi.advanceTimersByTime(1_000);
    await svc.checkOffline();
    expect(svc.get('B2-001')).toMatchObject({ online: false, state: 'offline', x: 1 });
    expect(events.at(-1)).toMatchObject({ type: 'offline', reason: 'telemetry_timeout' });
    expect(stateLog.at(-1)).toMatchObject({ state: 'offline', reason: 'telemetry_timeout' });
    expect(out.slice(-2).map((m) => [m.event, (m.data as { online: boolean }).online])).toEqual([
      ['robot.online', false],
      ['robot.state', false],
    ]);
  });

  it('離線後再收到遙測 → 恢復上線，狀態原因記 reconnected', async () => {
    const { svc, events, stateLog } = setup();
    await svc.handleTelemetry('B2-001', telemetry());
    await svc.handleOnline('B2-001', { online: false, ts: Date.now() });
    vi.advanceTimersByTime(1000);
    await svc.handleTelemetry('B2-001', telemetry());
    expect(svc.get('B2-001')!.online).toBe(true);
    expect(events.map((e) => e.type)).toEqual(['online', 'state', 'offline', 'online', 'state']);
    expect(stateLog.at(-1)).toMatchObject({ state: 'idle', reason: 'reconnected' });
  });

  it('轉接器回報單台離線 → 立即離線', async () => {
    const { svc, events } = setup();
    await svc.handleTelemetry('B2-001', telemetry());
    await svc.handleOnline('B2-001', { online: false, ts: Date.now() });
    expect(svc.get('B2-001')!.online).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'offline', reason: 'adapter_reported' });
  });

  it('轉接器斷線（Last Will alive=false）→ 只有該轉接器的機器人離線', async () => {
    const { svc } = setup();
    await svc.handleTelemetry('B2-001', telemetry());
    await svc.handleTelemetry('ANBOT-001', telemetry({ pose: { x: 0, y: 0, yaw: 0, floor: 'b1' } }));
    await svc.handleAdapterStatus('mock', { name: 'mock', alive: false });
    expect(svc.get('B2-001')!.online).toBe(false);
    expect(svc.get('ANBOT-001')!.online).toBe(true);
  });

  it('亂序的舊遙測丟棄', async () => {
    const { svc } = setup();
    await svc.handleTelemetry('B2-001', telemetry({ pose: { x: 5, y: 0, yaw: 0, floor: '1f' } }));
    await svc.handleTelemetry('B2-001', telemetry({ ts: Date.now() - 2000, pose: { x: 1, y: 0, yaw: 0, floor: '1f' } }));
    expect(svc.get('B2-001')!.x).toBe(5);
  });

  it('樓層以資料庫登記為準；taskRef 是任務 UUID 才入庫', async () => {
    const { svc, rows } = setup();
    const taskId = '33333333-3333-4333-8333-333333333333';
    await svc.handleTelemetry('B2-001', telemetry({ pose: { x: 0, y: 0, yaw: 0, floor: '2f' }, taskRef: taskId }));
    expect(svc.get('B2-001')!.floor).toBe('1f');
    expect(rows[0].task_id).toBe(taskId);
  });

  it('snapshot 只回指定樓層', async () => {
    const { svc } = setup();
    await svc.handleTelemetry('B2-001', telemetry());
    await svc.handleTelemetry('ANBOT-001', telemetry({ pose: { x: 0, y: 0, yaw: 0, floor: 'b1' } }));
    expect(svc.snapshot(['b1']).map((s) => s.code)).toEqual(['ANBOT-001']);
  });

  it('機器人被停用：從即時狀態與 Redis 移除，推 robot.online removed（PR #3 審查第 1 點）', async () => {
    const { svc, out, redisStore, removed$ } = setup();
    // 只測移除邏輯：直接呼叫 onModuleInit 裡訂閱的處理
    (svc as unknown as { registry: { removed$: Subject<RobotInfo> } }).registry.removed$.subscribe((r) =>
      (svc as unknown as { purge: (r: RobotInfo) => Promise<void> }).purge(r),
    );
    await svc.handleTelemetry('B2-001', telemetry());
    out.length = 0;
    removed$.next(ROBOTS[0]);
    await vi.waitFor(() => expect(svc.get('B2-001')).toBeUndefined());
    expect(redisStore.has('robot:B2-001')).toBe(false);
    expect(svc.snapshot(['1f'])).toEqual([]);
    expect(out).toEqual([
      { event: 'robot.online', floor: '1f', data: { robotId: ROBOTS[0].id, code: 'B2-001', online: false, removed: true } },
    ]);
  });
});
