import { copyFile, mkdir } from "node:fs/promises";
await mkdir("viewer/public/draco", { recursive: true });
for (const name of [
  "draco_decoder.js",
  "draco_decoder.wasm",
  "draco_wasm_wrapper.js",
]) {
  await copyFile(
    `viewer/node_modules/three/examples/jsm/libs/draco/gltf/${name}`,
    `viewer/public/draco/${name}`,
  );
}
