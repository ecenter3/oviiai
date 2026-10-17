import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { adapterAcl, mqttJwtSecret, signMqttToken } from './mqtt-auth';

describe('EMQX 帳號與權限（安全收尾 e）', () => {
  it('轉接器只拿到自己機器人的主題：上行只能發布、指令與遙控只能訂閱', () => {
    const acl = adapterAcl('mock', ['B2-001']);
    const of = (action: string) => acl.filter((r) => r.action === action).map((r) => r.topic);
    expect(of('publish')).toEqual([
      'rms/adapter/mock/status',
      'rms/robot/B2-001/telemetry',
      'rms/robot/B2-001/event',
      'rms/robot/B2-001/ack',
      'rms/robot/B2-001/online',
    ]);
    expect(of('subscribe')).toEqual(['rms/robot/B2-001/cmd', 'rms/robot/B2-001/teleop']);
    expect(of('all')).toEqual([]);
  });

  it('代碼含萬用字元或斜線不給權限', () => {
    expect(adapterAcl('mock', ['#', '+', 'A/B', 'OK-1']).map((r) => r.topic).filter((t) => t.startsWith('rms/robot/'))).toEqual([
      'rms/robot/OK-1/telemetry',
      'rms/robot/OK-1/event',
      'rms/robot/OK-1/ack',
      'rms/robot/OK-1/online',
      'rms/robot/OK-1/cmd',
      'rms/robot/OK-1/teleop',
    ]);
  });

  it('JWT：HS256 簽章、帳號、效期、acl', () => {
    const secret = 'x'.repeat(32);
    const tok = signMqttToken('mock', adapterAcl('mock', []), secret, 60, 1_000_000);
    const [h, p, s] = tok.split('.');
    expect(createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url')).toBe(s);
    expect(JSON.parse(Buffer.from(p, 'base64url').toString())).toEqual({
      username: 'mock',
      iat: 1000,
      exp: 1060,
      acl: [{ permission: 'allow', action: 'publish', topic: 'rms/adapter/mock/status' }],
    });
  });

  it('金鑰：太短視為沒設定；正式環境沒設定不啟動', () => {
    const old = process.env.EMQX_JWT_SECRET;
    try {
      process.env.EMQX_JWT_SECRET = 'short';
      expect(mqttJwtSecret('development')).toBeNull();
      expect(() => mqttJwtSecret('production')).toThrow(/EMQX_JWT_SECRET/);
    } finally {
      if (old === undefined) delete process.env.EMQX_JWT_SECRET;
      else process.env.EMQX_JWT_SECRET = old;
    }
  });
});
