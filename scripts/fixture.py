"""Small real IFC fixtures: repeated beams, nested mm placement, assembly, opening."""

from pathlib import Path
import ifcopenshell
import ifcopenshell.guid


def create(
    path: Path, *, millimeters: bool = True, broken_geometry: bool = False
) -> dict:
    f = ifcopenshell.file(schema="IFC4")
    new = f.create_entity
    point = lambda xyz: new(
        "IfcCartesianPoint", Coordinates=tuple(float(v) for v in xyz)
    )
    axis = lambda xyz: new("IfcAxis2Placement3D", Location=point(xyz))
    place = lambda xyz, parent=None: new(
        "IfcLocalPlacement", PlacementRelTo=parent, RelativePlacement=axis(xyz)
    )
    u = 1000.0 if millimeters else 1.0
    unit = new(
        "IfcSIUnit",
        UnitType="LENGTHUNIT",
        Prefix="MILLI" if millimeters else None,
        Name="METRE",
    )
    units = new("IfcUnitAssignment", Units=[unit])
    ctx = new(
        "IfcGeometricRepresentationContext",
        ContextIdentifier="Model",
        ContextType="Model",
        CoordinateSpaceDimension=3,
        Precision=1e-5,
        WorldCoordinateSystem=axis((0, 0, 0)),
    )
    project = new(
        "IfcProject",
        GlobalId=ifcopenshell.guid.new(),
        Name="Контур 2 test",
        RepresentationContexts=[ctx],
        UnitsInContext=units,
    )
    profile = new(
        "IfcRectangleProfileDef", ProfileType="AREA", XDim=0.3 * u, YDim=0.5 * u
    )
    solid = new(
        "IfcExtrudedAreaSolid",
        SweptArea=profile,
        Position=axis((0, 0, 0)),
        ExtrudedDirection=new("IfcDirection", DirectionRatios=(0.0, 0.0, 1.0)),
        Depth=3 * u,
    )
    if broken_geometry:
        points = new(
            "IfcCartesianPointList3D",
            CoordList=((0.0, 0.0, 0.0), (u, 0.0, 0.0), (0.0, u, 0.0)),
        )
        solid = new(
            "IfcTriangulatedFaceSet",
            Coordinates=points,
            Closed=True,
            CoordIndex=((1, 2, 99),),
        )
    rep = new(
        "IfcShapeRepresentation",
        ContextOfItems=ctx,
        RepresentationIdentifier="Body",
        RepresentationType="Tessellation" if broken_geometry else "SweptSolid",
        Items=[solid],
    )
    definition = new("IfcProductDefinitionShape", Representations=[rep])
    parent = place((10 * u, 20 * u, 0))
    beams = []
    for i in range(4):
        e = new(
            "IfcBeam",
            GlobalId=ifcopenshell.guid.new(),
            Name="Балка " + str(i),
            ObjectPlacement=place((i * 2 * u, 0, 0), parent),
            Representation=definition,
            Tag=str(i),
        )
        beams.append(e)
    prop = new(
        "IfcPropertySingleValue",
        Name="Марка",
        NominalValue=new("IfcLabel", "Сталь С245"),
    )
    pset = new(
        "IfcPropertySet",
        GlobalId=ifcopenshell.guid.new(),
        Name="Pset_Контур",
        HasProperties=[prop],
    )
    new(
        "IfcRelDefinesByProperties",
        GlobalId=ifcopenshell.guid.new(),
        RelatedObjects=beams,
        RelatingPropertyDefinition=pset,
    )
    assembly = new(
        "IfcElementAssembly",
        GlobalId=ifcopenshell.guid.new(),
        Name="Container",
        ObjectPlacement=parent,
    )
    new(
        "IfcRelAggregates",
        GlobalId=ifcopenshell.guid.new(),
        RelatingObject=assembly,
        RelatedObjects=beams,
    )
    own = new(
        "IfcElementAssembly",
        GlobalId=ifcopenshell.guid.new(),
        Name="Own geometry",
        ObjectPlacement=place((14 * u, 23 * u, 0)),
        Representation=definition,
    )
    new(
        "IfcOpeningElement",
        GlobalId=ifcopenshell.guid.new(),
        Name="Must not render",
        ObjectPlacement=parent,
        Representation=definition,
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    f.write(str(path))
    return {"visibleGuids": [e.GlobalId for e in beams] + [own.GlobalId]}


if __name__ == "__main__":
    import sys

    create(Path(sys.argv[1] if len(sys.argv) > 1 else "fixtures/small.ifc"))
