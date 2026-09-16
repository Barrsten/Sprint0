from __future__ import annotations

import math
import numpy as np


def decompose_matrix(matrix: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Decompose a 4x4 affine matrix into translation, quaternion xyzw, and scale.

    IFC placements are normally rigid transforms. Negative scale/reflection is
    handled by putting the sign on X so the reconstructed matrix keeps its
    handedness.
    """
    m = np.asarray(matrix, dtype=np.float64).reshape(4, 4)
    t = m[:3, 3].copy()
    basis = m[:3, :3].copy()

    sx = float(np.linalg.norm(basis[:, 0]))
    sy = float(np.linalg.norm(basis[:, 1]))
    sz = float(np.linalg.norm(basis[:, 2]))
    if min(sx, sy, sz) < 1e-12:
        raise ValueError("Degenerate transform: zero scale axis")

    r = basis.copy()
    r[:, 0] /= sx
    r[:, 1] /= sy
    r[:, 2] /= sz

    if np.linalg.det(r) < 0.0:
        sx = -sx
        r[:, 0] *= -1.0

    # Stabilize small numerical drift from IFC placement calculations.
    u, _, vh = np.linalg.svd(r)
    r = u @ vh
    if np.linalg.det(r) < 0.0:
        u[:, -1] *= -1.0
        r = u @ vh

    q = rotation_matrix_to_quaternion(r)
    s = np.array([sx, sy, sz], dtype=np.float64)
    return t, q, s


def rotation_matrix_to_quaternion(r: np.ndarray) -> np.ndarray:
    """3x3 rotation matrix -> normalized quaternion [x,y,z,w]."""
    r = np.asarray(r, dtype=np.float64).reshape(3, 3)
    trace = float(np.trace(r))
    if trace > 0.0:
        s = math.sqrt(trace + 1.0) * 2.0
        qw = 0.25 * s
        qx = (r[2, 1] - r[1, 2]) / s
        qy = (r[0, 2] - r[2, 0]) / s
        qz = (r[1, 0] - r[0, 1]) / s
    elif r[0, 0] > r[1, 1] and r[0, 0] > r[2, 2]:
        s = math.sqrt(1.0 + r[0, 0] - r[1, 1] - r[2, 2]) * 2.0
        qw = (r[2, 1] - r[1, 2]) / s
        qx = 0.25 * s
        qy = (r[0, 1] + r[1, 0]) / s
        qz = (r[0, 2] + r[2, 0]) / s
    elif r[1, 1] > r[2, 2]:
        s = math.sqrt(1.0 + r[1, 1] - r[0, 0] - r[2, 2]) * 2.0
        qw = (r[0, 2] - r[2, 0]) / s
        qx = (r[0, 1] + r[1, 0]) / s
        qy = 0.25 * s
        qz = (r[1, 2] + r[2, 1]) / s
    else:
        s = math.sqrt(1.0 + r[2, 2] - r[0, 0] - r[1, 1]) * 2.0
        qw = (r[1, 0] - r[0, 1]) / s
        qx = (r[0, 2] + r[2, 0]) / s
        qy = (r[1, 2] + r[2, 1]) / s
        qz = 0.25 * s
    q = np.array([qx, qy, qz, qw], dtype=np.float64)
    q /= np.linalg.norm(q)
    return q


def compose_matrix(t: np.ndarray, q: np.ndarray, s: np.ndarray) -> np.ndarray:
    """Used by tests and diagnostics."""
    x, y, z, w = map(float, q)
    xx, yy, zz = x * x, y * y, z * z
    xy, xz, yz = x * y, x * z, y * z
    wx, wy, wz = w * x, w * y, w * z
    r = np.array(
        [
            [1 - 2 * (yy + zz), 2 * (xy - wz), 2 * (xz + wy)],
            [2 * (xy + wz), 1 - 2 * (xx + zz), 2 * (yz - wx)],
            [2 * (xz - wy), 2 * (yz + wx), 1 - 2 * (xx + yy)],
        ],
        dtype=np.float64,
    )
    out = np.eye(4, dtype=np.float64)
    out[:3, :3] = r @ np.diag(np.asarray(s, dtype=np.float64))
    out[:3, 3] = np.asarray(t, dtype=np.float64)
    return out
