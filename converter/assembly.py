"""Representation-aware assembly overlap validation. Never silently loses bodies."""

from __future__ import annotations
from collections import Counter
import hashlib
import numpy as np
from .model import Group


def triangles(g: Group, express_id: int) -> Counter:
    i = g.express_ids.index(express_id)
    m = g.matrices[i]
    p = g.positions.astype(np.float64) @ m[:3, :3].T + m[:3, 3]
    quantized = np.rint(p[g.faces] * 1e6).astype("<i8")
    # Canonical vertex order makes face signatures independent of winding.
    result = Counter()
    for tri in quantized:
        order = np.lexsort((tri[:, 2], tri[:, 1], tri[:, 0]))
        result[hashlib.blake2b(tri[order].tobytes(), digest_size=16).digest()] += 1
    return result


def reconcile(
    decisions: list,
    geometry: dict[int, Group],
    manifest: dict,
    metadata: dict,
    skipped: list,
    errors: list,
) -> None:
    by_id = {d["expressId"]: d for d in decisions}

    def descendants(eid: int, seen: set[int]) -> set[int]:
        if eid in seen:
            raise ValueError("CYCLIC_ASSEMBLY")
        seen = seen | {eid}
        result = set()
        for child in by_id.get(eid, {}).get("children", []):
            if child in geometry:
                result.add(child)
            result.update(descendants(child, seen))
        return result

    for d in decisions:
        eid = d["expressId"]
        children = descendants(eid, set())
        if eid not in geometry or not children:
            continue
        own = triangles(geometry[eid], eid)
        nested = Counter()
        for child in children:
            nested.update(triangles(geometry[child], child))
        overlap = own & nested
        if not overlap:
            d["decision"] = "OWN_GEOMETRY_DISTINCT_FROM_CHILDREN"
            continue
        if overlap != own:
            errors.append(
                {
                    "stage": "assembly",
                    "expressId": eid,
                    "exception": "PARTIAL_ASSEMBLY_CHILD_GEOMETRY_OVERLAP",
                }
            )
            continue
        g = geometry[eid]
        i = g.express_ids.index(eid)
        guid = g.guids[i]
        for values in (g.guids, g.express_ids, g.types, g.matrices):
            values.pop(i)
        manifest.pop(guid)
        metadata.pop(guid, None)
        for j, remaining in enumerate(g.guids):
            manifest[remaining]["instanceIndex"] = j
        d["decision"] = "DUPLICATE_CHILD_GEOMETRY_SUPPRESSED"
        skipped.append(
            {
                "expressId": eid,
                "guid": guid,
                "reason": d["decision"],
                "matchingTriangleCount": sum(overlap.values()),
            }
        )
