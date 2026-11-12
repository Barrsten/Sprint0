import * as THREE from "three";

/**
 * Draw-call batching for weak GPUs.
 *
 * Every IFC element stays an instance of its source InstancedMesh: picking,
 * GUID mapping, highlight and hide/isolate overlays keep using those meshes.
 * The sources move to SOURCE_LAYER, which the camera does not render but the
 * raycaster tests (a layer, not `visible`: group nodes toggle visibility). Rendering
 * goes through one THREE.BatchedMesh per material and model, drawn with
 * WEBGL_multi_draw — tens of draw calls instead of one per geometry group.
 * Shared geometry is stored once per batch, so repeated elements still cost
 * one copy of their shape.
 */
export const SOURCE_LAYER = 1;

export interface BatchEntry {
  batch: THREE.BatchedMesh;
  /** Batch instance id for every instance index of the source mesh. */
  ids: Int32Array;
}

export interface ModelBatches {
  container: THREE.Group;
  batches: THREE.BatchedMesh[];
  entries: Map<THREE.InstancedMesh, BatchEntry>;
  sourceDrawCalls: number;
}

function compatible(meshes: THREE.InstancedMesh[]) {
  const signature = (g: THREE.BufferGeometry) =>
    Object.keys(g.attributes).sort().join(",") + (g.index ? "|i" : "");
  return new Set(meshes.map((m) => signature(m.geometry))).size === 1;
}

/**
 * @param parent  model root (identity transform); the batch container is added
 *                to it so model visibility toggles hide the batches too.
 * @param sources InstancedMeshes of the model with up-to-date matrixWorld.
 * @param originals original instance matrices per source mesh.
 */
export function buildBatches(
  parent: THREE.Object3D,
  sources: THREE.InstancedMesh[],
  originals: (mesh: THREE.InstancedMesh) => Float32Array,
): ModelBatches {
  // Keep instance matrices small: float32 translations of ~15 km world
  // coordinates would lose millimetres, so batches are placed at the model centre.
  const box = new THREE.Box3();
  for (const mesh of sources) {
    if (!mesh.boundingBox) mesh.computeBoundingBox();
    box.union(mesh.boundingBox!.clone().applyMatrix4(mesh.matrixWorld));
  }
  const offset = box.isEmpty()
    ? new THREE.Vector3()
    : box.getCenter(new THREE.Vector3());
  const container = new THREE.Group();
  container.name = "draw batches";
  container.position.copy(offset);
  parent.add(container);
  container.updateMatrixWorld(true);
  const toLocal = new THREE.Matrix4().copy(container.matrixWorld).invert();

  const byMaterial = new Map<THREE.Material, THREE.InstancedMesh[]>();
  for (const mesh of sources) {
    if (Array.isArray(mesh.material)) continue;
    const list = byMaterial.get(mesh.material) ?? [];
    list.push(mesh);
    byMaterial.set(mesh.material, list);
  }

  const entries = new Map<THREE.InstancedMesh, BatchEntry>();
  const batches: THREE.BatchedMesh[] = [];
  const instance = new THREE.Matrix4();
  for (const [material, meshes] of byMaterial) {
    if (!compatible(meshes)) continue; // left as ordinary instanced meshes
    let vertices = 0,
      indices = 0,
      instances = 0;
    for (const mesh of meshes) {
      vertices += mesh.geometry.attributes.position.count;
      indices += mesh.geometry.index?.count ?? 0;
      instances += mesh.count;
    }
    const batch = new THREE.BatchedMesh(
      instances,
      vertices,
      Math.max(indices, 1),
      material,
    );
    batch.name = `batch ${material.name || material.uuid.slice(0, 8)}`;
    // Depth sorting every frame is only needed for transparent materials.
    batch.sortObjects = material.transparent;
    batch.perObjectFrustumCulled = true;
    for (const mesh of meshes) {
      const geometryId = batch.addGeometry(mesh.geometry);
      const source = originals(mesh);
      const ids = new Int32Array(mesh.count);
      for (let i = 0; i < mesh.count; i++) {
        const id = batch.addInstance(geometryId);
        instance
          .fromArray(source, i * 16)
          .premultiply(mesh.matrixWorld)
          .premultiply(toLocal);
        batch.setMatrixAt(id, instance);
        ids[i] = id;
      }
      entries.set(mesh, { batch, ids });
      mesh.layers.set(SOURCE_LAYER);
    }
    batch.computeBoundingBox();
    batch.computeBoundingSphere();
    container.add(batch);
    batches.push(batch);
  }
  return {
    container,
    batches,
    entries,
    sourceDrawCalls: sources.length,
  };
}

export function setInstanceVisible(
  entries: Map<THREE.InstancedMesh, BatchEntry>,
  mesh: THREE.InstancedMesh,
  index: number,
  visible: boolean,
) {
  const entry = entries.get(mesh);
  if (entry) entry.batch.setVisibleAt(entry.ids[index], visible);
}
