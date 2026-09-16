from __future__ import annotations
import json
import struct
from pathlib import Path
import numpy as np
from .model import Group
from .math3d import decompose_matrix, compose_matrix


class Builder:
    def __init__(self) -> None:
        self.data = bytearray()
        self.doc = {
            "asset": {"version": "2.0", "generator": "Kontur2 Sprint0"},
            "scene": 0,
            "scenes": [{"nodes": [0]}],
            "nodes": [
                {
                    "name": "IFC Z-up to glTF Y-up",
                    "rotation": [-(2**-0.5), 0, 0, 2**-0.5],
                    "children": [],
                }
            ],
            "meshes": [],
            "materials": [],
            "accessors": [],
            "bufferViews": [],
            "buffers": [],
            "extensionsUsed": ["EXT_mesh_gpu_instancing"],
            "extensionsRequired": ["EXT_mesh_gpu_instancing"],
        }

    def accessor(self, a: np.ndarray, kind: str, target: int | None = None) -> int:
        a = np.ascontiguousarray(a)
        a = a.astype("<f4" if a.dtype.kind == "f" else "<u4")
        self.data.extend(b"\x00" * (-len(self.data) % 4))
        v = {"buffer": 0, "byteOffset": len(self.data), "byteLength": a.nbytes}
        if target:
            v["target"] = target
        self.doc["bufferViews"].append(v)
        self.data.extend(a.tobytes())
        d = {
            "bufferView": len(self.doc["bufferViews"]) - 1,
            "byteOffset": 0,
            "componentType": 5126 if a.dtype.kind == "f" else 5125,
            "count": len(a),
            "type": kind,
        }
        vals = a.reshape(len(a), -1)
        d["min"] = vals.min(axis=0).tolist()
        d["max"] = vals.max(axis=0).tolist()
        self.doc["accessors"].append(d)
        return len(self.doc["accessors"]) - 1

    def write(self, path: Path) -> None:
        self.doc["buffers"] = [{"byteLength": len(self.data)}]
        js = json.dumps(
            self.doc, ensure_ascii=False, separators=(",", ":"), allow_nan=False
        ).encode()
        js += b" " * (-len(js) % 4)
        self.data.extend(b"\x00" * (-len(self.data) % 4))
        with path.open("wb") as out:
            out.write(
                struct.pack("<4sII", b"glTF", 2, 12 + 8 + len(js) + 8 + len(self.data))
            )
            out.write(struct.pack("<I4s", len(js), b"JSON"))
            out.write(js)
            out.write(struct.pack("<I4s", len(self.data), b"BIN\x00"))
            out.write(self.data)


def build(groups: list[Group], path: Path, origin: np.ndarray, source: dict) -> dict:
    b = Builder()
    b.doc["nodes"][0]["translation"] = [
        float(origin[0]),
        float(origin[2]),
        float(-origin[1]),
    ]
    b.doc["nodes"][0]["extras"] = {"ifcSource": source, "originMeters": origin.tolist()}
    mats: dict[str, int] = {}
    for group in groups:
        pos = b.accessor(group.positions, "VEC3", 34962)
        primitives = []
        for mid in np.unique(group.material_ids):
            material = group.materials[int(mid)]
            key = json.dumps(material, sort_keys=True)
            if key not in mats:
                mats[key] = len(b.doc["materials"])
                b.doc["materials"].append(material)
            indices = group.faces[group.material_ids == mid].reshape(-1)
            primitives.append(
                {
                    "attributes": {"POSITION": pos},
                    "indices": b.accessor(indices, "SCALAR", 34963),
                    "material": mats[key],
                    "mode": 4,
                }
            )
        b.doc["meshes"].append({"name": group.key, "primitives": primitives})
        trs = []
        for matrix in group.matrices:
            t, q, s = decompose_matrix(matrix)
            if not np.allclose(compose_matrix(t, q, s), matrix, atol=1e-7):
                raise ValueError("NON_TRS_TRANSFORM")
            trs.append((t - origin, q, s))
        attrs = {
            key: b.accessor(np.array([v[i] for v in trs]), typ)
            for i, (key, typ) in enumerate(
                (("TRANSLATION", "VEC3"), ("ROTATION", "VEC4"), ("SCALE", "VEC3"))
            )
        }
        node = {
            "name": "IFC " + group.key[:12],
            "mesh": len(b.doc["meshes"]) - 1,
            "extensions": {"EXT_mesh_gpu_instancing": {"attributes": attrs}},
            "extras": {
                "ifc": {
                    "geometryKey": group.key,
                    "instanceGuids": group.guids,
                    "instanceExpressIds": group.express_ids,
                    "instanceTypes": group.types,
                }
            },
        }
        b.doc["nodes"][0]["children"].append(len(b.doc["nodes"]))
        b.doc["nodes"].append(node)
    b.write(path)
    return b.doc


def read(path: Path) -> tuple[dict, bytes]:
    data = path.read_bytes()
    magic, version, size = struct.unpack_from("<4sII", data)
    if magic != b"glTF" or version != 2 or size != len(data):
        raise ValueError("INVALID_GLB_HEADER")
    n, tag = struct.unpack_from("<I4s", data, 12)
    if tag != b"JSON" or n % 4:
        raise ValueError("INVALID_JSON_CHUNK")
    doc = json.loads(data[20 : 20 + n])
    offset = 20 + n
    bn, tag = struct.unpack_from("<I4s", data, offset)
    if tag != b"BIN\x00" or bn % 4 or offset + 8 + bn != size:
        raise ValueError("INVALID_BIN_CHUNK")
    return doc, data[offset + 8 :]


def accessor(doc: dict, binary: bytes, index: int) -> np.ndarray:
    a = doc["accessors"][index]
    v = doc["bufferViews"][a["bufferView"]]
    dtype = {5126: "<f4", 5125: "<u4", 5123: "<u2", 5121: "u1"}[a["componentType"]]
    width = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}[a["type"]]
    offset = v.get("byteOffset", 0) + a.get("byteOffset", 0)
    stride = v.get("byteStride", np.dtype(dtype).itemsize * width)
    end = offset + (a["count"] - 1) * stride + width * np.dtype(dtype).itemsize
    if end > v.get("byteOffset", 0) + v["byteLength"]:
        raise ValueError("ACCESSOR_OUT_OF_BOUNDS")
    return np.ndarray(
        (a["count"], width),
        dtype=dtype,
        buffer=binary,
        offset=offset,
        strides=(stride, np.dtype(dtype).itemsize),
    )
