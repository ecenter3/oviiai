import { describe, expect, it } from 'vitest';
import { matches } from './mqtt.service';

describe('MQTT 主題比對', () => {
  it.each([
    ['rms/robot/+/telemetry', 'rms/robot/B2-001/telemetry', true],
    ['rms/robot/+/telemetry', 'rms/robot/B2-001/event', false],
    ['rms/robot/+/telemetry', 'rms/robot/telemetry', false],
    ['rms/adapter/+/status', 'rms/adapter/mock/status', true],
    ['rms/#', 'rms/robot/B2-001/ack', true],
  ])('%s ~ %s → %s', (f, t, ok) => {
    expect(matches(f, t)).toBe(ok);
  });
});
