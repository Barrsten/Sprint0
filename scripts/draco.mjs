import fs from "node:fs/promises";
import { NodeIO } from "@gltf-transform/core";
import {
  ALL_EXTENSIONS,
  KHRDracoMeshCompression,
} from "@gltf-transform/extensions";
import { draco } from "@gltf-transform/functions";
import draco3d from "draco3dgltf";
import validator from "gltf-validator";
const [input, output, level = "7"] = process.argv.slice(2);
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({
    "draco3d.encoder": await draco3d.createEncoderModule(),
    "draco3d.decoder": await draco3d.createDecoderModule(),
  });
const document = await io.read(input);
await document.transform(
  draco({
    encodeSpeed: 10 - Number(level),
    decodeSpeed: 5,
    quantizePosition: 16,
    method: "edgebreaker",
  }),
);
await io.write(output, document);
const decoded = await io.read(output);
const extension = decoded
  .getRoot()
  .listExtensionsUsed()
  .find((e) => e.extensionName === KHRDracoMeshCompression.EXTENSION_NAME);
if (extension) extension.dispose();
await io.write(output.replace(/\.glb$/, ".decoded.glb"), decoded);
const result = await validator.validateBytes(
  new Uint8Array(await fs.readFile(output)),
  { maxIssues: 100 },
);
await fs.writeFile(
  output.replace(/\.glb$/, ".validator.json"),
  JSON.stringify(result, null, 2),
);
if (result.issues.numErrors)
  throw new Error(`glTF validator: ${result.issues.numErrors} errors`);
