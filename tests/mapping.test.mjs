import test from "node:test";
import assert from "node:assert/strict";
import { guidAt, mappingFor } from "../viewer/src/types.ts";
import { Object3D } from "../viewer/node_modules/three/build/three.module.js";
test("instance order maps to original, distinct IFC GlobalIds", () => {
  const m = {
    geometryKey: "shape",
    instanceGuids: ["A", "B", "C"],
    instanceExpressIds: [1, 2, 3],
    instanceTypes: ["IfcBeam", "IfcBeam", "IfcBeam"],
  };
  assert.equal(guidAt(m, 1), "B");
  assert.notEqual(guidAt(m, 0), guidAt(m, 1));
  for (const index of [-1, 3, NaN, 1.5]) assert.throws(() => guidAt(m, index));
});
test("multi-material primitive inherits parent node mapping", () => {
  const parent = new Object3D(),
    child = new Object3D();
  parent.add(child);
  parent.userData.ifc = { instanceGuids: ["A", "B"] };
  assert.equal(mappingFor(child).object, parent);
  assert.equal(mappingFor(child).mapping.instanceGuids[1], "B");
  assert.equal(mappingFor(new Object3D()), null);
});
