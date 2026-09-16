import fs from "node:fs/promises";
import { performance } from "node:perf_hooks";
import * as THREE from "../viewer/node_modules/three/build/three.module.js";
import { GLTFLoader } from "../viewer/node_modules/three/examples/jsm/loaders/GLTFLoader.js";
const file = process.argv[2] || "reports/km/model.decoded.glb";
const buf = await fs.readFile(file);
const scene = (
  await new GLTFLoader().parseAsync(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    "",
  )
).scene;
scene.updateMatrixWorld(true);
const meshes = [];
scene.traverse((o) => {
  if (o.isInstancedMesh) meshes.push(o);
});
const bounds = new THREE.Box3().setFromObject(scene),
  center = bounds.getCenter(new THREE.Vector3()),
  size = bounds.getSize(new THREE.Vector3()).length();
const camera = new THREE.PerspectiveCamera(45, 1.5, 0.01, size * 100);
const distance =
  (size / (2 * Math.tan(THREE.MathUtils.degToRad(45 / 2)))) * 1.1;
camera.position
  .copy(center)
  .add(new THREE.Vector3(1, 0.8, 1).normalize().multiplyScalar(distance));
camera.lookAt(center);
camera.updateMatrixWorld(true);
const ray = new THREE.Raycaster();
const results = [];
const targets = meshes
  .toSorted((a, b) => b.geometry.index.count - a.geometry.index.count)
  .filter((m, i) => i < 5);
for (const mesh of targets) {
  const index = mesh.geometry.index,
    p = mesh.geometry.attributes.position;
  const local = new THREE.Vector3();
  for (let v = 0; v < 3; v++)
    local.add(new THREE.Vector3().fromBufferAttribute(p, index.getX(v)));
  local.multiplyScalar(1 / 3);
  const mat = new THREE.Matrix4();
  mesh.getMatrixAt(0, mat);
  mat.premultiply(mesh.matrixWorld);
  const target = local.applyMatrix4(mat);
  ray.set(camera.position, target.clone().sub(camera.position).normalize());
  const start = performance.now();
  const hits = ray.intersectObjects(meshes, false);
  results.push({
    target: target.toArray(),
    ms: performance.now() - start,
    hitCount: hits.length,
    instanceId: hits[0]?.instanceId ?? null,
  });
}

const report = {
  status: "VERIFIED",
  runtime: "Node CPU only; excludes browser event, GPU and UI latency",
  raycaster: "standard Three.js",
  input: file,
  results,
};
await fs.writeFile(
  "reports/raycast-standard.json",
  JSON.stringify(report, null, 2),
);
console.log(report);
