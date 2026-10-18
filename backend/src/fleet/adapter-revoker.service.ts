import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Subscription } from 'rxjs';
import { adapterClientId, EmqxApi } from '../mqtt/emqx-api';
import { RobotRegistry } from './robot-registry';

/**
 * 機器人離開某個轉接器（改派、停用、刪除）→ 用 EMQX API 踢掉舊轉接器的連線（PR #16 審查第 2 點）。
 * 轉接器的 MQTT 權限是連線當下憑證裡的機器人清單，不踢的話舊轉接器還能發這台的遙測、收這台的指令；
 * 被踢後轉接器向後端重取憑證再連，新憑證已不含這台。同一個轉接器 1 秒內多台變動只踢一次。
 */
@Injectable()
export class AdapterRevoker implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('AdapterRevoker');
  private sub?: Subscription;
  private readonly pending = new Map<string, { codes: string[]; timer: NodeJS.Timeout }>();

  constructor(
    private readonly registry: RobotRegistry,
    private readonly emqx: EmqxApi,
  ) {}

  onModuleInit() {
    this.sub = this.registry.leftAdapter$.subscribe(({ robot, adapter }) => {
      const p = this.pending.get(adapter);
      if (p) return void p.codes.push(robot.code);
      this.pending.set(adapter, { codes: [robot.code], timer: setTimeout(() => void this.kick(adapter), 1000) });
    });
  }

  onModuleDestroy() {
    this.sub?.unsubscribe();
    for (const p of this.pending.values()) clearTimeout(p.timer);
  }

  private async kick(adapter: string) {
    const codes = this.pending.get(adapter)?.codes ?? [];
    this.pending.delete(adapter);
    try {
      if (await this.emqx.kick(adapterClientId(adapter))) this.log.log(`${codes.join('、')} 已離開轉接器 ${adapter}，踢掉它的 MQTT 連線，讓它用新憑證重連`);
    } catch (e) {
      this.log.warn(`踢掉轉接器 ${adapter} 的連線失敗：${e instanceof Error ? e.message : e}（它重連之前仍有這台的權限）`);
    }
  }
}
