"""平台座標 <-> 機器人地圖座標（2D 仿射轉換）。

校正：在平面圖上點 >=3 個點，對應機器人實際走到該點時回報的地圖座標，
以最小平方法求仿射矩陣；RMSE 須 < 0.5 m 才允許儲存（系統規格書「座標校正」）。
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

MAX_RMSE_M = 0.5


@dataclass(frozen=True)
class Affine2D:
    """[x', y'] = A @ [x, y] + t"""

    a: float = 1.0
    b: float = 0.0
    c: float = 0.0
    d: float = 1.0
    tx: float = 0.0
    ty: float = 0.0

    @property
    def rotation(self) -> float:
        return math.atan2(self.c, self.a)

    def apply(self, x: float, y: float) -> tuple[float, float]:
        return self.a * x + self.b * y + self.tx, self.c * x + self.d * y + self.ty

    def apply_yaw(self, yaw: float) -> float:
        return _wrap(yaw + self.rotation)

    def inverse(self) -> Affine2D:
        det = self.a * self.d - self.b * self.c
        if abs(det) < 1e-12:
            raise ValueError("transform is not invertible")
        ia, ib, ic, id_ = self.d / det, -self.b / det, -self.c / det, self.a / det
        return Affine2D(ia, ib, ic, id_, -(ia * self.tx + ib * self.ty), -(ic * self.tx + id_ * self.ty))

    def to_dict(self) -> dict[str, float]:
        return {"a": self.a, "b": self.b, "c": self.c, "d": self.d, "tx": self.tx, "ty": self.ty}

    @classmethod
    def from_dict(cls, d: dict[str, float] | None) -> Affine2D:
        return cls(**d) if d else cls()

    @classmethod
    def to_robot_from_calib(cls, calib: dict | None) -> Affine2D:
        """後端 GET /adapter-config 的 calib.matrix = [a, b, tx, c, d, ty]（機器人 → 平台）
        → 轉接器要的 to_robot（平台 → 機器人）。沒有校正時不轉換。"""
        if not calib or not calib.get("matrix"):
            return cls()
        a, b, tx, c, d, ty = (float(v) for v in calib["matrix"])
        return cls(a, b, c, d, tx, ty).inverse()


def _wrap(angle: float) -> float:
    return (angle + math.pi) % (2 * math.pi) - math.pi


def fit(src: list[tuple[float, float]], dst: list[tuple[float, float]]) -> tuple[Affine2D, float]:
    """求把 src 轉到 dst 的仿射矩陣，回傳 (轉換, RMSE 公尺)。"""
    if len(src) != len(dst):
        raise ValueError("src and dst must have the same length")
    if len(src) < 3:
        raise ValueError("at least 3 point pairs are required")
    s = np.asarray(src, dtype=float)
    t = np.asarray(dst, dtype=float)
    m = np.hstack([s, np.ones((len(s), 1))])
    sol, *_ = np.linalg.lstsq(m, t, rcond=None)  # 3x2
    a, c = sol[0]
    b, d = sol[1]
    tx, ty = sol[2]
    tf = Affine2D(float(a), float(b), float(c), float(d), float(tx), float(ty))
    pred = m @ sol
    rmse = float(np.sqrt(np.mean(np.sum((pred - t) ** 2, axis=1))))
    return tf, rmse
