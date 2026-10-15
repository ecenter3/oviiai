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
