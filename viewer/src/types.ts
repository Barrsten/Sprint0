import type { InstancedMesh, Matrix4, Object3D } from "three";
export interface IFCMapping {
  geometryKey: string;
  instanceGuids: string[];
  instanceExpressIds: number[];
  instanceTypes: string[];
}
export interface IFCElement {
  guid: string;
  expressId: number;
  ifcType: string;
  name?: string | null;
  tag?: string | null;
  propertySets?: Record<string, unknown>;
  [key: string]: unknown;
}
export interface Metadata {
  schemaVersion: number;
  elements: Record<string, IFCElement>;
}
export interface LogicalGroup {
  object: Object3D;
  mapping: IFCMapping;
  meshes: InstancedMesh[];
  originals: Map<InstancedMesh, Float32Array>;
}
export interface Selected {
  group: LogicalGroup;
  index: number;
  guid: string;
}
export function mappingFor(
  object: Object3D,
): { object: Object3D; mapping: IFCMapping } | null {
  let current: Object3D | null = object;
  while (current) {
    const m: unknown = current.userData.ifc;
    if (
      m &&
      typeof m === "object" &&
      "instanceGuids" in m &&
      Array.isArray(m.instanceGuids)
    )
      return { object: current, mapping: m as IFCMapping };
    current = current.parent;
  }
  return null;
}
export function guidAt(mapping: IFCMapping, index: number): string {
  if (
    !Number.isInteger(index) ||
    index < 0 ||
    index >= mapping.instanceGuids.length
  )
    throw new Error("Invalid IFC instance index");
  return mapping.instanceGuids[index];
}
