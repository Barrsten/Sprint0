"""Precast reinforced concrete (СБЖ) products: detection, per-element data
and a schedule grouped by product mark.

Works on the sanitized element metadata (attributes + property sets), so the
rules are testable without an IFC file. Rules are explicit and reported:

* precast: Pset_ConcreteElementGeneral.ConstructionMethod is "Precast"
  (IFC enumeration PRECAST_CONCRETE / Revit export "Precast"), or the
  project material says "сборный" (e.g. ExpCheck_*.MGE_Material
  "Железобетон сборный"); in-situ concrete is never classified as precast;
* mark: ExpCheck_*.MGE_Position when filled, otherwise the IFC type name
  without the Revit family prefix ("Плита ТТ:ТТ-1-О-2.2" → "ТТ-1-О-2.2");
* volume: Qto_*BaseQuantities.NetVolume (GrossVolume as fallback), converted
  to m³ with the project volume unit;
* mass: NOT present in the source models — calculated as volume × density
  (2.5 t/m³, reinforced concrete) and always flagged as calculated.
"""

from __future__ import annotations
from collections import defaultdict
import csv
import io
import math
import re
from typing import Any

DENSITY_T_PER_M3 = 2.5
PLACEHOLDERS = {"", "-", "—", "не требуется", "нет", "none", "null"}
PRECAST_METHODS = {"precast", "precast_concrete", "сборный", "сборное"}
INSITU_METHODS = {"in-situ", "insitu", "in_situ", "monolithic", "монолитный"}


def _text(value: Any) -> str | None:
    if value is None or isinstance(value, (dict, list)):
        return None
    text = str(value).strip()
    return None if text.lower() in PLACEHOLDERS else text


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value) if math.isfinite(value) else None


def _first(psets: dict, key: str, prefix: str = "") -> Any:
    for name, props in psets.items():
        if name.startswith(prefix) and isinstance(props, dict) and key in props:
            value = _text(props[key])
            if value is not None:
                return value
    return None


def detect(psets: dict) -> str | None:
    """Return the rule that classifies the element as precast, or None."""
    method = (psets.get("Pset_ConcreteElementGeneral") or {}).get(
        "ConstructionMethod"
    )
    method = str(method).strip().lower() if method is not None else ""
    if method in INSITU_METHODS:
        return None
    if method in PRECAST_METHODS:
        return "Pset_ConcreteElementGeneral.ConstructionMethod"
    material = _first(psets, "MGE_Material", "ExpCheck_")
    if material and "сборн" in material.lower():
        return "ExpCheck.MGE_Material"
    return None


def volume_m3(psets: dict, volume_scale: float) -> float | None:
    for key in ("NetVolume", "GrossVolume"):
        for name, props in psets.items():
            if name.startswith("Qto_") and isinstance(props, dict):
                value = _number(props.get(key))
                if value is not None and value > 0:
                    return value * volume_scale
    return None


def record(element: dict, volume_scale: float = 1.0) -> dict | None:
    """Per-element precast product data, or None for non-precast elements."""
    psets = element.get("propertySets") or {}
    if not isinstance(psets, dict):
        return None
    rule = detect(psets)
    if rule is None:
        return None
    position = _first(psets, "MGE_Position", "ExpCheck_")
    type_name = _text(element.get("typeName"))
    type_mark = type_name.split(":")[-1].strip() if type_name else None
    mark, mark_source = (
        (position, "ExpCheck.MGE_Position")
        if position
        else (type_mark, "IfcTypeObject.Name")
        if type_mark
        else ("Без марки", "NONE")
    )
    kind = None
    for name, props in psets.items():
        if name.startswith("ExpCheck_") and isinstance(props, dict):
            for key, value in props.items():
                if key.endswith("Type") and key.startswith("MGE_"):
                    kind = kind or _text(value)
    volume = volume_m3(psets, volume_scale)
    concrete = psets.get("ExpCheck_MaterialConcrete") or {}
    return {
        "mark": mark,
        "markSource": mark_source,
        "detectedBy": rule,
        "name": _first(psets, "MGE_Name", "ExpCheck_")
        or (type_name.split(":")[0] if type_name else None),
        "kind": kind,
        "family": type_name.split(":")[0] if type_name and ":" in type_name else None,
        "concreteGrade": _text(concrete.get("MGE_ConcreteGrade")),
        "waterResistance": _text(concrete.get("MGE_WaterResist")),
        "frostResistance": _text(concrete.get("MGE_FreezeDurability")),
        "concreteStandard": _text(concrete.get("MGE_ConcreteGost")),
        "reinforcementClass": _first(psets, "MGE_ReinforceStrengthClass"),
        "elementCode": _first(psets, "MGE_ElementCode", "ExpCheck_"),
        "materialCode": _first(psets, "MGE_MaterialCode", "ExpCheck_"),
        "material": _first(psets, "MGE_Material", "ExpCheck_"),
        "structuralClass": _text(
            (psets.get("Pset_ConcreteElementGeneral") or {}).get("StructuralClass")
        ),
        "volumeM3": volume,
        "massT": None if volume is None else volume * DENSITY_T_PER_M3,
        "massIsCalculated": True,
    }


