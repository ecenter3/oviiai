import math

import pytest

from common.transform import MAX_RMSE_M, Affine2D, fit


def test_fit_recovers_rotation_and_translation():
    th = math.radians(30)
    true = Affine2D(math.cos(th), -math.sin(th), math.sin(th), math.cos(th), 4.0, -2.0)
    src = [(0, 0), (10, 0), (0, 8), (12, 9)]
    dst = [true.apply(x, y) for x, y in src]
    tf, rmse = fit(src, dst)
    assert rmse < 1e-9
    assert tf.rotation == pytest.approx(th)
    x, y = tf.apply(3, 3)
    assert (x, y) == pytest.approx(true.apply(3, 3))


def test_inverse_roundtrip():
    tf = Affine2D(0.9, -0.2, 0.3, 1.1, 5, 7)
    x, y = tf.inverse().apply(*tf.apply(1.5, -4))
    assert (x, y) == pytest.approx((1.5, -4))


def test_noisy_points_report_rmse():
    src = [(0, 0), (10, 0), (0, 10), (10, 10)]
    dst = [(0.3, 0), (10, 0.3), (0, 10), (10.4, 10)]
    _, rmse = fit(src, dst)
    assert 0 < rmse < MAX_RMSE_M


def test_needs_three_points():
    with pytest.raises(ValueError):
        fit([(0, 0), (1, 1)], [(0, 0), (1, 1)])


def test_fit_matches_shared_calibration_fixture():
    """與後端 calibration/affine.ts 讀同一份 fixtures/calibration.json（兩邊算出同樣的矩陣與 RMSE）"""
    import json
    from pathlib import Path

    from common.transform import fit as _fit

    data = json.loads((Path(__file__).resolve().parents[2] / "packages/contracts/fixtures/calibration.json").read_text(encoding="utf-8"))
    for case in data["cases"]:
        pts = case["points"]
        tf, rmse = _fit([(p["u"], p["v"]) for p in pts], [(p["x"], p["y"]) for p in pts])
        got = [tf.a, tf.b, tf.tx, tf.c, tf.d, tf.ty]
        assert all(abs(g - e) < 1e-4 for g, e in zip(got, case["matrix"])), case["name"]
        assert abs(rmse - case["rmseM"]) < 1e-3, case["name"]


def test_to_robot_from_backend_calib_is_inverse_of_matrix():
    from common.transform import Affine2D as A

    calib = {"mapId": "b1", "matrix": [0.866025, -0.5, 12, 0.5, 0.866025, -4]}
    to_robot = A.to_robot_from_calib(calib)
    to_platform = to_robot.inverse()
    x, y = to_platform.apply(7, -3)  # 機器人 (7,-3) → 平台
    assert abs(x - (0.866025 * 7 + 0.5 * 3 + 12)) < 1e-6
    u, v = to_robot.apply(x, y)
    assert abs(u - 7) < 1e-6 and abs(v + 3) < 1e-6
    assert A.to_robot_from_calib(None) == A()
