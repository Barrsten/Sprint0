import { copyFile, mkdir } from "node:fs/promises";
const src = "node_modules/three/examples/jsm/libs/draco/gltf/";
await mkdir("public/draco", { recursive: true });
for (const name of ["draco_decoder.js", "draco_decoder.wasm", "draco_wasm_wrapper.js"]) {
  await copyFile(src + name, "public/draco/" + name);
}
