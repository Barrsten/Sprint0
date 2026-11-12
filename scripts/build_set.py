"""Assemble converted IFC models into a federated set for the viewer.

Each input is a converter output folder (status SUCCESS). The script copies the
browser files (model.glb, metadata.json, sbzh.json, model-info.json) into
OUT/<model>/, writes OUT/set.json and registers the set in
OUT/../catalog.json. Geometry stays in each model's own world coordinates, so
the viewer federates the set without moving anything; the alignment section
only reports how the models relate (bounding-box overlap, storey elevations).

    python -m scripts.build_set --id kr --title "…" \
        --out viewer/public/models/kr reports/kr/К1-КЖ-0 reports/kr/К1-КМ-0
"""

from __future__ import annotations
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import shutil

FILES = ("model.glb", "metadata.json", "sbzh.json", "model-info.json")
DISCIPLINES = ("КЖ", "КМ", "КР", "АР", "ОВ", "ВК", "ЭОМ", "ТХ", "ГП")


def load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf8"))


def discipline(name: str) -> str | None:
    for code in DISCIPLINES:
        if re.search(rf"(^|[-_ ]){code}([-_ ]|$)", name):
            return code
    return None


def overlap_ratio(a: list, b: list) -> float:
    """Plan (XY) bounding-box intersection relative to the smaller footprint."""
    (ax0, ay0, _), (ax1, ay1, _) = a
    (bx0, by0, _), (bx1, by1, _) = b
    w = max(0.0, min(ax1, bx1) - max(ax0, bx0))
    h = max(0.0, min(ay1, by1) - max(ay0, by0))
    smaller = min((ax1 - ax0) * (ay1 - ay0), (bx1 - bx0) * (by1 - by0))
    return w * h / smaller if smaller > 0 else 0.0


def alignment(models: list[dict]) -> dict:
    pairs = []
    for i, a in enumerate(models):
        for b in models[i + 1 :]:
            sa = {s["name"]: s["elevationMeters"] for s in a["storeys"]}
            sb = {s["name"]: s["elevationMeters"] for s in b["storeys"]}
            common = sorted(set(sa) & set(sb))
            delta = max((abs(sa[n] - sb[n]) for n in common), default=None)
            ratio = overlap_ratio(a["boundingBoxMeters"], b["boundingBoxMeters"])
            pairs.append(
                {
                    "models": [a["id"], b["id"]],
                    "planOverlapRatio": round(ratio, 4),
                    "commonStoreys": common,
                    "maxStoreyElevationDeltaMeters": delta,
                    "status": "OK"
                    if ratio >= 0.5 and (delta is None or delta <= 0.01)
                    else "CHECK",
                }
            )
    return {
        "method": "Модели совмещаются в исходных мировых координатах IFC без "
        "сдвигов. Контроль: пересечение габаритов в плане и совпадение отметок "
        "одноимённых этажей (допуск 10 мм).",
        "status": "OK" if all(p["status"] == "OK" for p in pairs) else "CHECK",
        "pairs": pairs,
    }


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("inputs", nargs="+", type=Path, help="converter output folders")
    p.add_argument("--id", required=True)
    p.add_argument("--title", required=True)
    p.add_argument("--out", type=Path, required=True)
    a = p.parse_args()
    a.out.mkdir(parents=True, exist_ok=True)
    models = []
    for folder in a.inputs:
        report = load(folder / "conversion-report.json")
        if report.get("status") != "SUCCESS":
            raise SystemExit(f"{folder}: conversion status {report.get('status')}")
        info = load(folder / "model-info.json")
        target = a.out / info["name"]
        target.mkdir(parents=True, exist_ok=True)
        for name in FILES:
            if (folder / name).exists():
                shutil.copy2(folder / name, target / name)
        has_sbzh = (folder / "sbzh.json").exists()
        models.append(
            {
                "id": info["name"],
                "name": info["name"],
                "discipline": discipline(info["name"]),
                "glb": f"{info['name']}/model.glb",
                "metadata": f"{info['name']}/metadata.json",
                "sbzh": f"{info['name']}/sbzh.json" if has_sbzh else None,
                "info": f"{info['name']}/model-info.json",
                "elements": info["elements"],
                "triangles": info["triangles"],
                "glbBytes": (folder / "model.glb").stat().st_size,
                "boundingBoxMeters": info["boundingBoxMeters"],
                "storeys": (info.get("spatial") or {}).get("storeys", []),
                "sbzhTotals": info.get("sbzh"),
                "nonCriticalIssues": len(info.get("nonCriticalIssues") or []),
            }
        )
    storeys: dict[tuple, dict] = {}
    for m in models:
        for s in m["storeys"]:
            key = (s["name"], round(s["elevationMeters"], 2))
            storeys.setdefault(key, {**s, "models": []})["models"].append(m["id"])
    totals = [m["sbzhTotals"] for m in models if m["sbzhTotals"]]
    result = {
        "schemaVersion": 1,
        "id": a.id,
        "title": a.title,
        "created": datetime.now(timezone.utc).isoformat(),
        "models": models,
        "storeys": sorted(storeys.values(), key=lambda s: s["elevationMeters"]),
        "alignment": alignment(models),
        "sbzh": {
            "marks": sum(t["marks"] for t in totals),
            "products": sum(t["products"] for t in totals),
            "volumeM3": sum(t["volumeM3"] for t in totals),
            "massT": sum(t["massT"] for t in totals),
        }
        if totals
        else None,
    }
    (a.out / "set.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2), encoding="utf8"
    )
    catalog_path = a.out.parent / "catalog.json"
    catalog = load(catalog_path) if catalog_path.exists() else {"sets": []}
    entry = {"id": a.id, "title": a.title, "url": f"{a.out.name}/set.json"}
    catalog["sets"] = [s for s in catalog["sets"] if s["id"] != a.id] + [entry]
    catalog_path.write_text(
        json.dumps(catalog, ensure_ascii=False, indent=2), encoding="utf8"
    )
    print(json.dumps(result["alignment"], ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
