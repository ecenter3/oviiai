import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { RobotEvent, topics } from '@oviiai/contracts';
import type { Subscription } from 'rxjs';
import { ChargingService, type ChargeAlert } from '../charging/charging.service';
import { CommandBus, type CmdRecord } from '../commands/command-bus.service';
import { DispatchService, type DispatchAlert } from '../dispatch/dispatch.service';
import { TasksService } from '../dispatch/tasks.service';
import { FleetService } from '../fleet/fleet.service';
import { RobotRegistry } from '../fleet/robot-registry';
import type { FleetEvent, LiveState, OfflineReason, RobotInfo } from '../fleet/types';
import { MqttService } from '../mqtt/mqtt.service';
import { SettingsService } from '../settings/settings.service';
import { type AlarmInput, AlarmsService } from './alarms.service';

const CHECK_MS = 2_000;
/** rssi 低於這個值持續 WEAK_SIGNAL_MS → 訊號偏弱 */
export const WEAK_RSSI = -75;
export const WEAK_SIGNAL_MS = 30_000;
/** 電量回到 returnAt + 這個值以上才重新啟用低電量告警，避免在門檻附近來回跳動 */
const BATTERY_HYSTERESIS = 5;

/** 轉接器斷線時逐台離線事件的收集時間 */
const ADAPTER_BATCH_MS = 1_000;
/** 故障告警的去重來源要含故障碼：同一台不同故障各自一筆（PR #9 審查第 1 點） */
export const faultSource = (robotId: string, code: string) => `robot:${robotId}:fault:${code}`;

const OFFLINE_REASON: Record<OfflineReason, string> = {
  telemetry_timeout: '遙測逾時',
  adapter_reported: '轉接器回報離線',
  adapter_down: '轉接器斷線',
};

/** 每台機器人的邊緣觸發狀態：同一狀況只在「進入」時告警一次 */
interface Watch {
  batteryLow: boolean;
  weakSince: number | null;
  weakAlerted: boolean;
  faults: Set<string>;
}

/**
 * 系統告警規則（後端邏輯 §5 第一期）：把各模組的事件正規化後送進告警管線。
 *
 * | type | 來源 |
 * | battery_low | 遙測電量 ≤ charge.returnAt（進入時一次，回升 5% 以上再啟用） |
 * | offline | fleet offline 事件（超過 robot.offlineSec 無遙測、轉接器回報該台離線） |
 * | adapter_down | 轉接器斷線：同一轉接器底下的機器人合併成一筆 |
 * | estop | 狀態進入 estop；機器人事件 estop_pressed |
 * | fault | 遙測 faults 出現新的 1 級故障碼；機器人事件 fault（level 1） |
 * | weak_signal | rssi < -75 dBm 持續 30 秒 |
 * | cmd_failed | 指令被拒、失敗或 15 秒無 ack |
 * | p1_preempt／p1_no_robot | 派工 alerts$ |
 * | charge_queue／manual_charge／charge_failed | 充電排程 alerts$ |
 * stream_down 由影像閘道（T-29）送入。
 */
