/** Actual GLTFLoader + Three.js raycast, without WebGL/browser claims. */
import fs from "node:fs/promises";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import * as THREE from "../viewer/node_modules/three/build/three.module.js";
import { GLTFLoader } from "../viewer/node_modules/three/examples/jsm/loaders/GLTFLoader.js";
const [
  file = "reports/small/model.decoded.glb",
  output = "reports/three-loader-report.json",
] = process.argv.slice(2);
const data = await fs.readFile(file);
const start = performance.now();
const gltf = await new GLTFLoader().parseAsync(
  data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
  "",
);
gltf.scene.updateMatrixWorld(true);
const loadMs = performance.now() - start;
const meshes = [],
  groups = new Map();
gltf.scene.traverse((object) => {
  if (object.isInstancedMesh) {
    meshes.push(object);
    let current = object;
    while (current && !current.userData.ifc) current = current.parent;
    assert(current, "mesh mapping");
    const m = current.userData.ifc;
    assert.equal(m.instanceGuids.length, object.count);
    let group = groups.get(current);
    if (!group) {
      group = { mapping: m, meshes: [] };
      groups.set(current, group);
    }
    group.meshes.push(object);
  }
});
const guids = [...groups.values()].flatMap((g) => g.mapping.instanceGuids);
assert.equal(new Set(guids).size, guids.length);
const samples = [];
const ray = new THREE.Raycaster();
for (const group of groups.values()) {
  for (let i = 0; i < group.mapping.instanceGuids.length; i++) {
    if (samples.length >= 100) break;
    const mesh = group.meshes[0],
      p = mesh.geometry.attributes.position,
      idx = mesh.geometry.index;
    const a = new THREE.Vector3().fromBufferAttribute(p, idx.getX(0)),
      b = new THREE.Vector3().fromBufferAttribute(p, idx.getX(1)),
      c = new THREE.Vector3().fromBufferAttribute(p, idx.getX(2));
    const matrix = new THREE.Matrix4();
    mesh.getMatrixAt(i, matrix);
    matrix.premultiply(mesh.matrixWorld);
    a.applyMatrix4(matrix);
    b.applyMatrix4(matrix);
    c.applyMatrix4(matrix);
    const normal = b.clone().sub(a).cross(c.clone().sub(a)).normalize();
    const center = a
      .clone()
      .add(b)
      .add(c)
      .multiplyScalar(1 / 3);
    ray.set(
      center.clone().addScaledVector(normal, 0.00001),
      normal.clone().negate(),
    );
    ray.far = 0.0001;
    const t = performance.now();
    const hits = ray.intersectObject(mesh, false);
    const elapsed = performance.now() - t;
    assert(
      hits.some((h) => h.instanceId === i),
      "triangle ray hits target instance",
    );
    const guid = group.mapping.instanceGuids[i];
    samples.push({
      guid,
      instanceId: i,
      hits: hits.length,
      raycastMs: elapsed,
    });
  }
  if (samples.length >= 100) break;
}
const report = {
  status: "PASS",
  runtime: "Node.js Three.js GLTFLoader and Raycaster; no WebGL rendering",
  input: file,
  loadMs,
  groups: groups.size,
  primitiveMeshes: meshes.length,
  mappedGuids: guids.length,
  uniqueGuids: new Set(guids).size,
  samples,
};
await fs.writeFile(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, samples: samples.length }));
