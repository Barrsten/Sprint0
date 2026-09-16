from pathlib import Path
import json
import struct
import numpy as np
import pytest
from converter.math3d import compose_matrix, decompose_matrix
from converter.metadata import sanitize
from converter.model import geometry_key, check_geometry, Group
from converter.glb import Builder, read, accessor, build
from converter.validate import validate
from converter.pipeline import convert
from scripts.fixture import create


@pytest.mark.parametrize("scale", [(1, 1, 1), (-1, 1, 1), (2, 0.5, 3)])
def test_transform_roundtrip(scale):
    q = np.array([0.1, 0.2, 0.3, 0.9])
    q /= np.linalg.norm(q)
    m = compose_matrix(np.array([20, 50, -30]), q, np.array(scale))
    assert np.allclose(compose_matrix(*decompose_matrix(m)), m)


def test_cycle_wrapped_unicode_nonfinite():
    import ifcopenshell

    value = {
        "Марка": ifcopenshell.file().create_entity("IfcLabel", "Сталь"),
        "nan": float("nan"),
        "tuple": (1, None),
    }
    value["cycle"] = value
    result = sanitize(value)
    json.dumps(result, allow_nan=False)
    assert result["Марка"] == "Сталь"
    assert result["cycle"] == {"reference": "cycle"}


def test_geometry_grouping_appearance_sensitive():
    p = np.zeros((3, 3), dtype=np.float32)
    f = np.array([[0, 1, 2]])
    ids = np.array([0])
    assert geometry_key(p, f, ids, [{"color": 1}]) == geometry_key(
        p.copy(), f, ids, [{"color": 1}]
    )
    assert geometry_key(p, f, ids, [{"color": 1}]) != geometry_key(
        p, f, ids, [{"color": 2}]
    )


@pytest.mark.parametrize(
    "p,f",
    [
        (np.zeros((3, 3)), np.array([[0, 1, 5]])),
        (np.zeros((3, 3)), np.array([[0, 1, 2]])),
        (np.array([[np.nan, 0, 0], [1, 0, 0], [0, 1, 0]]), np.array([[0, 1, 2]])),
    ],
)
def test_invalid_geometry_is_fatal(p, f):
    with pytest.raises(ValueError):
        check_geometry(p, f)


def test_glb_alignment_accessors(tmp_path):
    b = Builder()
    index = b.accessor(np.array([[0.0, 1.0, 2.0], [3.0, 4.0, 5.0]]), "VEC3", 34962)
    path = tmp_path / "a.glb"
    b.write(path)
    d, bin = read(path)
    assert len(path.read_bytes()) % 4 == 0
    assert np.array_equal(accessor(d, bin, index), [[0, 1, 2], [3, 4, 5]])
    d["accessors"][index]["count"] = 100
    with pytest.raises(ValueError):
        accessor(d, bin, index)


@pytest.mark.parametrize("mm", [False, True])
def test_ifc_guid_units_and_assembly(tmp_path, mm):
    source = tmp_path / "small.ifc"
    fixture = create(source, millimeters=mm)
    out = tmp_path / "out"
    r = convert(source, out, workers=1, draco=False)
    assert r["visibleElements"] == 5
    assert r["uniqueGeometries"] == 1
    assert r["triangleCount"] == 60
    assert np.allclose(
        r["sourceBoundingBoxMeters"], [[9.85, 19.75, 0], [16.15, 23.25, 3]]
    )
    mapping = json.loads((out / "source-manifest.json").read_text())
    assert set(mapping) == set(fixture["visibleGuids"])
    report = json.loads((out / "guid-roundtrip-report.json").read_text())
    assert report["status"] == "PASS"
    md = json.loads((out / "metadata.json").read_text())
    assert any(e["propertySets"] for e in md["elements"].values())
    doc, binary = read(out / "model.glb")
    node = next(n for n in doc["nodes"] if "mesh" in n)
    node["extras"]["ifc"]["instanceGuids"][0] = "MISSING"
    # Rewrite JSON with real unchanged BIN, then ensure validator fails.
    js = json.dumps(doc).encode()
    js += b" " * (-len(js) % 4)
    (out / "tampered.glb").write_bytes(
        struct.pack("<4sII", b"glTF", 2, 28 + len(js) + len(binary))
        + struct.pack("<I4s", len(js), b"JSON")
        + js
        + struct.pack("<I4s", len(binary), b"BIN\0")
        + binary
    )
    validation, _ = validate(
        out / "tampered.glb", mapping, r["sourceBoundingBoxMeters"]
    )
    assert validation["status"] == "FAIL"


