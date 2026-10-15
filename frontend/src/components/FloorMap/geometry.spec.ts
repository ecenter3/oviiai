import { describe, expect, it } from 'vitest';
import { estimateSize, fit, fromScreen, gridStep, pan, robotTone, toScreen, yawToSvgDeg, ZOOM_MAX, ZOOM_MIN, zoomAt } from './geometry';

describe('平面圖座標換算', () => {
  const floor = { w: 40, h: 20 };
  const view = { w: 848, h: 448 };
  const vp = fit(floor, view, 24); // 800/40 = 20 px/m，400/20 = 20 px/m

  it('fit：整張圖放進畫面並置中', () => {
    expect(vp).toEqual({ scale: 20, tx: 24, ty: 24 });
  });

  it('平台座標原點在左下、y 向上：左下角 → 螢幕左下，右上角 → 螢幕右上', () => {
    expect(toScreen({ x: 0, y: 0 }, floor.h, vp)).toEqual({ x: 24, y: 424 });
    expect(toScreen({ x: 40, y: 20 }, floor.h, vp)).toEqual({ x: 824, y: 24 });
  });

  it('toScreen 與 fromScreen 互為反函數', () => {
    const v = { scale: 37.5, tx: -120, ty: 55 };
    for (const p of [{ x: 0, y: 0 }, { x: 12.34, y: 5.67 }, { x: 40, y: 20 }]) {
      const back = fromScreen(toScreen(p, floor.h, v), floor.h, v);
      expect(back.x).toBeCloseTo(p.x, 9);
      expect(back.y).toBeCloseTo(p.y, 9);
    }
  });

  it('以游標為中心縮放：游標下的那一點縮放後仍在游標下', () => {
    const at = { x: 300, y: 200 };
    const before = fromScreen(at, floor.h, vp);
    const z = zoomAt(vp, 2, at, vp.scale);
    expect(z.scale).toBe(40);
    const after = fromScreen(at, floor.h, z);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
  });

  it('縮放倍率限制在 fit 的 ZOOM_MIN～ZOOM_MAX 倍', () => {
    expect(zoomAt(vp, 1000, { x: 0, y: 0 }, vp.scale).scale).toBe(vp.scale * ZOOM_MAX);
    expect(zoomAt(vp, 0.001, { x: 0, y: 0 }, vp.scale).scale).toBe(vp.scale * ZOOM_MIN);
  });

  it('平移', () => {
    expect(pan(vp, 10, -5)).toEqual({ scale: 20, tx: 34, ty: 19 });
  });

  it('朝向：平台逆時針為正 → SVG 順時針為正', () => {
    expect(yawToSvgDeg(0)).toBeCloseTo(0);
    expect(yawToSvgDeg(Math.PI / 2)).toBeCloseTo(-90);
    expect(yawToSvgDeg(-Math.PI / 2)).toBeCloseTo(90);
  });

  it('未設定尺寸：以點位估算，至少 20 × 15 公尺', () => {
    expect(estimateSize([])).toEqual({ w: 20, h: 15 });
    expect(estimateSize([{ x: 30, y: 12 }, { x: 5, y: 5 }])).toEqual({ w: 36, h: 15 });
  });

  it('格線間距隨比例變化，線距至少 24 像素', () => {
    expect(gridStep(50)).toBe(0.5);
    expect(gridStep(20)).toBe(2);
    expect(gridStep(3)).toBe(10);
  });

  it('機器人顏色分類（原型配色）', () => {
    expect(robotTone('patrolling', true)).toBe('working');
    expect(robotTone('navigating', true)).toBe('working');
    expect(robotTone('idle', true)).toBe('idle');
    expect(robotTone('charging', true)).toBe('charge');
    expect(robotTone('teleop', true)).toBe('manual');
    expect(robotTone('estop', true)).toBe('estop');
    expect(robotTone('idle', false)).toBe('offline');
  });
});
