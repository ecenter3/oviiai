import { describe, expect, it } from 'vitest';
import type { Database } from '../db/database.module';
import { TelemetryWriter } from './telemetry-writer';

function fakeDb(fail = false) {
  const inserted: unknown[][] = [];
  const db = {
    insertInto: () => ({
      values: (v: unknown[]) => ({
        execute: async () => {
          if (fail) throw new Error('db down');
          inserted.push(v);
        },
      }),
    }),
  } as unknown as Database;
  return { db, inserted };
}

const row = (robot: string, ms: number) => ({ at: new Date(ms), robot_id: robot, x: 0, y: 0, yaw: 0 });

describe('TelemetryWriter', () => {
  it('每台每秒最多一筆，flush 一次批次寫入', async () => {
    const { db, inserted } = fakeDb();
    const w = new TelemetryWriter(db);
    expect(w.add(row('a', 1000))).toBe(true);
    expect(w.add(row('a', 1500))).toBe(false);
    expect(w.add(row('b', 1500))).toBe(true);
    expect(w.add(row('a', 2000))).toBe(true);
    expect(await w.flush()).toBe(3);
    expect(inserted).toHaveLength(1);
    expect(await w.flush()).toBe(0);
  });

  it('資料庫寫不進去時保留到下次', async () => {
    const bad = fakeDb(true);
    const w = new TelemetryWriter(bad.db);
    w.add(row('a', 1000));
    expect(await w.flush()).toBe(0);
    const good = fakeDb();
    (w as unknown as { db: Database }).db = good.db;
    expect(await w.flush()).toBe(1);
  });
});
