import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ZodTypeAny } from 'zod';
import * as c from '../src';

/** T-07：與 adapters/tests/test_contracts.py 讀同一份 fixtures */
const fx = JSON.parse(readFileSync(resolve(__dirname, '../fixtures/messages.json'), 'utf8'));

const SCHEMAS: Record<string, ZodTypeAny> = {
  Telemetry: c.Telemetry,
  RobotEvent: c.RobotEvent,
  Command: c.Command,
  Ack: c.Ack,
  Teleop: c.Teleop,
  RobotOnline: c.RobotOnline,
  AdapterStatus: c.AdapterStatus,
};
const ENUMS: Record<string, { options: readonly string[] }> = {
  RobotState: c.RobotState,
  EventType: c.EventType,
  CommandType: c.CommandType,
  AckStatus: c.AckStatus,
};

const strip = ({ $why: _, ...m }: Record<string, unknown>) => m;

describe('fixtures/messages.json（zod 端）', () => {
  it('fixtures 涵蓋全部訊息類型', () => {
    expect(Object.keys(fx.messages).sort()).toEqual(Object.keys(SCHEMAS).sort());
  });

  for (const [name, values] of Object.entries(fx.enums as Record<string, string[]>)) {
    it(`列舉 ${name} 與 fixtures 相同`, () => {
      expect([...ENUMS[name].options]).toEqual(values);
    });
  }

  for (const [name, cases] of Object.entries(fx.messages as Record<string, { valid: object[]; invalid: object[] }>)) {
    it.each(cases.valid.map((m) => [JSON.stringify(m).slice(0, 80), m]))(`${name} 接受 %s`, (_, m) => {
      const r = SCHEMAS[name].safeParse(strip(m as Record<string, unknown>));
      expect(r.error?.issues).toBeUndefined();
    });
    it.each(cases.invalid.map((m) => [(m as { $why: string }).$why, m]))(`${name} 拒絕：%s`, (_, m) => {
      expect(SCHEMAS[name].safeParse(strip(m as Record<string, unknown>)).success).toBe(false);
    });
  }
});
