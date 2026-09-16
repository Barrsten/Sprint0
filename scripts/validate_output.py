"""Independent acceptance: re-open original IFC and validate exported GLB."""

from pathlib import Path
import argparse, json
import ifcopenshell
from converter.extract import excluded, body_representations
from converter.validate import validate
from converter.pipeline import write_json


def main():
    p = argparse.ArgumentParser()
    p.add_argument("ifc", type=Path)
    p.add_argument("output", type=Path)
    a = p.parse_args()
    report = json.loads((a.output / "conversion-report.json").read_text())
    manifest = json.loads((a.output / "source-manifest.json").read_text())
    f = ifcopenshell.open(a.ifc)
    suppressed = {
        x["expressId"]
        for x in report["skippedIfcObjects"]
        if x["reason"] == "DUPLICATE_CHILD_GEOMETRY_SUPPRESSED"
    }
    products = [
        e
        for e in f.by_type("IfcProduct")
        if not excluded(e) and body_representations(e) and e.id() not in suppressed
    ]
    guids = [e.GlobalId for e in products]
    if len(guids) != len(set(guids)) or set(guids) != set(manifest):
        raise ValueError("INDEPENDENT_IFC_GUID_SET_MISMATCH")
    for e in products:
        if (
            manifest[e.GlobalId]["expressId"] != e.id()
            or manifest[e.GlobalId]["ifcType"] != e.is_a()
        ):
            raise ValueError("INDEPENDENT_IFC_ID_MISMATCH")
    glb = a.output / (
        "model.decoded.glb" if report["dracoGlbSizeBytes"] else "model.glb"
    )
    validation, roundtrip = validate(glb, manifest, report["sourceBoundingBoxMeters"])
    validation["independentIfcReopen"] = {
        "status": "PASS",
        "sourceProducts": len(products),
        "sourceUniqueGuids": len(set(guids)),
    }
    write_json(a.output / "independent-validation-report.json", validation)
    print(
        json.dumps(
            {
                "status": validation["status"],
                "sourceGuidCount": len(guids),
                "missing": len(roundtrip["missingGuids"]),
                "duplicates": len(roundtrip["duplicateGuids"]),
            }
        )
    )
    raise SystemExit(0 if validation["status"] == "PASS" else 1)


if __name__ == "__main__":
    main()
