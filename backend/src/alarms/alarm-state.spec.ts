import { describe, expect, it } from 'vitest';
import { ALARM_STATUSES, canTransition, initialStatus, sourceKey } from './alarm-state';

describe('告警狀態轉換（後端邏輯 §5）', () => {
  const legal: [string, string][] = [
    ['review', 'open'],
    ['review', 'false_alarm'],
    ['open', 'handling'],
    ['open', 'false_alarm'],
    ['handling', 'closed'],
    ['handling', 'reported'],
    ['handling', 'false_alarm'],
    ['reported', 'closed'],
  ];
  it('只有表列的轉換合法，其他一律不行', () => {
    for (const from of ALARM_STATUSES) {
      for (const to of ALARM_STATUSES) {
        const ok = legal.some(([f, t]) => f === from && t === to);
        expect(canTransition(from, to), `${from} → ${to}`).toBe(ok);
      }
    }
  });
});

describe('初始狀態', () => {
  it('信心度低於門檻 → 待人工複判（不管是否需處理）', () => {
    expect(initialStatus({ need_handle: true }, 55, 70)).toBe('review');
    expect(initialStatus({ need_handle: false }, 55, 70)).toBe('review');
  });
  it('信心度足夠或沒有信心度：需處理 → open，否則 info', () => {
    expect(initialStatus({ need_handle: true }, 90, 70)).toBe('open');
    expect(initialStatus({ need_handle: true }, null, 70)).toBe('open');
    expect(initialStatus({ need_handle: false }, undefined, 70)).toBe('info');
    expect(initialStatus({ need_handle: true }, 70, 70)).toBe('open');
  });
});

describe('去重來源鍵', () => {
  it('機器人＞攝影機＞自訂＞樓層', () => {
    expect(sourceKey({ robotId: 'r', cameraId: 'c', source: 'task:1' })).toBe('robot:r');
    expect(sourceKey({ cameraId: 'c', source: 'task:1' })).toBe('camera:c');
    expect(sourceKey({ source: 'task:1', floorId: '1f' })).toBe('task:1');
    expect(sourceKey({ floorId: '1f' })).toBe('floor:1f');
  });
});
