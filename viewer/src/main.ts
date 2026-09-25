import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import {
  mappingFor,
  guidAt,
  type IFCElement,
  type LogicalGroup,
  type Metadata,
  type Selected,
} from "./types";
import { stats, latencyStatus, downloadReport } from "./performance";
import "./style.css";
const el = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const status = el("status"),
  canvas = document.querySelector("canvas")!,
  viewport = el("viewport");
// Presentation only: status pill state (idle/loading/ready/error) and progress bar.
type ViewState = "idle" | "loading" | "ready" | "error";
function setStatus(text: string, state: ViewState, progress?: number) {
  status.textContent = text;
  viewport.dataset.state = state;
  viewport.classList.toggle("is-determinate", progress !== undefined);
  if (progress !== undefined)
    viewport.style.setProperty(
      "--progress",
      String(Math.min(1, Math.max(0, progress))),
    );
}
function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}
function formatValue(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}
const selectionButtons = ["fit-selected", "isolate", "hide", "copy"].map((id) =>
  el<HTMLButtonElement>(id),
);
function renderSummary(elements: number, geometryGroups: number) {
  const stat = (value: number, label: string) => {
    const item = node("span", "stat");
    item.append(
      node("b", undefined, value.toLocaleString("ru-RU")),
      ` ${label}`,
    );
    return item;
  };
  el("model-summary").replaceChildren(
    stat(elements, "элементов"),
    stat(geometryGroups, "групп геометрии"),
    node("span", "badge badge-success", "Сопоставление GUID: пройдено"),
  );
}
function renderElement(data: IFCElement | null, hasMetadata = false) {
  el("inspector").dataset.selected = String(data !== null);
  for (const button of selectionButtons) button.disabled = data === null;
  const view = el("element-view"),
    meta = el("selection-meta");
  if (!data) {
    view.replaceChildren();
    meta.replaceChildren();
    return;
  }
  meta.replaceChildren(
    node("span", "badge badge-blue", String(data.ifcType)),
    node("span", "meta-id", `#${data.expressId}`),
  );
  const attributes = node("dl", "kv");
  const fields: [string, unknown, boolean][] = [
    ["GlobalId", data.guid, true],
    ["Express ID", data.expressId, true],
    ["Класс IFC", data.ifcType, false],
    ["Name", data.name, false],
    ["Tag", data.tag, false],
    ["Description", data.description, false],
    ["ObjectType", data.objectType, false],
  ];
  for (const [label, value, mono] of fields) {
    const text = formatValue(value);
    const row = node("div", "kv-row");
    row.append(
      node("dt", undefined, label),
      node(
        "dd",
        text === null ? "empty" : mono ? "mono" : undefined,
        text ?? "—",
      ),
    );
    attributes.append(row);
  }
  const children: Node[] = [
    node("h3", "section-title", "Атрибуты IFC"),
    attributes,
  ];
  if (!hasMetadata) {
    children.push(
      node(
        "p",
        "note",
        "metadata.json не загружен — показаны данные сопоставления из GLB.",
      ),
    );
  } else {
    const psets =
      data.propertySets && typeof data.propertySets === "object"
        ? Object.entries(data.propertySets)
        : [];
    const title = node("h3", "section-title", "Наборы свойств");
    title.append(node("span", "count", String(psets.length)));
    children.push(title);
    if (!psets.length)
      children.push(node("p", "panel-text", "Наборы свойств отсутствуют"));
    for (const [name, props] of psets) {
      const details = node("details", "pset");
      details.open = true;
      const summary = node("summary");
      summary.append(node("span", "pset-name", name));
      const rows: [string, unknown][] =
        props && typeof props === "object" && !Array.isArray(props)
          ? Object.entries(props)
          : [["Значение", props]];
      const psetId = rows.find(([key]) => key === "id")?.[1];
      if (typeof psetId === "number")
        summary.append(node("span", "pset-id", `#${psetId}`));
      const body = node("tbody");
      for (const [key, value] of rows) {
        if (key === "id" && typeof value === "number") continue;
        const text = formatValue(value);
        const tr = node("tr");
        const th = node("th", undefined, key);
        th.scope = "row";
        tr.append(
          th,
          node("td", text === null ? "empty" : undefined, text ?? "—"),
        );
        body.append(tr);
      }
      const table = node("table", "props");
      table.append(body);
      details.append(summary, table);
      children.push(details);
    }
  }
  view.replaceChildren(...children);
}
const params = new URLSearchParams(location.search);
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setClearColor(0xf3f5f8);
renderer.outputColorSpace = THREE.SRGBColorSpace;
const scene = new THREE.Scene();
scene.add(new THREE.HemisphereLight(0xe7f3ff, 0x536171, 2.5));
const sun = new THREE.DirectionalLight(0xffffff, 2.4);
sun.position.set(100, 180, 70);
scene.add(sun);
const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000000);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
let root: THREE.Object3D | null = null,
  groups: LogicalGroup[] = [],
  meshes: THREE.InstancedMesh[] = [];