@Injectable()
export class AlarmSourcesService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('AlarmSources');
  private subs: Subscription[] = [];
  private timer?: NodeJS.Timeout;
  private readonly watch = new Map<string, Watch>();
  private checking: Promise<void> = Promise.resolve();
  private readonly adapterDown = new Map<string, { robots: RobotInfo[]; at: number }>();

  constructor(
    private readonly alarms: AlarmsService,
    private readonly fleet: FleetService,
    private readonly registry: RobotRegistry,
    private readonly bus: CommandBus,
    private readonly dispatch: DispatchService,
    private readonly tasks: TasksService,
    private readonly charging: ChargingService,
    private readonly settings: SettingsService,
    private readonly mqtt: MqttService,
  ) {}

  onModuleInit() {
    const safe = (p: Promise<unknown>) => void p.catch((e) => this.log.error(e instanceof Error ? e.stack : String(e)));
    this.subs = [
      this.fleet.events$.subscribe((e) => safe(this.onFleet(e))),
      this.bus.failures$.subscribe((c) => safe(this.onCmdFailed(c))),
      this.dispatch.alerts$.subscribe((a) => safe(this.onDispatch(a))),
      this.charging.alerts$.subscribe((a) => safe(this.onCharge(a))),
    ];
    this.mqtt.subscribe(topics.event('+'), 1, (topic, payload) => {
      let body: unknown;
      try {
        body = JSON.parse(payload.toString('utf8'));
      } catch {
        return;
      }
      safe(this.onRobotEvent(topic.split('/')[2], body));
    });
    this.timer = setInterval(() => safe(this.check()), CHECK_MS);
  }

  onModuleDestroy() {
    for (const s of this.subs) s.unsubscribe();
    clearInterval(this.timer);
  }

  /**
   * 檢查遙測數值類規則（低電量、訊號偏弱、故障碼）。背景每 2 秒；測試可直接呼叫。
   * 依序執行：兩次檢查同時跑會在邊緣狀態更新前各發一次同一筆告警。
   */
  check(now = Date.now()): Promise<void> {
    const run = this.checking.then(() => this.checkOnce(now));
    this.checking = run.catch(() => undefined);
    return run;
  }

  private async checkOnce(now: number): Promise<void> {
    const returnAt = await this.settings.getNumber('charge.returnAt', 25);
    for (const live of this.fleet.all()) {
      if (!live.online) continue;
      const w = this.watchOf(live.robotId);
      await this.checkBattery(live, w, returnAt);
      await this.checkSignal(live, w, now);
      await this.checkFaults(live, w);
    }
  }

  private async checkBattery(live: LiveState, w: Watch, returnAt: number) {
    if (live.battery > returnAt + BATTERY_HYSTERESIS || live.charging) w.batteryLow = false;
    if (w.batteryLow || live.charging || live.battery > returnAt) return;
    w.batteryLow = true;
    await this.raise({
      type: 'battery_low',
      robotId: live.robotId,
      message: `${live.code} 電量 ${live.battery.toFixed(0)}%，低於回充門檻 ${returnAt}%`,
      ext: { battery: live.battery },
    });
  }

  private async checkSignal(live: LiveState, w: Watch, now: number) {
    if (live.rssi === null || live.rssi >= WEAK_RSSI) {
      w.weakSince = null;
      w.weakAlerted = false;
      return;
    }
    w.weakSince ??= now;
    if (w.weakAlerted || now - w.weakSince < WEAK_SIGNAL_MS) return;
    w.weakAlerted = true;
    await this.raise({
      type: 'weak_signal',
      robotId: live.robotId,
      message: `${live.code} 訊號偏弱 ${live.rssi.toFixed(0)} dBm（持續 ${Math.round((now - w.weakSince) / 1000)} 秒）`,
      ext: { rssi: live.rssi },
    });
  }

  private async checkFaults(live: LiveState, w: Watch) {
    const current = new Set(live.faults.filter((f) => f.level === 1).map((f) => f.code));
    const seen = w.faults;
    w.faults = current; // 先記下，再發告警
    for (const f of live.faults) {
      if (f.level !== 1 || seen.has(f.code)) continue;
      await this.raise({ type: 'fault', robotId: live.robotId, source: faultSource(live.robotId, f.code), message: `${live.code} 故障 ${f.code}：${f.msg}`, ext: { fault: f } });
    }
  }

  private async onFleet(e: FleetEvent) {
    if (e.type === 'offline' && e.reason === 'adapter_down') {
      this.collectAdapterDown(e.robot, e.at);
      return;
    }
    if (e.type === 'offline') {
      await this.raise({
        type: 'offline',
        robotId: e.robot.id,
        message: `${e.robot.code} 離線（${OFFLINE_REASON[e.reason]}）`,
        ext: { reason: e.reason },
        at: new Date(e.at),
      });
      this.watch.delete(e.robot.id);
    } else if (e.type === 'state' && e.to === 'estop') {
      await this.raise({ type: 'estop', robotId: e.robot.id, message: `${e.robot.code} 進入急停`, at: new Date(e.at) });
    }
  }

  private async onRobotEvent(code: string, raw: unknown) {
    const robot = await this.registry.resolve(code);
    const ev = RobotEvent.safeParse(raw);
    if (!robot || !ev.success) return;
    const d = ev.data.data ?? {};
    if (ev.data.type === 'estop_pressed') {
      await this.raise({ type: 'estop', robotId: robot.id, message: `${robot.code} 急停按鈕被按下` });
    } else if (ev.data.type === 'fault' && Number(d.level ?? 1) === 1) {
      await this.raise({
        type: 'fault',
        robotId: robot.id,
        source: faultSource(robot.id, String(d.code ?? '')),
        message: `${robot.code} 故障 ${String(d.code ?? '')}：${String(d.msg ?? '')}`.trim(),
        ext: { fault: d },
      });
    }
  }

  private async onCmdFailed(c: CmdRecord) {
    // 機器人已刪除或停用（例：Redis 還留著它送出前的待回覆指令）：不發告警，否則寫入會違反外鍵
    if (!(await this.registry.resolveId(c.robotId))) return;
    const why = c.status === 'timeout' ? '逾時未回應' : c.status === 'rejected' ? '被拒絕' : '執行失敗';
    await this.raise({
      type: 'cmd_failed',
      robotId: c.robotId,
      message: `${c.code} 指令 ${c.type} ${why}${c.error?.msg ? `：${c.error.msg}` : ''}`,
      ext: { cmdId: c.cmdId, cmdType: c.type, status: c.status, error: c.error ?? null, taskId: c.taskId ?? null },
    });
  }

  private async onDispatch(a: DispatchAlert) {
    if (a.type === 'p1_preempt') {
      await this.raise({
        type: 'p1_preempt',
        robotId: a.robot.id,
        source: `task:${a.task.id}`,
        message: `P1 任務 ${a.task.code} 插隊：${a.robot.code} 中斷 ${a.victim.code}`,
        ext: { taskId: a.task.id, victimId: a.victim.id },
        at: new Date(a.at),
      });
    } else {
      const target = await this.tasks.targetPoint(a.task).catch(() => null);
      await this.raise({
        type: 'p1_no_robot',
        floorId: a.task.floorId,
        source: `task:${a.task.id}`,
        x: target?.x ?? null,
        y: target?.y ?? null,
        message: `P1 任務 ${a.task.code} 沒有可用的機器人`,
        ext: { taskId: a.task.id },
        at: new Date(a.at),
      });
    }
  }

  private async onCharge(a: ChargeAlert) {
    const pct = `${a.battery.toFixed(0)}%`;
    const input: AlarmInput =
      a.type === 'charge_queue'
        ? { type: a.type, robotId: a.robot.id, message: `${a.robot.code} 電量 ${pct} 仍在排隊等充電（第 ${a.position} 位）`, ext: { position: a.position } }
        : a.type === 'manual_charge'
          ? {
              type: a.type,
              robotId: a.robot.id,
              message: `${a.robot.code} 電量 ${pct}，需人工充電或換電池${a.chargerCode ? `（已前往 ${a.chargerCode}）` : ''}`,
            }
          : { type: a.type, robotId: a.robot.id, message: `${a.robot.code} 連續 ${a.fails} 次回充失敗，已停止自動重送（電量 ${pct}）` };
    await this.raise({ ...input, at: new Date(a.at) });
  }

  /**
   * 轉接器斷線（PR #9 審查第 3 點）：同一個轉接器底下的機器人會在同一刻逐台離線，
   * 收集 1 秒後合併成一筆「轉接器斷線」告警（來源 adapter:{name}），不逐台發 offline。
   */
  private collectAdapterDown(robot: RobotInfo, at: number) {
    this.watch.delete(robot.id);
    const b = this.adapterDown.get(robot.adapter);
    if (b) {
      b.robots.push(robot);
      return;
    }
    const batch = { robots: [robot], at };
    this.adapterDown.set(robot.adapter, batch);
    setTimeout(() => {
      this.adapterDown.delete(robot.adapter);
      void this.flushAdapterDown(robot.adapter, batch).catch((e) => this.log.error(e instanceof Error ? e.stack : String(e)));
    }, ADAPTER_BATCH_MS);
  }

  private async flushAdapterDown(name: string, b: { robots: RobotInfo[]; at: number }) {
    const floors = [...new Set(b.robots.map((r) => r.floor))];
    const codes = b.robots.map((r) => r.code).sort();
    await this.raise({
      type: 'adapter_down',
      source: `adapter:${name}`,
      floorId: floors.length === 1 ? floors[0] : null,
      message: `轉接器 ${name} 斷線，${codes.length} 台機器人離線：${codes.join('、')}`,
      ext: { adapter: name, robots: codes },
      at: new Date(b.at),
    });
  }

  private watchOf(robotId: string): Watch {
    let w = this.watch.get(robotId);
    if (!w) {
      w = { batteryLow: false, weakSince: null, weakAlerted: false, faults: new Set() };
      this.watch.set(robotId, w);
    }
    return w;
  }

  private async raise(input: AlarmInput) {
    await this.alarms.raise(input);
  }
}
