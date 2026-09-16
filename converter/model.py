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


def bounds(p: np.ndarray, m: np.ndarray) -> np.ndarray:
    v = p @ m[:3, :3].T + m[:3, 3]
    return np.array([v.min(axis=0), v.max(axis=0)])


def union_bounds(boxes: list[np.ndarray]) -> np.ndarray:
    return np.array(
        [np.min([b[0] for b in boxes], axis=0), np.max([b[1] for b in boxes], axis=0)]
    )
