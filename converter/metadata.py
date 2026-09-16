from __future__ import annotations
import math
from typing import Any


def sanitize(value: Any, seen: set[int] | None = None, depth: int = 0) -> Any:
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else {"nonFinite": str(value)}
    if seen is None:
        seen = set()
    if depth > 64:
        return {"truncated": "maximum nesting depth"}
    identity = id(value)
    if identity in seen:
        return {"reference": "cycle"}
    seen.add(identity)
    try:
        if hasattr(value, "wrappedValue"):
            return sanitize(value.wrappedValue, seen, depth + 1)
        if hasattr(value, "is_a") and hasattr(value, "id"):
            return {
                "expressId": value.id(),
                "ifcType": value.is_a(),
                "guid": getattr(value, "GlobalId", None),
            }
        if isinstance(value, dict):
            return {str(k): sanitize(v, seen, depth + 1) for k, v in value.items()}
        if isinstance(value, (list, tuple, set)):
            return [sanitize(v, seen, depth + 1) for v in value]
        return str(value)
    finally:
        seen.remove(identity)


def element_metadata(e: Any, warnings: list) -> dict:
    from ifcopenshell.util.element import get_psets

    d = {"guid": e.GlobalId, "expressId": e.id(), "ifcType": e.is_a()}
    for key in ("Name", "Description", "Tag", "ObjectType"):
        d[key[0].lower() + key[1:]] = getattr(e, key, None)
    try:
        d["propertySets"] = sanitize(get_psets(e))
    except Exception as exc:
        d["propertySets"] = {}
        d["propertySetsError"] = repr(exc)
        warnings.append({"stage": "metadata", "expressId": e.id(), "error": repr(exc)})
    return d
