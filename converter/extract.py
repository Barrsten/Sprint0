from __future__ import annotations
from collections import Counter
from pathlib import Path
from time import perf_counter
from typing import Any
import logging
import numpy as np
from .model import Group, geometry_key, check_geometry, bounds, union_bounds
from .metadata import element_metadata
from .math3d import decompose_matrix, compose_matrix

log = logging.getLogger(__name__)


def excluded(e: Any) -> str | None:
    if e.is_a("IfcSpatialElement") or e.is_a("IfcSpatialStructureElement"):
        return "SPATIAL_CONTAINER"
    if e.is_a("IfcFeatureElementSubtraction"):
        return "VOID_OR_OPENING"
    if e.is_a("IfcAnnotation") or e.is_a("IfcGrid"):
        return "NON_PHYSICAL_ANNOTATION_OR_GRID"
    return None


def body_representations(e: Any) -> list:
    if not e.Representation:
        return []
    return [
        r
        for r in e.Representation.Representations
        if r.Items
        and r.RepresentationIdentifier not in ("Axis", "FootPrint", "Box", "Annotation")
    ]


def extract(
    path: Path, workers: int, with_metadata: bool, report: dict, on_stage=None
) -> tuple[list[Group], dict, dict]:
    import ifcopenshell
    import ifcopenshell.geom
    from ifcopenshell.util import shape as su, unit

    started = perf_counter()
    f = ifcopenshell.open(str(path))
    report["parseTimeSeconds"] = perf_counter() - started
    report["ifcSchema"] = f.schema
    report["ifcopenshellVersion"] = ifcopenshell.version
    report["projectUnits"] = {
        "lengthScaleToMeters": unit.calculate_unit_scale(f),
        "declared": [str(x) for ua in f.by_type("IfcUnitAssignment") for x in ua.Units],
        "geometryAndPlacementOutput": "meters; convert-back-units=false",
    }
    products = f.by_type("IfcProduct")
    report["elementsInspected"] = len(products)
    report["ifcEntityCount"] = sum(1 for _ in f)
    candidates = []
    skipped = report["skippedIfcObjects"]
    assembly_decisions = []
    for e in products:
        reason = excluded(e)
        if not reason and not body_representations(e):
            reason = "NO_BODY_REPRESENTATION"
        if reason:
            skipped.append(
                {
                    "expressId": e.id(),
                    "guid": getattr(e, "GlobalId", None),
                    "ifcType": e.is_a(),
                    "reason": reason,
                }
            )
        else:
            candidates.append(e)
        if e.is_a("IfcElementAssembly"):
            assembly_decisions.append(
                {
                    "expressId": e.id(),
                    "guid": e.GlobalId,
                    "hasOwnRepresentation": bool(body_representations(e)),
                    "children": [
                        x.id() for rel in e.IsDecomposedBy for x in rel.RelatedObjects
                    ],
                    "decision": "CONTAINER" if reason else "OWN_GEOMETRY",
                }
            )
    report["renderCandidates"] = len(candidates)
    if not candidates:
        raise ValueError("NO_RENDER_CANDIDATES")
    settings = ifcopenshell.geom.settings()
    settings.set("use-world-coords", False)
    settings.set("convert-back-units", False)
    settings.set("weld-vertices", True)
    settings.set("apply-default-materials", True)
    settings.set("context-identifiers", ["Body", "Facetation"])
    if on_stage:
        on_stage("geometry")
    started = perf_counter()
    it = ifcopenshell.geom.iterator(settings, f, workers, include=candidates)
    if not it.initialize():
        raise ValueError("GEOMETRY_ITERATOR_INITIALIZE_FAILED")
    groups: dict[str, Group] = {}
    seen_ids: set[int] = set()
    metadata = {}
    manifest = {}
    boxes = []
    geometry_by_id = {}
    bbox_by_id = {}
    succeeded = 0
    while True:
        sh = it.get()
        e = f.by_id(sh.id)
        try:
            if e.id() in seen_ids:
                raise ValueError("DUPLICATE_ITERATOR_PRODUCT")
            seen_ids.add(e.id())
            guid = e.GlobalId
            if not isinstance(guid, str) or len(guid) != 22:
                raise ValueError("INVALID_OR_MISSING_GLOBALID")
            if guid in manifest:
                raise ValueError("DUPLICATE_GLOBALID")
            g = sh.geometry
            p64 = su.get_vertices(g)
            p = p64.astype(np.float32)
            faces = su.get_faces(g)
            matrix = su.get_shape_matrix(sh).copy()
            if not np.isfinite(matrix).all():
                raise ValueError("NON_FINITE_TRANSFORM")
            source_box = bounds(p64, matrix)
            # Three.js does not support negative InstancedMesh scales: bake a
            # reflection into one shared shape and reverse winding instead.
            if np.linalg.det(matrix[:3, :3]) < 0:
                p[:, 0] *= -1
                matrix[:3, 0] *= -1
                faces = faces[:, [0, 2, 1]].copy()
            t, q, s = decompose_matrix(matrix)
            if not np.allclose(compose_matrix(t, q, s), matrix, atol=1e-7):
                p = (p @ matrix[:3, :3].T).astype(np.float32)
                matrix[:3, :3] = np.eye(3)
                report["warnings"].append(
                    {
                        "expressId": e.id(),
                        "reason": "SHEAR_BAKED_INTO_SHARED_LOCAL_GEOMETRY",
                    }
                )
            colors = su.get_material_colors(g)
            ids = su.get_faces_material_style_ids(g).copy()
            mats = []
            for color in colors:
                rgba = np.nan_to_num(color, nan=1.0).clip(0, 1).tolist()
                mat = {
                    "pbrMetallicRoughness": {
                        "baseColorFactor": rgba,
                        "metallicFactor": 0,
                        "roughnessFactor": 0.8,
                    },
                    "doubleSided": True,
                }
                if rgba[3] < 1:
                    mat["alphaMode"] = "BLEND"
                mats.append(mat)
            default = len(mats)
            mats.append(
                {
                    "pbrMetallicRoughness": {
                        "baseColorFactor": [0.62, 0.69, 0.77, 1],
                        "metallicFactor": 0,
                        "roughnessFactor": 0.8,
                    },
                    "doubleSided": True,
                }
            )
            ids[ids < 0] = default
            if len(ids) != len(faces) or ids.max(initial=0) >= len(mats):
                raise ValueError("INVALID_MATERIAL_ASSIGNMENT")
            # Full deterministic content hash, including material assignment.
            # No assumption about geometry.id uniqueness is needed.
            key = geometry_key(p, faces, ids, mats)
            bucket = groups.get(key)
            if bucket is None:
                check_geometry(p, faces)
                bucket = Group(key, p.copy(), faces.astype(np.uint32), ids, mats)
                groups[key] = bucket
            bucket.guids.append(guid)
            bucket.express_ids.append(e.id())
            bucket.types.append(e.is_a())
            bucket.matrices.append(matrix)
            geometry_by_id[e.id()] = bucket
            bbox_by_id[e.id()] = source_box
            boxes.append(source_box)
            manifest[guid] = {
                "expressId": e.id(),
                "ifcType": e.is_a(),
                "geometryKey": key,
                "instanceIndex": len(bucket.guids) - 1,
            }
            if with_metadata:
                metadata[guid] = element_metadata(e, report["warnings"])
            succeeded += 1
            if succeeded % 1000 == 0:
                log.info("Geometry: %d / %d products", succeeded, len(candidates))
        except Exception as exc:
            report["errors"].append(
                {
                    "stage": "geometry",
                    "expressId": e.id(),
                    "guid": getattr(e, "GlobalId", None),
                    "exception": repr(exc),
                }
            )
            log.error("Geometry failed for #%d: %s", e.id(), exc)
        if not it.next():
            break
    report["geometryTimeSeconds"] = perf_counter() - started
    for e in candidates:
        if e.id() not in seen_ids:
            report["errors"].append(
                {
                    "stage": "geometry",
                    "expressId": e.id(),
                    "guid": e.GlobalId,
                    "exception": "ITERATOR_DID_NOT_RETURN_CANDIDATE",
                }
            )
    # Assemblies with their own geometry and children need an overlap decision.
    # A complete duplicate of child bodies is omitted; partial overlap fails.
    from .assembly import reconcile

    reconcile(
        assembly_decisions,
        geometry_by_id,
        manifest,
        metadata,
        skipped,
        report["errors"],
    )
    result = [g for g in groups.values() if g.guids]
    report["assemblyDecisions"] = assembly_decisions
    report["geometrySucceededBeforeAssemblyDedup"] = succeeded
    report["visibleElements"] = sum(len(g.guids) for g in result)
    report["elementsWithGlobalId"] = len(manifest)
    report["uniqueGuidCount"] = len(manifest)
    report["duplicates"] = [
        x for x in report["errors"] if "DUPLICATE_GLOBALID" in x["exception"]
    ]
    report["uniqueGeometries"] = len(result)
    report["instanceCount"] = report["visibleElements"]
    report["deduplicationRatio"] = report["visibleElements"] / max(1, len(result))
    report["triangleCount"] = sum(len(g.faces) * len(g.guids) for g in result)
    report["uniqueTriangleCount"] = sum(len(g.faces) for g in result)
    report["vertexCount"] = sum(len(g.positions) * len(g.guids) for g in result)
    report["uniqueVertexCount"] = sum(len(g.positions) for g in result)
    report["types"] = dict(Counter(t for g in result for t in g.types))
    if report["errors"]:
        raise ValueError(f"GEOMETRY_VALIDATION_FAILED: {len(report['errors'])} errors")
    report["sourceBoundingBoxMeters"] = union_bounds(boxes).tolist()
    # Independent world-coordinate reference on a deterministic, class-diverse sample.
    if on_stage:
        on_stage("placement-validation")
    started = perf_counter()
    world_settings = ifcopenshell.geom.settings()
    world_settings.set("use-world-coords", True)
    world_settings.set("convert-back-units", False)
    samples = []
    sample_types = set()
    for e in candidates:
        if e.is_a() not in sample_types or len(samples) < 12:
            sample_types.add(e.is_a())
            samples.append(e)
    checks = []
    for e in samples:
        ws = ifcopenshell.geom.create_shape(world_settings, e)
        wp = su.get_vertices(ws.geometry)
        wb = np.array([wp.min(axis=0), wp.max(axis=0)])
        delta = float(np.max(np.abs(wb - bbox_by_id[e.id()])))
        checks.append(
            {"expressId": e.id(), "guid": e.GlobalId, "maxErrorMeters": delta}
        )
        if delta > 1e-5:
            raise ValueError(f"WORLD_PLACEMENT_MISMATCH #{e.id()}: {delta}")
    report["worldPlacementValidation"] = {
        "samples": checks,
        "status": "PASS",
        "seconds": perf_counter() - started,
    }
    return (
        result,
        {
            "schemaVersion": 1,
            "source": {"path": str(path), "schema": f.schema},
            "elements": metadata,
        },
        manifest,
    )
