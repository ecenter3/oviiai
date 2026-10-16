/**
 * 座標校正：機器人地圖座標 (u,v) → 平台座標 (x,y) 的仿射轉換（工程開發手冊「機器人接入」§6）。
 *   x = a·u + b·v + tx
 *   y = c·u + d·v + ty
 * 以最小平方法求解；矩陣存成 [a, b, tx, c, d, ty]（robot_map_calib.matrix，機器人 → 平台）。
 * 純函式，與轉接器 adapters/common/transform.py 的 fit() 結果相同。
 */
export const MAX_RMSE_M = 0.5;
export const MIN_POINTS = 3;

export interface CalibPoint {
  /** 機器人地圖座標 */
  u: number;
  v: number;
  /** 平台座標（平面圖上點的位置） */
  x: number;
  y: number;
}

export type Matrix = [number, number, number, number, number, number];

export interface FitResult {
  matrix: Matrix;
  rmseM: number;
  /** 每點誤差（公尺） */
  residuals: number[];
  /** 旋轉角（度）：yaw 換算時加上 atan2(c, a) */
  rotationDeg: number;
  /** 平均縮放（地圖單位不是公尺時會偏離 1） */
  scale: number;
}

export class CalibError extends Error {}

/** 解 3×3 線性方程（部分選主元高斯消去）；奇異回 null */
function solve3(m: number[][], r: number[]): number[] | null {
  const a = m.map((row, i) => [...row, r[i]]);
  for (let col = 0; col < 3; col++) {
    let piv = col;
    for (let i = col + 1; i < 3; i++) if (Math.abs(a[i][col]) > Math.abs(a[piv][col])) piv = i;
    if (Math.abs(a[piv][col]) < 1e-9) return null;
    [a[col], a[piv]] = [a[piv], a[col]];
    for (let i = 0; i < 3; i++) {
      if (i === col) continue;
      const f = a[i][col] / a[col][col];
      for (let j = col; j < 4; j++) a[i][j] -= f * a[col][j];
    }
  }
  return [a[0][3] / a[0][0], a[1][3] / a[1][1], a[2][3] / a[2][2]];
}

/** 最小平方擬合；點少於 3 個或共線（無法決定轉換）丟 CalibError */
export function fitAffine(points: CalibPoint[]): FitResult {
  if (points.length < MIN_POINTS) throw new CalibError(`至少要 ${MIN_POINTS} 組對應點`);
  // 正規方程：(AᵀA) p = Aᵀb，A 的每列為 [u, v, 1]
  const ata = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const atx = [0, 0, 0];
  const aty = [0, 0, 0];
  // 先平移到重心，數值較穩定（座標可能是數百公尺）
  const mu = points.reduce((s, p) => s + p.u, 0) / points.length;
  const mv = points.reduce((s, p) => s + p.v, 0) / points.length;
  for (const p of points) {
    const row = [p.u - mu, p.v - mv, 1];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) ata[i][j] += row[i] * row[j];
      atx[i] += row[i] * p.x;
      aty[i] += row[i] * p.y;
    }
  }
  const px = solve3(ata, atx);
  const py = solve3(ata, aty);
  if (!px || !py) throw new CalibError('對應點共線或太集中，請選分散、不在同一直線上的位置');
  // 還原重心平移
  const matrix: Matrix = [px[0], px[1], px[2] - px[0] * mu - px[1] * mv, py[0], py[1], py[2] - py[0] * mu - py[1] * mv];
  const residuals = points.map((p) => {
    const q = apply(matrix, p.u, p.v);
    return Math.hypot(q.x - p.x, q.y - p.y);
  });
  const rmseM = Math.sqrt(residuals.reduce((s, r) => s + r * r, 0) / residuals.length);
  const [a, b, , c, d] = matrix;
  return {
    matrix: matrix.map(round6) as Matrix,
    rmseM: Math.round(rmseM * 1000) / 1000,
    residuals: residuals.map((r) => Math.round(r * 1000) / 1000),
    rotationDeg: Math.round((Math.atan2(c, a) * 180) / Math.PI * 100) / 100,
    scale: Math.round(Math.sqrt(Math.abs(a * d - b * c)) * 1000) / 1000,
  };
}

/** 機器人 → 平台 */
export function apply(m: readonly number[], u: number, v: number): { x: number; y: number } {
  return { x: m[0] * u + m[1] * v + m[2], y: m[3] * u + m[4] * v + m[5] };
}

/** 反矩陣（平台 → 機器人） */
export function invert(m: readonly number[]): Matrix {
  const [a, b, tx, c, d, ty] = m;
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-12) throw new CalibError('轉換不可逆');
  const ia = d / det;
  const ib = -b / det;
  const ic = -c / det;
  const id = a / det;
  return [ia, ib, -(ia * tx + ib * ty), ic, id, -(ic * tx + id * ty)];
}

const round6 = (v: number) => Math.round(v * 1e6) / 1e6;
