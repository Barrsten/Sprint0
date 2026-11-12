from __future__ import annotations
from dataclasses import dataclass, field
import hashlib
import json
from typing import Any
import numpy as np


@dataclass
class Group:
    key: str
    positions: np.ndarray
    faces: np.ndarray
    material_ids: np.ndarray
    materials: list[dict[str, Any]]
    guids: list[str] = field(default_factory=list)
    express_ids: list[int] = field(default_factory=list)
    types: list[str] = field(default_factory=list)
    matrices: list[np.ndarray] = field(default_factory=list)


def geometry_key(
    positions: np.ndarray, faces: np.ndarray, ids: np.ndarray, materials: list
) -> str:
    h = hashlib.sha256()
    for a in (positions.astype("<f4"), faces.astype("<u4"), ids.astype("<i4")):
        h.update(str(a.shape).encode())
        h.update(a.tobytes())
    h.update(json.dumps(materials, sort_keys=True, allow_nan=False).encode())
    return h.hexdigest()


def check_geometry(p: np.ndarray, f: np.ndarray) -> None:
    if not len(p) or not len(f):
        raise ValueError("EMPTY_GEOMETRY")
    if not np.isfinite(p).all():
        raise ValueError("NON_FINITE_VERTICES")
    if f.min() < 0 or f.max() >= len(p):
        raise ValueError("INVALID_TRIANGLE_INDEX")
    tri = p[f]
    areas = np.linalg.norm(
        np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0]), axis=1
    )
    n = int(np.count_nonzero(areas == 0))
    if n:
        raise ValueError(f"ZERO_AREA_TRIANGLES: {n}")


def drop_degenerate_triangles(
    p: np.ndarray, f: np.ndarray, ids: np.ndarray
) -> tuple[np.ndarray, np.ndarray, int]:
    """Remove zero-area triangles (same criterion as check_geometry).

    They cover no visible area, so removing them is lossless. An element whose
    triangles are all degenerate keeps them and still fails check_geometry.
    """
    if not len(f) or f.min() < 0 or f.max() >= len(p):
        return f, ids, 0
    tri = p[f]
    areas = np.linalg.norm(
        np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0]), axis=1
    )
    keep = areas != 0
    removed = int(len(f) - np.count_nonzero(keep))
    if not removed or removed == len(f):
        return f, ids, 0
    return f[keep].copy(), ids[keep].copy(), removed


def bounds(p: np.ndarray, m: np.ndarray) -> np.ndarray:
    v = p @ m[:3, :3].T + m[:3, 3]
    return np.array([v.min(axis=0), v.max(axis=0)])


def union_bounds(boxes: list[np.ndarray]) -> np.ndarray:
    return np.array(
        [np.min([b[0] for b in boxes], axis=0), np.max([b[1] for b in boxes], axis=0)]
    )
