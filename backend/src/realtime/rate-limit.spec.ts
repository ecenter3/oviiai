import { describe, expect, it } from 'vitest';
import { TokenBucket } from './rate-limit';

describe('TokenBucket（teleop.cmd 20 Hz）', () => {
  it('正常 10 Hz 全部通過', () => {
    const b = new TokenBucket(20, 5, 0);
    let ok = 0;
    for (let t = 0; t < 10_000; t += 100) if (b.take(t)) ok++;
    expect(ok).toBe(100);
  });

  it('惡意灌 1000 Hz：一秒最多約 20＋5（初始可連發）筆', () => {
    const b = new TokenBucket(20, 5, 0);
    let ok = 0;
    for (let t = 0; t < 1000; t += 1) if (b.take(t)) ok++;
    expect(ok).toBeLessThanOrEqual(25);
    expect(ok).toBeGreaterThanOrEqual(20);
  });

  it('長時間平均不超過 20 Hz', () => {
    const b = new TokenBucket(20, 5, 0);
    let ok = 0;
    for (let t = 0; t < 60_000; t += 5) if (b.take(t)) ok++;
    expect(ok / 60).toBeLessThanOrEqual(20.1);
  });

  it('網路抖動：兩筆擠在一起也通過', () => {
    const b = new TokenBucket(20, 5, 0);
    expect([b.take(100), b.take(101), b.take(200), b.take(201)]).toEqual([true, true, true, true]);
  });
});
