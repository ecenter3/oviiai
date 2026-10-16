import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { apply, CalibError, fitAffine, invert, MAX_RMSE_M } from './affine';

/** 地圖座標旋轉 30°、平移 (12, -4)，單位都是公尺 */
const truth = [Math.cos(Math.PI / 6), -Math.sin(Math.PI / 6), 12, Math.sin(Math.PI / 6), Math.cos(Math.PI / 6), -4];
const pts = (uv: [number, number][], noise = 0) =>
  uv.map(([u, v], i) => {
    const p = apply(truth, u, v);
    // 只有最後一點偏移：仿射轉換吸收不掉，殘差才會出現
    return { u, v, x: p.x + (i === uv.length - 1 ? noise : 0), y: p.y + (i === uv.length - 1 ? noise : 0) };
  });

describe('座標校正：仿射擬合（機器人接入 §6）', () => {
  it('精確的點：還原矩陣、RMSE 0、旋轉 30°、縮放 1', () => {
    const r = fitAffine(pts([[0, 0], [10, 0], [0, 10], [10, 10]]));
    r.matrix.forEach((v, i) => expect(v).toBeCloseTo(truth[i], 5));
    expect(r.rmseM).toBe(0);
    expect(r.rotationDeg).toBeCloseTo(30, 1);
    expect(r.scale).toBeCloseTo(1, 3);
  });

  it('有誤差時算出 RMSE 與每點誤差；超過 0.5 m 的判斷由呼叫端用 MAX_RMSE_M', () => {
    const ok = fitAffine(pts([[0, 0], [20, 0], [0, 20], [20, 20]], 0.6));
    expect(ok.rmseM).toBeGreaterThan(0.1);
    expect(ok.rmseM).toBeLessThanOrEqual(MAX_RMSE_M);
    expect(ok.residuals).toHaveLength(4);
    const bad = fitAffine(pts([[0, 0], [20, 0], [0, 20], [20, 20]], 2.5));
    expect(bad.rmseM).toBeGreaterThan(MAX_RMSE_M);
  });

  it('與 numpy lstsq（轉接器 transform.fit）同樣處理大座標', () => {
    const big = pts([[500, 300], [540, 300], [500, 340], [530, 335]]);
    const r = fitAffine(big);
    expect(r.rmseM).toBeLessThan(1e-3);
    r.matrix.forEach((v, i) => expect(v).toBeCloseTo(truth[i], 3));
  });

  it('點不足、共線 → 錯誤', () => {
    expect(() => fitAffine(pts([[0, 0], [1, 1]]))).toThrow(CalibError);
    expect(() => fitAffine(pts([[0, 0], [1, 1], [2, 2], [3, 3]]))).toThrow(/共線/);
  });

  it('反矩陣：平台 → 機器人 → 平台 回到原點', () => {
    const inv = invert(truth);
    const p = apply(truth, 7, -3);
    const back = apply(inv, p.x, p.y);
    expect(back.x).toBeCloseTo(7, 9);
    expect(back.y).toBeCloseTo(-3, 9);
  });
});

describe('與轉接器 transform.fit 一致（共用 fixtures/calibration.json）', () => {
  const fx = JSON.parse(readFileSync(resolve(__dirname, '../../../packages/contracts/fixtures/calibration.json'), 'utf8')) as {
    cases: { name: string; points: { u: number; v: number; x: number; y: number }[]; matrix: number[]; rmseM: number }[];
  };
  it.each(fx.cases.map((c) => [c.name, c] as const))('%s', (_n, c) => {
    const r = fitAffine(c.points);
    r.matrix.forEach((v, i) => expect(v).toBeCloseTo(c.matrix[i], 4));
    expect(r.rmseM).toBeCloseTo(c.rmseM, 3);
  });
});
