from __future__ import annotations
import json
import os
from pathlib import Path
import resource
import subprocess
from time import perf_counter
from datetime import datetime, timezone
import numpy as np
from .extract import extract
from .glb import build
from .validate import validate


def write_json(path: Path, value: object) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False),
        encoding="utf8",
    )
    tmp.replace(path)


def convert(
    source: Path,
    output: Path,
    workers: int = 4,
    draco: bool = True,
    draco_level: int = 7,
    metadata: bool = True,
) -> dict:
    output.mkdir(parents=True, exist_ok=True)
    start = perf_counter()
    report = {
        "status": "RUNNING",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "sourcePath": str(source.resolve()),
        "sourceSizeBytes": None,
        "workers": workers,
        "warnings": [],
        "errors": [],
        "skippedIfcObjects": [],
    }
    stage = "parse"

    def mark(s: str) -> None:
        nonlocal stage
        stage = s
        write_json(output / "stage.json", {"stage": s})

    try:
        mark("parse")
        report["sourceSizeBytes"] = source.stat().st_size
        with source.open("rb") as stream:
            header = stream.read(4096)
            stream.seek(max(0, source.stat().st_size - 4096))
            tail = stream.read()
        if b"ISO-10303-21;" not in header or b"END-ISO-10303-21;" not in tail:
            raise ValueError("INVALID_OR_TRUNCATED_IFC_ENVELOPE")
        groups, md, manifest = extract(source, workers, metadata, report, on_stage=mark)
        write_json(output / "source-manifest.json", manifest)
        if metadata:
            write_json(output / "metadata.json", md)
        origin = np.mean(np.array(report["sourceBoundingBoxMeters"]), axis=0)
        mark("glb")
        t = perf_counter()
        build(
            groups,
            output / "model.raw.glb",
            origin,
            {"file": source.name, "units": "m"},
        )
        report["glbBuildTimeSeconds"] = perf_counter() - t
        report["rawGlbSizeBytes"] = (output / "model.raw.glb").stat().st_size
        expected = {
            guid: g.matrices[i] for g in groups for i, guid in enumerate(g.guids)
        }
        mark("raw-validation")
        validation, roundtrip = validate(
            output / "model.raw.glb",
            manifest,
            report["sourceBoundingBoxMeters"],
            expected_instances=expected,
        )
        write_json(output / "raw-validation-report.json", validation)
        if (
            validation["status"] != "PASS"
            or validation["geometry"]["renderedTriangleCount"]
            != report["triangleCount"]
        ):
            raise ValueError("RAW_GLB_VALIDATION_FAILED")
        report["dracoTimeSeconds"] = 0
        if draco:
            mark("draco")
            t = perf_counter()
            script = Path(__file__).resolve().parents[1] / "scripts/draco.mjs"
            subprocess.run(
                [
                    "node",
                    str(script),
                    str((output / "model.raw.glb").resolve()),
                    str((output / "model.glb").resolve()),
                    str(draco_level),
                ],
                check=True,
            )
            report["dracoTimeSeconds"] = perf_counter() - t
            mark("draco-validation")
            validation, roundtrip = validate(
                output / "model.decoded.glb",
                manifest,
                report["sourceBoundingBoxMeters"],
                expected_instances=expected,
            )
            # Check mapping directly in compressed GLB, not only the decoded copy.
            from .glb import read

            compressed, _ = read(output / "model.glb")
            decoded, _ = read(output / "model.decoded.glb")
            mapping = lambda d: [
                n["extras"]["ifc"] for n in d["nodes"] if "ifc" in n.get("extras", {})
            ]
            if mapping(compressed) != mapping(decoded):
                raise ValueError("DRACO_EXTRAS_MAPPING_CHANGED")
            report["dracoGlbSizeBytes"] = (output / "model.glb").stat().st_size
            report["compressionRatio"] = (
                report["rawGlbSizeBytes"] / report["dracoGlbSizeBytes"]
            )
        else:
            import shutil

            shutil.copy2(output / "model.raw.glb", output / "model.glb")
            report["dracoGlbSizeBytes"] = None
            report["compressionRatio"] = None
        write_json(output / "validation-report.json", validation)
        write_json(output / "guid-roundtrip-report.json", roundtrip)
        if (
            validation["status"] != "PASS"
            or validation["geometry"]["renderedTriangleCount"]
            != report["triangleCount"]
        ):
            raise ValueError("FINAL_VALIDATION_FAILED")
        report["status"] = "SUCCESS"
        mark("complete")
    except Exception as exc:
        report["status"] = "FAIL"
        report["errors"].append({"stage": stage, "exception": repr(exc)})
        write_json(output / "failure.json", {"stage": stage, "exception": repr(exc)})
        for filename in ("validation-report.json", "guid-roundtrip-report.json"):
            if not (output / filename).exists():
                write_json(
                    output / filename,
                    {
                        "status": "FAIL",
                        "reason": "CONVERSION_INCOMPLETE",
                        "stage": stage,
                        "errors": report["errors"],
                    },
                )
        raise
    finally:
        report["totalConversionTimeSeconds"] = perf_counter() - start
        report["peakRssMiB"] = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024
        report["peakRssScope"] = (
            "converter worker high-water mark; excludes Draco child"
        )
        report["dracoPositionQuantizationBits"] = 16 if draco else None
        write_json(output / "conversion-report.json", report)
    return report
