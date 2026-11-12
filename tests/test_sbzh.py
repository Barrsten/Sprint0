import numpy as np
import pytest
from converter.model import drop_degenerate_triangles, check_geometry
from converter.sbzh import record, schedule, to_csv


def element(method="Precast", position="Не требуется", type_name="Плита ТТ:ТТ-1-О-2.2", volume=2.5):
    return {
        "ifcType": "IfcSlab",
        "typeName": type_name,
        "storey": "1_этаж",
        "propertySets": {
            "Pset_ConcreteElementGeneral": {"ConstructionMethod": method, "id": 1},
            "ExpCheck_Slab": {
                "MGE_Position": position,
                "MGE_Name": "Перекрытие",
                "MGE_SlabType": "перекрытие кровли",
                "MGE_Material": "Железобетон сборный" if method == "Precast" else "Железобетон",
                "MGE_ElementCode": "ЭЛ 30 10 40",
            },
            "ExpCheck_MaterialConcrete": {"MGE_ConcreteGrade": "B50", "MGE_WaterResist": "W10"},
            "ExpCheck_SlabReinforcement": {"MGE_ReinforceStrengthClass": "А500С"},
            "Qto_SlabBaseQuantities": {"NetVolume": volume, "id": 2},
        },
    }


def test_precast_record_uses_type_mark_and_calculated_mass():
    r = record(element())
    assert r["mark"] == "ТТ-1-О-2.2" and r["markSource"] == "IfcTypeObject.Name"
    assert r["concreteGrade"] == "B50" and r["reinforcementClass"] == "А500С"
    assert r["volumeM3"] == 2.5 and r["massT"] == pytest.approx(6.25)
    assert r["massIsCalculated"] is True


def test_position_has_priority_and_insitu_is_not_precast():
    assert record(element(position="ВСН-1-А-1.9"))["mark"] == "ВСН-1-А-1.9"
    assert record(element(method="In-situ")) is None


def test_material_fallback_and_volume_unit_scale():
    e = element(method=None)
    e["propertySets"]["ExpCheck_Slab"]["MGE_Material"] = "Железобетон сборный"
    r = record(e, volume_scale=1e-9)  # e.g. a project volume unit of mm³
    assert r["detectedBy"] == "ExpCheck.MGE_Material"
    assert r["volumeM3"] == pytest.approx(2.5e-9)


def test_schedule_groups_by_mark_and_csv_totals():
    elements = {"A": element(volume=2.0), "B": element(volume=2.0), "C": element(position="П-1", volume=1.0), "D": element(method="In-situ")}
    for e in elements.values():
        data = record(e)
        if data:
            e["sbzh"] = data
    s = schedule(elements, "К1-КЖ-0")
    assert s["totals"] == {"marks": 2, "products": 3, "volumeM3": 5.0, "massT": 12.5, "withoutVolume": 0}
    tt = next(r for r in s["rows"] if r["mark"] == "ТТ-1-О-2.2")
    assert tt["count"] == 2 and tt["guids"] == ["A", "B"] and tt["unitVolumeM3"] == {"min": 2.0, "max": 2.0}
    text = to_csv(s)
    assert text.startswith("﻿№;Модель;Марка") and "Итого" in text and "12,500" in text


def test_degenerate_triangles_are_dropped_but_all_degenerate_still_fails():
    p = np.array([[0, 0, 0], [1, 0, 0], [0, 1, 0], [2, 0, 0]], dtype=np.float32)
    f = np.array([[0, 1, 2], [0, 1, 3]], dtype=np.uint32)  # second is collinear
    faces, ids, removed = drop_degenerate_triangles(p, f, np.array([0, 1]))
    assert removed == 1 and faces.tolist() == [[0, 1, 2]] and ids.tolist() == [0]
    check_geometry(p, faces)
    flat = np.array([[0, 1, 3]], dtype=np.uint32)
    faces, _, removed = drop_degenerate_triangles(p, flat, np.array([0]))
    assert removed == 0
    with pytest.raises(ValueError):
        check_geometry(p, faces)
