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
  /** Id of the federated model this geometry group belongs to. */
  model: string;
  object: Object3D;
  mapping: IFCMapping;
  meshes: InstancedMesh[];
  originals: Map<InstancedMesh, Float32Array>;
}
export interface SbzhRecord {
  mark: string;
  markSource: string;
  detectedBy: string;
  name?: string | null;
  kind?: string | null;
  family?: string | null;
  concreteGrade?: string | null;
  waterResistance?: string | null;
  frostResistance?: string | null;
  concreteStandard?: string | null;
  reinforcementClass?: string | null;
  elementCode?: string | null;
  materialCode?: string | null;
  material?: string | null;
  structuralClass?: string | null;
  volumeM3: number | null;
  massT: number | null;
  massIsCalculated: boolean;
}
export interface Span {
  min: number;
  max: number;
}
export interface SbzhRow {
  mark: string;
  model?: string | null;
  name?: string | null;
  kind?: string | null;
  ifcType?: string | null;
  storey?: string | null;
  concreteGrade?: string | null;
  waterResistance?: string | null;
  frostResistance?: string | null;
  reinforcementClass?: string | null;
  elementCode?: string | null;
  count: number;
  missingVolume: number;
  volumeTotalM3: number;
  massTotalT: number;
  unitVolumeM3: Span | null;
  unitMassT: Span | null;
  guids: string[];
}
export interface SbzhData {
  schemaVersion: number;
  model: string | null;
  densityTPerM3: number;
  rules: Record<string, string>;
  totals: {
    marks: number;
    products: number;
    volumeM3: number;
    massT: number;
    withoutVolume: number;
  };
  rows: SbzhRow[];
}
export interface Storey {
  name: string;
  elevationMeters: number;
  models?: string[];
}
export interface SetModel {
  id: string;
  name: string;
  discipline?: string | null;
  glb: string;
  metadata?: string | null;
  sbzh?: string | null;
  elements?: number;
  triangles?: number;
  glbBytes?: number;
  storeys?: Storey[];
  nonCriticalIssues?: number;
}
export interface ModelSet {
  schemaVersion: number;
  id: string;
  title: string;
  models: SetModel[];
  storeys?: Storey[];
  alignment?: {
    method: string;
    status: string;
    pairs: {
      models: string[];
      planOverlapRatio: number;
      maxStoreyElevationDeltaMeters: number | null;
      status: string;
    }[];
  };
}
/** A model to load: URLs resolved against the page, or local files. */
export interface ModelSource {
  id: string;
  name: string;
  discipline?: string | null;
  glb: string | File;
  metadata?: string | File | null;
  sbzh?: string | null;
  info?: SetModel;
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