def test_missing_guid_fails(tmp_path):
    import ifcopenshell

    source = tmp_path / "bad.ifc"
    create(source)
    f = ifcopenshell.open(source)
    f.by_type("IfcBeam")[0].GlobalId = ""
    f.write(source)
    with pytest.raises(ValueError):
        convert(source, tmp_path / "out", workers=1, draco=False)


def test_draco_roundtrip(tmp_path):
    source = tmp_path / "small.ifc"
    create(source)
    out = tmp_path / "out"
    convert(source, out, workers=1, draco=True)
    r = json.loads((out / "validation-report.json").read_text())
    assert r["status"] == "PASS"
    doc, _ = read(out / "model.glb")
    assert "KHR_draco_mesh_compression" in doc["extensionsRequired"]


def test_assembly_duplicate_own_shape_is_suppressed(tmp_path):
    import ifcopenshell

    source = tmp_path / "assembly.ifc"
    create(source)
    f = ifcopenshell.open(source)
    container = next(
        e for e in f.by_type("IfcElementAssembly") if e.Name == "Container"
    )
    container.Representation = f.by_type("IfcBeam")[0].Representation
    f.write(source)
    out = tmp_path / "out"
    r = convert(source, out, workers=1, draco=False)
    assert r["visibleElements"] == 5
    assert (
        next(x for x in r["assemblyDecisions"] if x["expressId"] == container.id())[
            "decision"
        ]
        == "DUPLICATE_CHILD_GEOMETRY_SUPPRESSED"
    )


def test_assembly_distinct_own_shape_is_retained(tmp_path):
    import ifcopenshell

    source = tmp_path / "assembly.ifc"
    create(source)
    f = ifcopenshell.open(source)
    container = next(
        e for e in f.by_type("IfcElementAssembly") if e.Name == "Container"
    )
    container.Representation = f.by_type("IfcBeam")[0].Representation
    # Separate own placement, children already retain their original parent placement.
    container.ObjectPlacement = f.by_type("IfcElementAssembly")[1].ObjectPlacement
    f.write(source)
    r = convert(source, tmp_path / "out", workers=1, draco=False)
    assert r["visibleElements"] == 6
    assert (
        next(x for x in r["assemblyDecisions"] if x["expressId"] == container.id())[
            "decision"
        ]
        == "OWN_GEOMETRY_DISTINCT_FROM_CHILDREN"
    )


def test_uint32_large_index_and_material_primitives(tmp_path):
    from converter.model import geometry_key

    p = np.zeros((70000, 3), dtype=np.float32)
    p[69997:] = [[0, 0, 0], [1, 0, 0], [0, 1, 0]]
    f = np.array([[69997, 69998, 69999], [0, 69998, 69999]], dtype=np.uint32)
    ids = np.array([0, 1])
    mats = [{"doubleSided": True}, {"doubleSided": False}]
    g = Group(
        geometry_key(p, f, ids, mats),
        p,
        f,
        ids,
        mats,
        ["G" * 22],
        [10],
        ["IfcBeam"],
        [np.eye(4)],
    )
    path = tmp_path / "model.glb"
    d = build([g], path, np.zeros(3), {})
    doc, binary = read(path)
    assert len(doc["meshes"][0]["primitives"]) == 2
    acc = doc["meshes"][0]["primitives"][0]["indices"]
    assert doc["accessors"][acc]["componentType"] == 5125
    assert accessor(doc, binary, acc).max() == 69999


def test_duplicate_guid_fails(tmp_path):
    import ifcopenshell

    source = tmp_path / "bad.ifc"
    create(source)
    f = ifcopenshell.open(source)
    beams = f.by_type("IfcBeam")
    beams[1].GlobalId = beams[0].GlobalId
    f.write(source)
    with pytest.raises(ValueError, match="GEOMETRY_VALIDATION_FAILED"):
        convert(source, tmp_path / "out", workers=1, draco=False)
