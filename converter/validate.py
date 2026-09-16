from __future__ import annotations
from collections import Counter
from pathlib import Path
import random
import numpy as np
from .glb import read, accessor
from .math3d import compose_matrix
from .model import bounds, union_bounds


def validate(
    path: Path,
    manifest: dict,
    source_bbox: list,
    tolerance: float = 0.005,
    expected_instances: dict | None = None,
) -> tuple[dict, dict]:
    doc, binary = read(path)
    mapping = []
    errors = []
    boxes = []
    records = {}
    triangles = 0
    origins = [
        n.get("extras", {}).get("originMeters")
        for n in doc["nodes"]
        if "originMeters" in n.get("extras", {})
    ]
    origin = np.array(origins[0] if origins else [0, 0, 0])
    world: dict[int, np.ndarray] = {}

    def visit(ni: int, parent: np.ndarray) -> None:
        n = doc["nodes"][ni]
        local = (
            np.array(n["matrix"]).reshape(4, 4, order="F")
            if "matrix" in n
            else compose_matrix(
                np.array(n.get("translation", [0, 0, 0])),
                np.array(n.get("rotation", [0, 0, 0, 1])),
                np.array(n.get("scale", [1, 1, 1])),
            )
        )
        world[ni] = parent @ local
        for child in n.get("children", []):
            visit(child, world[ni])

    for ni in doc["scenes"][doc.get("scene", 0)]["nodes"]:
        visit(ni, np.eye(4))
    gltf_to_ifc = np.array(
        [[1, 0, 0, 0], [0, 0, -1, 0], [0, 1, 0, 0], [0, 0, 0, 1]], dtype=float
    )
    for v in doc["bufferViews"]:
        if v.get("byteOffset", 0) % 4 or v.get("byteOffset", 0) + v["byteLength"] > len(
            binary
        ):
            errors.append("BUFFER_VIEW_ALIGNMENT_OR_BOUNDS")
    for i, a in enumerate(doc["accessors"]):
        if "bufferView" not in a:
            continue
        data = accessor(doc, binary, i)
        if not np.isfinite(data).all():
            errors.append(f"NON_FINITE_ACCESSOR {i}")
        for key, fn in [("min", np.min), ("max", np.max)]:
            if key in a and not np.allclose(
                a[key], fn(data, axis=0), atol=1e-6, rtol=1e-6
            ):
                errors.append(f"ACCESSOR_{key.upper()} {i}")
    for ni, n in enumerate(doc["nodes"]):
        if "mesh" not in n:
            continue
        md = n.get("extras", {}).get("ifc")
        if not md:
            errors.append(f"MESH_WITHOUT_MAPPING {ni}")
            continue
        guids = md["instanceGuids"]
        ids = md["instanceExpressIds"]
        types = md["instanceTypes"]
        ext = n.get("extensions", {}).get("EXT_mesh_gpu_instancing")
        if not ext:
            errors.append(f"MISSING_INSTANCING {ni}")
            continue
        attributes = ext["attributes"]
        values = {k: accessor(doc, binary, v) for k, v in attributes.items()}
        count = len(values["TRANSLATION"])
        if (
            len(guids) != count
            or len(ids) != count
            or len(types) != count
            or any(len(v) != count for v in values.values())
        ):
            errors.append(f"INSTANCE_COUNT {ni}")
            continue
        positions = []
        for prim in doc["meshes"][n["mesh"]]["primitives"]:
            if "KHR_draco_mesh_compression" in prim.get("extensions", {}):
                raise ValueError("DECODE_GLB_BEFORE_GEOMETRY_VALIDATION")
            p = accessor(doc, binary, prim["attributes"]["POSITION"])
            indices = accessor(doc, binary, prim["indices"]).ravel()
            if len(indices) % 3 or indices.max(initial=0) >= len(p):
                errors.append(f"INVALID_INDICES {ni}")
            positions.append(p[np.unique(indices)])
            triangles += len(indices) // 3 * count
        p = np.concatenate(positions)
        for i, guid in enumerate(guids):
            mapping.append(guid)
            m = (
                gltf_to_ifc
                @ world[ni]
                @ compose_matrix(
                    values["TRANSLATION"][i], values["ROTATION"][i], values["SCALE"][i]
                )
            )
            boxes.append(bounds(p, m))
            record = {
                "node": ni,
                "mesh": n["mesh"],
                "instanceIndex": i,
                "expressId": ids[i],
                "ifcType": types[i],
                "geometryKey": md["geometryKey"],
            }
            records[guid] = record
            expected = manifest.get(guid)
            if expected is None or any(
                record[k] != expected[k]
                for k in ("expressId", "ifcType", "geometryKey", "instanceIndex")
            ):
                errors.append(f"INSTANCE_ORDER_OR_ID {guid}")
            if expected_instances is not None and guid in expected_instances:
                if not np.allclose(m, expected_instances[guid], atol=0.0001):
                    errors.append(f"INSTANCE_TRANSFORM {guid}")
    counts = Counter(mapping)
    missing = sorted(set(manifest) - set(mapping))
    extra = sorted(set(mapping) - set(manifest))
    duplicate = [g for g, n in counts.items() if n != 1]
    guid_status = (
        "PASS"
        if not missing
        and not extra
        and not duplicate
        and len(mapping) == len(manifest)
        and not errors
        else "FAIL"
    )
    gb = union_bounds(boxes) if boxes else np.zeros((2, 3))
    delta = float(np.max(np.abs(gb - np.array(source_bbox))))
    bbox_status = "PASS" if delta <= tolerance else "FAIL"
    sample = random.Random(20260916).sample(sorted(records), min(100, len(records)))
    roundtrip = {
        "status": guid_status,
        "ifcVisibleElements": len(manifest),
        "glbSelectableElements": len(mapping),
        "mappedGuids": len(mapping),
        "uniqueGuids": len(counts),
        "missingGuids": missing,
        "extraGuids": extra,
        "duplicateGuids": duplicate,
        "instanceOrderingErrors": errors,
        "sampleCount": len(sample),
        "sample": [{"guid": g, **records[g]} for g in sample],
    }
    report = {
        "status": "PASS" if guid_status == bbox_status == "PASS" else "FAIL",
        "guidMapping": roundtrip,
        "geometry": {
            "status": "PASS" if not errors else "FAIL",
            "errors": errors,
            "renderedTriangleCount": triangles,
        },
        "boundingBox": {
            "status": bbox_status,
            "sourceMeters": source_bbox,
            "glbMeters": gb.tolist(),
            "maxErrorMeters": delta,
            "toleranceMeters": tolerance,
        },
    }
    return report, roundtrip