let metadata: Metadata = { schemaVersion: 1, elements: {} },
  selected: Selected | null = null;
const hidden = new Set<string>(),
  hiddenStack: Selected[] = [],
  selectionObjects: THREE.Mesh[] = [];
const highlight = new THREE.MeshBasicMaterial({
  color: 0x2f6bff,
  side: THREE.DoubleSide,
  polygonOffset: true,
  polygonOffsetFactor: -2,
  polygonOffsetUnits: -2,
});
let isolated = false,
  modelBounds = new THREE.Box3(),
  generation = 0,
  loading = false,
  modelUrl = "",
  benchmarkRunning = false;
let networkController: AbortController | null = null;
const timing: Record<string, unknown> = {};
const raycaster = new THREE.Raycaster();
const meshGroups = new Map<THREE.InstancedMesh, LogicalGroup>();
const frameTimes: number[] = [];
let lastFrame = performance.now(),
  frameNumber = 0,
  minimumFps = Infinity;
const interaction: Record<string, number[]> = {
  selection: [],
  isolate: [],
  showAll: [],
  hide: [],
};
let lastRaycastMs = 0;
let lastReport: unknown = null;
const afterFrame: ((value: number) => void)[] = [];
function painted(): Promise<number> {
  return new Promise((resolve) => afterFrame.push(resolve));
}
function resize() {
  const w = viewport.clientWidth,
    h = viewport.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
const observer = new ResizeObserver(resize);
observer.observe(viewport);
resize();
// Camera lock on selection: the orbit pivot glides to the selected element's
// centre, so rotating and wheel-zooming always keep the element in view.
const FOCUS_MS = 450;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
let focusAnimation: {
  from: THREE.Vector3;
  to: THREE.Vector3;
  start: number;
} | null = null;
function focusSelected() {
  const box = selectedBounds();
  if (box.isEmpty()) return;
  const to = box.getCenter(new THREE.Vector3());
  if (reducedMotion.matches) {
    focusAnimation = null;
    controls.target.copy(to);
    return;
  }
  focusAnimation = {
    from: controls.target.clone(),
    to,
    start: performance.now(),
  };
}
function syncUi() {
  el<HTMLButtonElement>("clear").disabled = !selected && !isolated;
  el("hidden-bar").hidden = hidden.size === 0;
  el("hidden-count").textContent = `Скрыто: ${hidden.size}`;
}
function fit(box = modelBounds) {
  if (box.isEmpty()) return;
  focusAnimation = null;
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3()).length();
  const distance =
    (size /
      (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) /
      Math.min(1, camera.aspect)) *
    1.1;
  controls.target.copy(center);
  camera.position
    .copy(center)
    .add(new THREE.Vector3(1, 0.8, 1).normalize().multiplyScalar(distance));
  camera.near = Math.max(0.001, size / 10000);
  camera.far = Math.max(100, size * 100);
  camera.updateProjectionMatrix();
  controls.update();
}
function removeSelection() {
  for (const mesh of selectionObjects) scene.remove(mesh);
  selectionObjects.length = 0;
}
function instanceMatrix(
  mesh: THREE.InstancedMesh,
  index: number,
  group: LogicalGroup,
) {
  const m = new THREE.Matrix4().fromArray(
    group.originals.get(mesh)!,
    index * 16,
  );
  return m.premultiply(mesh.matrixWorld);
}
function selectedBounds() {
  const b = new THREE.Box3();
  if (!selected) return b;
  for (const mesh of selected.group.meshes) {
    mesh.geometry.computeBoundingBox();
    b.union(
      mesh.geometry
        .boundingBox!.clone()
        .applyMatrix4(instanceMatrix(mesh, selected.index, selected.group)),
    );
  }
  return b;
}
function select(group: LogicalGroup, index: number) {
  const guid = guidAt(group.mapping, index);
  if (hidden.has(guid)) return;
  removeSelection();
  selected = { group, index, guid };
  for (const mesh of group.meshes) {
    const overlay = new THREE.Mesh(
      mesh.geometry,
      isolated ? mesh.material : highlight,
    );
    overlay.matrixAutoUpdate = false;
    overlay.matrix.copy(instanceMatrix(mesh, index, group));
    overlay.renderOrder = 2;
    scene.add(overlay);
    selectionObjects.push(overlay);
  }
  const data = metadata.elements[guid] ?? {
    guid,
    expressId: group.mapping.instanceExpressIds[index],
    ifcType: group.mapping.instanceTypes[index],
  };
  el("selection-title").textContent = String(data.name || data.ifcType);
  el("properties").textContent = JSON.stringify(data, null, 2);
  renderElement(data, guid in metadata.elements);
  syncUi();
}
function clear() {
  removeSelection();
  selected = null;
  el("selection-title").textContent = "Выберите элемент";
  el("properties").textContent = "Нет выбранного элемента";
  renderElement(null);
  syncUi();
}
async function measure(
  kind: string,
  action: () => void,
  started = performance.now(),
) {
  action();
  await painted();
  await painted();
  const ms = performance.now() - started;
  interaction[kind].push(ms);
  return ms;
}
// In isolation the selected element is shown with its own IFC materials
// (no blue highlight) so it can be inspected as is; "Вся модель" restores it.
function setSelectionMaterial(highlighted: boolean) {
  if (!selected) return;
  selected.group.meshes.forEach((mesh, i) => {
    const overlay = selectionObjects[i];
    if (overlay) overlay.material = highlighted ? highlight : mesh.material;
  });
}
function isolate() {
  if (!selected) return;
  isolated = true;
  for (const group of groups) group.object.visible = false;
  setSelectionMaterial(false);
  syncUi();
}
function showAll() {
  isolated = false;
  setSelectionMaterial(true);
  hidden.clear();
  hiddenStack.length = 0;
  for (const group of groups) {
    group.object.visible = true;
    for (const mesh of group.meshes) {
      mesh.instanceMatrix.array.set(group.originals.get(mesh)!);
      mesh.instanceMatrix.needsUpdate = true;
    }
  }
  syncUi();
}
function hide() {
  if (!selected) return;
  const { group, index, guid } = selected;
  hidden.add(guid);
  hiddenStack.push(selected);
  for (const mesh of group.meshes) {
    mesh.setMatrixAt(index, new THREE.Matrix4().makeScale(0, 0, 0));
    mesh.instanceMatrix.needsUpdate = true;
  }
  clear();
}
// Restores the most recently hidden element and selects it again.
function undoHide() {
  const last = hiddenStack.pop();
  if (!last) return;
  hidden.delete(last.guid);
  const offset = last.index * 16;
  for (const mesh of last.group.meshes) {
    mesh.instanceMatrix.array.set(
      last.group.originals.get(mesh)!.subarray(offset, offset + 16),
      offset,
    );
    mesh.instanceMatrix.needsUpdate = true;
  }
  select(last.group, last.index);
}
function pick(
  clientX: number,
  clientY: number,
  started = performance.now(),
  focus = false,
) {
  const rect = canvas.getBoundingClientRect();
  raycaster.setFromCamera(
    new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      (-(clientY - rect.top) / rect.height) * 2 + 1,
    ),
    camera,
  );
  const before = performance.now();
  const hits = raycaster.intersectObjects(
    meshes.filter((m) => meshGroups.get(m)!.object.visible),
    false,
  );
  lastRaycastMs = performance.now() - before;
  const hit = hits.find(
    (h) =>
      h.instanceId !== undefined &&
      !hidden.has(
        guidAt(
          meshGroups.get(h.object as THREE.InstancedMesh)!.mapping,
          h.instanceId,
        ),
      ),
  );
  return measure(
    "selection",
    () => {
      if (hit) {
        select(
          meshGroups.get(hit.object as THREE.InstancedMesh)!,
          hit.instanceId!,
        );
        if (focus) focusSelected();
      } else if (!isolated) clear();
    },
    started,
  );
}
let down: { x: number; y: number } | null = null;
canvas.addEventListener("pointerdown", (e) => {
  if (e.button === 0) down = { x: e.clientX, y: e.clientY };
});
canvas.addEventListener("pointerup", (e) => {
  if (
    e.button === 0 &&
    down &&
    Math.hypot(e.clientX - down.x, e.clientY - down.y) < 4
  )
    void pick(e.clientX, e.clientY, e.timeStamp, true);
  down = null;
});
function disposeObject(object: THREE.Object3D) {
  const geometries = new Set<THREE.BufferGeometry>(),
    materials = new Set<THREE.Material>(),
    textures = new Set<THREE.Texture>();
  object.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      geometries.add(o.geometry);
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        materials.add(m);
        for (const value of Object.values(m))
          if (value instanceof THREE.Texture) textures.add(value);
      }
    }
  });
  for (const g of geometries) g.dispose();
  for (const m of materials) m.dispose();
  for (const t of textures) t.dispose();
}
function unload() {
  clear();
  if (root) {
    scene.remove(root);
    disposeObject(root);
  }
  root = null;
  groups = [];
  meshes = [];
  meshGroups.clear();
  hidden.clear();
  hiddenStack.length = 0;
  isolated = false;
  focusAnimation = null;
  syncUi();
}
async function fetchModel(url: string, signal: AbortSignal) {
  const start = performance.now();
  const response = await fetch(url, {
    signal,
    cache: params.has("cold") ? "no-store" : "default",
  });
  if (!response.ok) throw new Error(`GLB: ошибка HTTP ${response.status}`);
  const total = Number(response.headers.get("content-length"));
  const reader = response.body!.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    setStatus(
      `Загрузка GLB: ${(received / 1048576).toFixed(1)} МиБ${total ? " / " + (total / 1048576).toFixed(1) : ""}`,
      "loading",
      total ? received / total : undefined,
    );
  }
  const all = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.length;
  }
  timing.downloadMs = performance.now() - start;
  timing.downloadBytes = received;
  return all.buffer;
}
async function load(model: string | File, sidecar?: File) {
  const token = ++generation;
  networkController?.abort();
  networkController = new AbortController();
  loading = true;
  unload();
  metadata = { schemaVersion: 1, elements: {} };
  modelUrl = typeof model === "string" ? model : model.name;
  setStatus("Загрузка…", "loading");
  type Decode = (
    buffer: ArrayBuffer,
    callback: (geometry: THREE.BufferGeometry) => void,
    attributeIDs?: Record<string, number>,
    attributeTypes?: Record<string, string>,
    vertexColorSpace?: string,
    onError?: (error: Error) => void,
  ) => Promise<THREE.BufferGeometry>;
  const draco = new DRACOLoader() as DRACOLoader & { decodeDracoFile: Decode };
  draco.setDecoderPath("/draco/");
  draco.setWorkerLimit(4);
  const loader = new GLTFLoader();
  loader.setDRACOLoader(draco);
  // The public decode callback measures request→decoded geometry, including worker scheduling.
  const decodeTimes: number[] = [];
  const originalDecode = draco.decodeDracoFile.bind(draco);
  draco.decodeDracoFile = (...args: Parameters<Decode>) => {
    const start = performance.now();
    const callback = args[1];
    args[1] = (geometry) => {
      decodeTimes.push(performance.now() - start);
      callback(geometry);
    };
    return originalDecode(...args);
  };
  try {
    const bytes =
      typeof model === "string"
        ? await fetchModel(model, networkController.signal)
        : await model.arrayBuffer();
    if (token !== generation) return;
    setStatus("Разбор GLB и распаковка Draco…", "loading");
    const start = performance.now();
    const gltf = await loader.parseAsync(bytes, "");
    timing.glbParseIncludingDracoMs = performance.now() - start;
    timing.dracoRequests = stats(decodeTimes);
    timing.dracoTimingDefinition =
      "Per primitive request-to-callback; overlapping worker tasks, do not sum as wall time";
    if (token !== generation) {
      disposeObject(gltf.scene);
      return;
    }
    root = gltf.scene;
    scene.add(root);
    root.updateMatrixWorld(true);
    const logical = new Map<THREE.Object3D, LogicalGroup>();
    root.traverse((object) => {
      if (!(object instanceof THREE.InstancedMesh)) return;
      const found = mappingFor(object);
      if (!found)
        throw new Error(`FAIL: у меша нет IFC-сопоставления ${object.name}`);
      let group = logical.get(found.object);
      if (!group) {
        group = {
          object: found.object,
          mapping: found.mapping,
          meshes: [],
          originals: new Map(),
        };
        logical.set(found.object, group);
      }
      if (object.count !== group.mapping.instanceGuids.length)
        throw new Error("FAIL: число экземпляров не совпадает с числом GUID");
      group.meshes.push(object);
      group.originals.set(
        object,
        new Float32Array(object.instanceMatrix.array),
      );
      meshes.push(object);
      meshGroups.set(object, group);
      object.computeBoundingSphere();
      object.computeBoundingBox();
    });
    groups = [...logical.values()];
    const guids = groups.flatMap((g) => g.mapping.instanceGuids);
    if (new Set(guids).size !== guids.length)
      throw new Error("FAIL: повторяющиеся GUID в сопоставлении");
    if (!guids.length)
      throw new Error("FAIL: нет доступных для выбора элементов");
    modelBounds.setFromObject(root);
    fit();
    timing.mappingCount = guids.length;
    timing.geometryGroups = groups.length;
    const upload = performance.now();
    renderer.render(scene, camera);
    timing.firstRenderCpuSubmitMs = performance.now() - upload;
    timing.gpuUploadMs = null;
    timing.gpuUploadNote =
      "Not separately measurable without GPU timing instrumentation";
    renderSummary(guids.length, groups.length);
    if (sidecar) {
      metadata = JSON.parse(await sidecar.text()) as Metadata;
    } else if (typeof model === "string") {
      const url = new URL(model, location.href);
      url.pathname = url.pathname.replace(/[^/]+$/, "metadata.json");
      const start = performance.now();
      const result = await fetch(url, {
        signal: networkController.signal,
        cache: params.has("cold") ? "no-store" : "default",
      });
      if (result.ok) metadata = (await result.json()) as Metadata;
      timing.metadataFetchAndParseMs = performance.now() - start;
    }
    if (token !== generation) return;
    setStatus(
      `Готово · ${modelUrl.split("/").at(-1)} · каждый экземпляр имеет GlobalId`,
      "ready",
    );
    loading = false;
    frameTimes.length = 0;
    minimumFps = Infinity;
    if (params.get("benchmark") === "1") void benchmark();
  } catch (error) {
    if (token !== generation) return;
    loading = false;
    unload();
    setStatus(
      `Ошибка: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
    console.error(error);
  } finally {
    draco.dispose();
  }
}
let orbitStart: number | null = null;
let orbitDuration = 10000;
let benchmarkFrames: number[] = [];
let benchmarkDraws: number[] = [];
let benchmarkTriangles: number[] = [];
function animate(now: number) {
  const delta = now - lastFrame;
  lastFrame = now;
  frameTimes.push(delta);
  if (frameTimes.length > 300) frameTimes.shift();
  if (!loading && root) minimumFps = Math.min(minimumFps, 1000 / delta);
  if (orbitStart !== null) {
    const angle = ((now - orbitStart) / orbitDuration) * 2 * Math.PI;
    const center = modelBounds.getCenter(new THREE.Vector3());
    const radius = modelBounds.getSize(new THREE.Vector3()).length() * 0.9;
    controls.target.copy(center);
    camera.position.set(
      center.x + Math.cos(angle) * radius,
      center.y + radius * 0.65,
      center.z + Math.sin(angle) * radius,
    );
  }
  if (focusAnimation) {
    const t = Math.min(1, (now - focusAnimation.start) / FOCUS_MS);
    controls.target.lerpVectors(
      focusAnimation.from,
      focusAnimation.to,
      1 - (1 - t) ** 3,
    );
    if (t === 1) focusAnimation = null;
  }
  controls.update();
  renderer.render(scene, camera);
  frameNumber++;
  if (orbitStart !== null) {
    benchmarkFrames.push(delta);
    benchmarkDraws.push(renderer.info.render.calls);
    benchmarkTriangles.push(renderer.info.render.triangles);
  }
  if (frameNumber % 15 === 0) {
    const s = stats(frameTimes);
    const memory = (
      performance as Performance & { memory?: { usedJSHeapSize: number } }
    ).memory;
    const ms = (values: number[]) => values.at(-1)?.toFixed(1) ?? "—";
    el("metrics").textContent = [
      `Кадров/с: сейчас ${(1000 / delta).toFixed(1)} / средн. ${(1000 / s.mean).toFixed(1)} / мин ${Number.isFinite(minimumFps) ? minimumFps.toFixed(1) : "—"}`,
      `Время кадра: p50 ${s.p50.toFixed(1)} мс / p95 ${s.p95.toFixed(1)} мс`,
      `Вызовов отрисовки ${renderer.info.render.calls.toLocaleString("ru-RU")} · треугольников ${renderer.info.render.triangles.toLocaleString("ru-RU")}`,
      `Геометрий ${renderer.info.memory.geometries} · текстур ${renderer.info.memory.textures}`,
      `Память JS ${memory ? (memory.usedJSHeapSize / 1048576).toFixed(0) + " МиБ" : "недоступно"}`,
      `Рейкаст ${lastRaycastMs.toFixed(1)} мс · выбор ${ms(interaction.selection)} мс`,
      `Изоляция ${ms(interaction.isolate)} мс · вся модель ${ms(interaction.showAll)} мс`,
    ].join("\n");
  }
  const completed = afterFrame.splice(0);
  for (const fn of completed) fn(now);
}
renderer.setAnimationLoop(animate);
async function forDuration(ms: number) {
  const start = performance.now();
  while (performance.now() - start < ms) await painted();
}
const latencyLabel: Record<string, string> = {
  PASS: "в норме",
  PASS_WITH_LIMITATIONS: "с ограничениями",
  FAIL: "превышена",
};
async function benchmark() {
  if (!root || loading || benchmarkRunning) return;
  benchmarkRunning = true;
  el<HTMLButtonElement>("benchmark").disabled = true;
  showAll();
  clear();
  fit();
  const label = el("benchmark-status");
  label.textContent = "Прогрев 3 с…";
  await forDuration(3000);
  benchmarkFrames = [];
  benchmarkDraws = [];
  benchmarkTriangles = [];
  orbitStart = performance.now();
  label.textContent = "Измерение FPS: орбита 10 с…";
  const start = performance.now();
  await forDuration(10000);
  const elapsed = performance.now() - start;
  orbitStart = null;
  fit();
  await painted();
  label.textContent = "Проверка выбора, изоляции и показа всей модели…";
  const selections: number[] = [];
  const raycasts: number[] = [];
  const pointerResults = [];
  const rect = canvas.getBoundingClientRect();
  for (const [x, y] of [
    [0.5, 0.5],
    [0.35, 0.5],
    [0.65, 0.5],
    [0.5, 0.35],
    [0.5, 0.65],
  ]) {
    const ms = await pick(
      rect.left + rect.width * x,
      rect.top + rect.height * y,
    );
    raycasts.push(lastRaycastMs);
    pointerResults.push({ x, y, latencyMs: ms, guid: selected?.guid ?? null });
  }
  const all = groups.flatMap((group) =>
    group.mapping.instanceGuids.map((guid, index) => ({ group, index, guid })),
  );
  const sampled = [];
  for (let i = 0; i < Math.min(100, all.length); i++) {
    const item = all[Math.floor((i * all.length) / Math.min(100, all.length))];
    selections.push(
      await measure("selection", () => select(item.group, item.index)),
    );
    sampled.push({
      expected: item.guid,
      actual: selected?.guid,
      index: item.index,
      highlightedPrimitiveCount: selectionObjects.length,
    });
  }
  const isolateMs = await measure("isolate", isolate);
  const showAllMs = await measure("showAll", showAll);
  clear();
  const gl = renderer.getContext();
  const debug = gl.getExtension("WEBGL_debug_renderer_info");
  const frameStats = stats(benchmarkFrames);
  const maxLatency = Math.max(
    ...selections,
    ...pointerResults.map((x) => x.latencyMs),
    isolateMs,
    showAllMs,
  );
  const report = {
    schemaVersion: 1,
    timestamp: new Date().toISOString(),
    userAgent: navigator.userAgent,
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemoryGiB:
      (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? null,
    screen: { width: screen.width, height: screen.height },
    viewport: {
      width: canvas.clientWidth,
      height: canvas.clientHeight,
      pixelRatio: renderer.getPixelRatio(),
    },
    webglRenderer: debug
      ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)
      : null,
    referenceHardwareStatus: "REFERENCE_HARDWARE_NOT_USED",
    model: {
      url: modelUrl,
      elements: all.length,
      groups: groups.length,
      bounds: {
        min: modelBounds.min.toArray(),
        max: modelBounds.max.toArray(),
      },
      drawCalls: stats(benchmarkDraws),
      triangles: stats(benchmarkTriangles),
    },
    loading: timing,
    navigation: {
      scenario:
        "one 360-degree orbit; radius=0.9*bbox diagonal; elevation=0.65*radius",
      warmupMs: 3000,
      durationMs: elapsed,
      frameTimesMs: benchmarkFrames,
      frameStats,
      fps: 1000 / frameStats.mean,
      minFps: 1000 / frameStats.max,
      nonemptyScene: benchmarkTriangles.every((n) => n > 0),
    },
    interactions: {
      definition:
        "event/action start to two completed rendered animation frames; CPU/render submission + next frame, not compositor presentation timestamp",
      raycaster: "standard Three.js",
      raycastMs: stats(raycasts),
      pointerResults,
      selectionMs: stats(selections),
      isolateMs,
      showAllMs,
      maxLatencyMs: maxLatency,
      status: latencyStatus(maxLatency),
    },
    guidSelection: {
      status: sampled.every((s) => s.expected === s.actual) ? "PASS" : "FAIL",
      samples: sampled,
    },
    officialFpsStatus: "REFERENCE_HARDWARE_NOT_USED",
  };
  lastReport = report;
  el("benchmark-report").textContent = JSON.stringify(report, null, 2);
  el<HTMLButtonElement>("download").disabled = false;
  label.textContent = `Готово: ${report.navigation.fps.toFixed(1)} FPS · задержка интерфейса: ${latencyLabel[report.interactions.status]} · эталонный ПК не использовался`;
  benchmarkRunning = false;
  el<HTMLButtonElement>("benchmark").disabled = false;
  try {
    await fetch("/__reports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(report),
    });
  } catch {
    /* Download remains available on static hosting. */
  }
  if (params.has("download")) downloadReport(report);
}
// "Вся модель": restores hidden/isolated elements (former Show all) and
// returns the camera to the default diagonal overview of the whole model.
el("fit").onclick = () =>
  void measure("showAll", () => {
    showAll();
    fit();
  });
el("clear").onclick = () => {
  if (isolated) showAll();
  clear();
};
el("isolate").onclick = () => void measure("isolate", isolate);
el("hide").onclick = () => void measure("hide", hide);
el("undo-hide").onclick = undoHide;
el("fit-selected").onclick = () => fit(selectedBounds());
el("copy").onclick = () => {
  if (selected)
    void navigator.clipboard.writeText(selected.guid).then(() => {
      const button = el("copy");
      button.classList.add("is-done");
      setTimeout(() => button.classList.remove("is-done"), 1400);
    });
};
el("benchmark").onclick = () => void benchmark();
el("download").onclick = () => downloadReport(lastReport);
async function files(list: File[]) {
  const model = list.find((f) => f.name.toLowerCase().endsWith(".glb"));
  const md = list.find((f) => f.name === "metadata.json");
  if (model) await load(model, md);
  else if (md) {
    metadata = JSON.parse(await md.text());
    if (selected) select(selected.group, selected.index);
  }
}
el<HTMLInputElement>("files").onchange = (e) =>
  void files(Array.from((e.target as HTMLInputElement).files ?? []));
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => {
  e.preventDefault();
  void files(Array.from(e.dataTransfer?.files ?? []));
});
window.addEventListener(
  "pagehide",
  () => {
    networkController?.abort();
    renderer.setAnimationLoop(null);
    observer.disconnect();
    controls.dispose();
    unload();
    highlight.dispose();
    renderer.dispose();
  },
  { once: true },
);
void load(params.get("model") ?? "/models/km/model.glb");
// Explicitly enabled developer diagnostics for reproducible pointer-event tests.
if (params.get("test") === "1") {
  const diagnostics = {
    state: () => ({
      selectedGuid: selected?.guid ?? null,
      highlightedElements: selected ? 1 : 0,
      highlightedPrimitives: selectionObjects.length,
      isolated,
      hiddenCount: hidden.size,
      focusing: focusAnimation !== null,
      camera: camera.position.toArray(),
      target: controls.target.toArray(),
      selectedCenter: selected
        ? selectedBounds().getCenter(new THREE.Vector3()).toArray()
        : null,
      mappedGuids: groups.reduce(
        (n, g) => n + g.mapping.instanceGuids.length,
        0,
      ),
    }),
    targets: () => {
      const result: { x: number; y: number; guid: string }[] = [];
      const rect = canvas.getBoundingClientRect();
      for (const group of groups)
        for (let i = 0; i < group.mapping.instanceGuids.length; i++) {
          const mesh = group.meshes[0],
            p = mesh.geometry.attributes.position,
            index = mesh.geometry.index;
          if (!index) continue;
          const target = new THREE.Vector3();
          for (let j = 0; j < 3; j++)
            target.add(
              new THREE.Vector3().fromBufferAttribute(p, index.getX(j)),
            );
          target
            .multiplyScalar(1 / 3)
            .applyMatrix4(instanceMatrix(mesh, i, group));
          raycaster.set(
            camera.position,
            target.clone().sub(camera.position).normalize(),
          );
          const hit = raycaster.intersectObjects(meshes, false)[0];
          if (!hit || hit.instanceId === undefined) continue;
          target.copy(hit.point).project(camera);
          if (Math.abs(target.x) > 1 || Math.abs(target.y) > 1) continue;
          result.push({
            x: rect.left + ((target.x + 1) * rect.width) / 2,
            y: rect.top + ((1 - target.y) * rect.height) / 2,
            guid: guidAt(
              meshGroups.get(hit.object as THREE.InstancedMesh)!.mapping,
              hit.instanceId,
            ),
          });
          if (result.length >= 100) return result;
        }
      return result;
    },
  };
  (window as Window & { __ifcTest?: typeof diagnostics }).__ifcTest =
    diagnostics;
}
