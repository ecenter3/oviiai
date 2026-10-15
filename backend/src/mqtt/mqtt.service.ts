import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import mqtt, { type MqttClient } from 'mqtt';
import { randomBytes } from 'node:crypto';

type Handler = (topic: string, payload: Buffer) => void;

/**
 * 後端唯一的 MQTT 連線。主題定義見 CLAUDE.md，不可自行更名。
 * 斷線自動重連，重連後重新訂閱（clean session）。
 */
@Injectable()
export class MqttService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('MQTT');
  private client?: MqttClient;
  private readonly subs: { filter: string; qos: 0 | 1; handler: Handler }[] = [];

  get connected(): boolean {
    return this.client?.connected ?? false;
  }

  /** 在 onModuleInit 之前（建構子或其他模組的 onModuleInit）呼叫都可以；連線後統一訂閱 */
  subscribe(filter: string, qos: 0 | 1, handler: Handler): void {
    this.subs.push({ filter, qos, handler });
    if (this.client?.connected) this.client.subscribe(filter, { qos });
  }

  async publish(topic: string, payload: string, qos: 0 | 1 = 0, retain = false): Promise<void> {
    if (!this.client) throw new Error('MQTT 尚未連線');
    await this.client.publishAsync(topic, payload, { qos, retain });
  }

  onModuleInit() {
    const url = process.env.MQTT_URL ?? 'mqtt://localhost:1883';
    this.client = mqtt.connect(url, {
      // client id 必須唯一：重複時 broker 會踢掉先連上的那一個（同一程序裡的多個實例，例如平行測試）
      clientId: `rms-backend-${process.pid}-${randomBytes(4).toString('hex')}`,
      username: process.env.MQTT_BACKEND_USER || undefined,
      password: process.env.MQTT_BACKEND_PASSWORD || undefined,
      reconnectPeriod: 2000,
      connectTimeout: 5000,
      clean: true,
    });
    let warned = false;
    this.client.on('connect', () => {
      this.log.log(`已連線 ${url}`);
      warned = false;
      for (const s of this.subs) this.client!.subscribe(s.filter, { qos: s.qos });
    });
    this.client.on('error', (e) => {
      if (!warned) this.log.warn(`MQTT 錯誤：${e.message}（持續重試中）`);
      warned = true;
    });
    this.client.on('offline', () => {
      if (!warned) this.log.warn('MQTT 離線，持續重試中');
      warned = true;
    });
    this.client.on('message', (topic, payload) => {
      for (const s of this.subs) {
        if (!matches(s.filter, topic)) continue;
        try {
          s.handler(topic, payload);
        } catch (e) {
          this.log.error(`處理 ${topic} 失敗：${e instanceof Error ? e.stack : e}`);
        }
      }
    });
  }

  async onModuleDestroy() {
    await this.client?.endAsync();
  }
}

/** MQTT 萬用字元比對：+ 一層、# 其餘全部 */
export function matches(filter: string, topic: string): boolean {
  const f = filter.split('/');
  const t = topic.split('/');
  for (let i = 0; i < f.length; i++) {
    if (f[i] === '#') return true;
    if (i >= t.length || (f[i] !== '+' && f[i] !== t[i])) return false;
  }
  return f.length === t.length;
}