def _natural(text: str) -> list:
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", text)]


def _joined(values: set) -> str | None:
    values = {v for v in values if v}
    return ", ".join(sorted(values)) if values else None


def schedule(elements: dict, model: str | None = None) -> dict:
    """Group precast elements (metadata dict guid → element) by product mark."""
    rows: dict[str, dict] = {}
    sets: dict[str, dict[str, set]] = defaultdict(lambda: defaultdict(set))
    for guid, element in elements.items():
        data = element.get("sbzh")
        if not data:
            continue
        mark = data["mark"]
        row = rows.setdefault(
            mark,
            {
                "mark": mark,
                "count": 0,
                "volumeTotalM3": 0.0,
                "massTotalT": 0.0,
                "missingVolume": 0,
                "unitVolumes": [],
                "guids": [],
            },
        )
        row["count"] += 1
        row["guids"].append(guid)
        if data["volumeM3"] is None:
            row["missingVolume"] += 1
        else:
            row["volumeTotalM3"] += data["volumeM3"]
            row["massTotalT"] += data["massT"]
            row["unitVolumes"].append(data["volumeM3"])
        for key in (
            "name",
            "kind",
            "concreteGrade",
            "waterResistance",
            "frostResistance",
            "reinforcementClass",
            "elementCode",
        ):
            sets[mark][key].add(data.get(key))
        sets[mark]["ifcType"].add(element.get("ifcType"))
        sets[mark]["storey"].add(element.get("storey"))
    out = []
    for mark, row in rows.items():
        volumes = row.pop("unitVolumes")
        row["unitVolumeM3"] = (
            {"min": min(volumes), "max": max(volumes)} if volumes else None
        )
        row["unitMassT"] = (
            {
                "min": min(volumes) * DENSITY_T_PER_M3,
                "max": max(volumes) * DENSITY_T_PER_M3,
            }
            if volumes
            else None
        )
        for key, values in sets[mark].items():
            row[key] = _joined(values)
        if model:
            row["model"] = model
        out.append(row)
    out.sort(key=lambda r: (_natural(r["name"] or ""), _natural(r["mark"])))
    return {
        "schemaVersion": 1,
        "model": model,
        "rules": {
            "precast": "Pset_ConcreteElementGeneral.ConstructionMethod = Precast, "
            "или материал «сборный» (ExpCheck_*.MGE_Material)",
            "mark": "ExpCheck_*.MGE_Position, иначе имя типа IFC без семейства",
            "volume": "Qto_*BaseQuantities.NetVolume (GrossVolume), м³",
            "mass": f"расчётная: объём × {DENSITY_T_PER_M3} т/м³ (в модели масса отсутствует)",
        },
        "densityTPerM3": DENSITY_T_PER_M3,
        "totals": {
            "marks": len(out),
            "products": sum(r["count"] for r in out),
            "volumeM3": sum(r["volumeTotalM3"] for r in out),
            "massT": sum(r["massTotalT"] for r in out),
            "withoutVolume": sum(r["missingVolume"] for r in out),
        },
        "rows": out,
    }


def to_csv(data: dict) -> str:
    """Excel-friendly CSV (Russian locale: «;» separator, decimal comma)."""

    def num(value: float | None, digits: int = 3) -> str:
        return "" if value is None else f"{value:.{digits}f}".replace(".", ",")

    def span(value: dict | None, digits: int = 3) -> str:
        if not value:
            return ""
        lo, hi = num(value["min"], digits), num(value["max"], digits)
        return lo if lo == hi else f"{lo}…{hi}"

    buffer = io.StringIO()
    writer = csv.writer(buffer, delimiter=";", lineterminator="\r\n")
    writer.writerow(
        [
            "№",
            "Модель",
            "Марка",
            "Наименование",
            "Вид",
            "Класс IFC",
            "Бетон",
            "W",
            "F",
            "Арматура",
            "Код ЭЛ",
            "Кол-во, шт",
            "Объём ед., м³",
            "Объём всего, м³",
            "Масса ед. (расч.), т",
            "Масса всего (расч.), т",
        ]
    )
    for i, row in enumerate(data["rows"], 1):
        writer.writerow(
            [
                i,
                row.get("model") or "",
                row["mark"],
                row.get("name") or "",
                row.get("kind") or "",
                row.get("ifcType") or "",
                row.get("concreteGrade") or "",
                row.get("waterResistance") or "",
                row.get("frostResistance") or "",
                row.get("reinforcementClass") or "",
                row.get("elementCode") or "",
                row["count"],
                span(row["unitVolumeM3"]),
                num(row["volumeTotalM3"]),
                span(row["unitMassT"]),
                num(row["massTotalT"]),
            ]
        )
    totals = data["totals"]
    writer.writerow(
        ["", "", "Итого", "", "", "", "", "", "", "", "", totals["products"], "",
         num(totals["volumeM3"]), "", num(totals["massT"])]
    )
    return "﻿" + buffer.getvalue()
