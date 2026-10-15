import { describe, expect, it } from 'vitest';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  it('reports status and every dependency', () => {
    const r = new HealthController().check();
    expect(r.status).toBe('ok');
    expect(Object.keys(r.checks).sort()).toEqual(['db', 'mediamtx', 'minio', 'mqtt', 'redis']);
  });
});
