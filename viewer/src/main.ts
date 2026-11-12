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
  type ModelSet,
  type ModelSource,
  type SbzhData,
  type SbzhRecord,
  type SbzhRow,
  type Selected,
  type Storey,
} from "./types";
import {
  combine,
  concrete,
  downloadCsv,
  fmt,
  recordRows,
  rowKey,
  span,
  type SbzhSet,
} from "./sbzh";
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
function renderSummary(elements: number, geometryGroups: number, models = 1) {
  const stat = (value: number, label: string) => {
    const item = node("span", "stat");
    item.append(
      node("b", undefined, value.toLocaleString("ru-RU")),
      ` ${label}`,
    );
    return item;
  };
  el("model-summary").replaceChildren(
    ...(models > 1
      ? [stat(models, plural(models, "модель", "модели", "моделей"))]
      : []),
    stat(elements, "элементов"),
    stat(geometryGroups, "групп геометрии"),
    node("span", "badge badge-success", "Сопоставление GUID: пройдено"),
  );
}
function renderElement(
  data: IFCElement | null,
  hasMetadata = false,
  modelId?: string,
) {
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
    ["Модель", modelId ? modelName(modelId) : null, false],
    ["Тип", data.typeName, false],
    ["Этаж", data.storey, false],
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
  const product = data.sbzh as SbzhRecord | undefined;
  if (product) {
    const title = node("h3", "section-title", "Изделие СБЖ");
    title.append(node("span", "badge badge-amber", "сборный ж/б"));
    const list = node("dl", "kv");
    for (const [label, value] of recordRows(product)) {
      const row = node("div", "kv-row");
      row.append(node("dt", undefined, label), node("dd", undefined, value));
      list.append(row);
    }
    children.push(title, list);
    const row = modelId ? sbzhByKey.get(`${modelId}::${product.mark}`) : null;
    if (row) {
      const button = node(
        "button",
        "btn btn-secondary btn-sm mark-link",
        `Все изделия марки ${row.mark} · ${row.count} шт`,
      );
      button.type = "button";
      button.onclick = () => {
        showTab("sbzh");
        highlightMark(row, true);
      };
      children.push(button);
    }
  }
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
// Federation root: one child scene per loaded model, each in its own (shared)
// IFC world coordinates — nothing is moved to make models line up.
let root: THREE.Group | null = null,
  groups: LogicalGroup[] = [],
  meshes: THREE.InstancedMesh[] = [];
interface LoadedModel {
  source: ModelSource;
  object: THREE.Object3D;
  elements: number;
}
let loadedModels: LoadedModel[] = [];
let currentSet: ModelSet | null = null;
const guidIndex = new Map<string, { group: LogicalGroup; index: number }>();
let sbzh: SbzhSet = combine([]);
const sbzhByKey = new Map<string, SbzhRow>();
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
// Amber overlay for "all products of a mark"; blue stays for the single pick.
const markMaterial = new THREE.MeshBasicMaterial({
  color: 0xf59e0b,
  side: THREE.DoubleSide,
  polygonOffset: true,
  polygonOffsetFactor: -2,
  polygonOffsetUnits: -2,
});
interface MarkOverlay {
  overlay: THREE.InstancedMesh;
  mesh: THREE.InstancedMesh;
  model: string;
}
let mark: { row: SbzhRow; overlays: MarkOverlay[]; isolated: boolean } | null =
  null;
type Axis = "x" | "y" | "z";
const section = {
  enabled: false,
  axis: "y" as Axis,
  value: 0,
  flipped: false,
  plane: new THREE.Plane(),
};
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
  el<HTMLButtonElement>("clear").disabled = !selected && !isolated && !mark;
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
      isolated && !mark?.isolated ? mesh.material : highlight,
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
  renderElement(data, guid in metadata.elements, group.model);
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
  clearMark();
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
  for (const model of loadedModels) model.object.visible = true;
  if (mark) {
    mark.isolated = false;
    for (const o of mark.overlays) {
      o.overlay.material = markMaterial;
      o.overlay.visible = true;
    }
    renderMarkCard();
  }
  setSectionEnabled(false);
  renderModels();
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
  if (mark?.row.guids.includes(guid)) highlightMark(mark.row);
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
  if (mark?.row.guids.includes(last.guid)) highlightMark(mark.row);
  select(last.group, last.index);
}
function plural(n: number, one: string, few: string, many: string) {
  const a = n % 10,
    b = n % 100;
  if (a === 1 && b !== 11) return one;
  if (a >= 2 && a <= 4 && (b < 12 || b > 14)) return few;
  return many;
}
function modelName(id: string) {
  return loadedModels.find((m) => m.source.id === id)?.source.name ?? id;
}
function modelVisible(id: string) {
  return loadedModels.find((m) => m.source.id === id)?.object.visible ?? true;
}
function isShown(mesh: THREE.InstancedMesh) {
  const group = meshGroups.get(mesh)!;
  return group.object.visible && modelVisible(group.model);
}

// ─── Section plane ────────────────────────────────────────────
// Three.js discards fragments with a negative signed distance, so by default
// the plane keeps everything below / before the chosen coordinate.
const axisVectors: Record<Axis, THREE.Vector3> = {
  x: new THREE.Vector3(1, 0, 0),
  y: new THREE.Vector3(0, 1, 0),
  z: new THREE.Vector3(0, 0, 1),
};
function clippedAway(point: THREE.Vector3) {
  return section.enabled && section.plane.distanceToPoint(point) < 0;
}
function sectionRange(axis = section.axis) {
  const k = axis === "x" ? 0 : axis === "y" ? 1 : 2;
  return {
    min: modelBounds.min.getComponent(k),
    max: modelBounds.max.getComponent(k),
  };
}
function applySection() {
  const normal = axisVectors[section.axis]
    .clone()
    .multiplyScalar(section.flipped ? 1 : -1);
  section.plane.set(normal, section.flipped ? -section.value : section.value);
  renderer.clippingPlanes = section.enabled ? [section.plane] : [];
  syncSectionUi();
}
function setSectionEnabled(enabled: boolean) {
  if (enabled && modelBounds.isEmpty()) return;
  if (enabled && !section.enabled) {
    const { min, max } = sectionRange();
    if (section.value < min || section.value > max)
      section.value = (min + max) / 2;
  }
  section.enabled = enabled;
  applySection();
}
function setSection(axis: Axis, value: number, flipped = false) {
  section.axis = axis;
  section.value = value;
  section.flipped = flipped;
  section.enabled = true;
  applySection();
}
function sectionLabel() {
  const v = section.value;
  if (section.axis === "y") return `Отметка ${fmt(v)} м`;
  // glTF Y-up: IFC X = x, IFC Y = −z.
  return section.axis === "x" ? `X = ${fmt(v)} м` : `Y = ${fmt(-v)} м`;
}
function syncSectionUi() {
  el<HTMLInputElement>("section-on").checked = section.enabled;
  for (const b of document.querySelectorAll<HTMLButtonElement>("[data-axis]"))
    b.setAttribute("aria-pressed", String(b.dataset.axis === section.axis));
  const { min, max } = sectionRange();
  const range = el<HTMLInputElement>("section-range");
  range.disabled = !section.enabled;
  range.value = String(max > min ? (section.value - min) / (max - min) : 0);
  el("section-value").textContent = section.enabled ? sectionLabel() : "—";
  for (const id of ["section-flip", "section-off"])
    el<HTMLButtonElement>(id).disabled = !section.enabled;
}
function storeys(): Storey[] {
  if (currentSet?.storeys?.length) return currentSet.storeys;
  return [];
}
function renderSectionPanel() {
  const list = el("section-storeys");
  const items = storeys();
  list.replaceChildren(
    ...items.map((s) => {
      const b = node("button", "storey");
      b.type = "button";
      b.append(
        node("span", undefined, s.name),
        node("span", "storey-elev", `${fmt(s.elevationMeters, 2)} м`),
      );
      b.onclick = () => setSection("y", s.elevationMeters + 1.2);
      return b;
    }),
  );
  if (!items.length)
    list.append(
      node("p", "panel-text", "В модели нет данных об этажах для плана."),
    );
  syncSectionUi();
}
el<HTMLInputElement>("section-on").onchange = (e) =>
  setSectionEnabled((e.target as HTMLInputElement).checked);
for (const b of document.querySelectorAll<HTMLButtonElement>("[data-axis]"))
  b.onclick = () => {
    const axis = b.dataset.axis as Axis;
    const { min, max } = sectionRange(axis);
    setSection(axis, (min + max) / 2, section.flipped);
  };
el<HTMLInputElement>("section-range").oninput = (e) => {
  const { min, max } = sectionRange();
  section.value =
    min + (max - min) * Number((e.target as HTMLInputElement).value);
  applySection();
};
el("section-flip").onclick = () => {
  section.flipped = !section.flipped;
  applySection();
};
el("section-off").onclick = () => setSectionEnabled(false);

// ─── Precast (СБЖ) marks ──────────────────────────────────────
function clearMark() {
  if (!mark) return;
  if (mark.isolated) {
    isolated = false;
    for (const group of groups) group.object.visible = true;
  }
  for (const o of mark.overlays) {
    scene.remove(o.overlay);
    o.overlay.dispose();
  }
  mark = null;
  renderMarkCard();
  markActiveRow();
  syncUi();
}
/** One extra InstancedMesh per geometry primitive holds all products of the mark. */
function highlightMark(row: SbzhRow, fitView = false) {
  const keepIsolated = mark?.isolated && mark.row === row;
  clearMark();
  const byGroup = new Map<LogicalGroup, number[]>();
  for (const guid of row.guids) {
    const found = guidIndex.get(guid);
    if (!found || hidden.has(guid)) continue;
    const list = byGroup.get(found.group) ?? [];
    list.push(found.index);
    byGroup.set(found.group, list);
  }
  const overlays: MarkOverlay[] = [];
  const matrix = new THREE.Matrix4();
  for (const [group, indices] of byGroup)
    for (const mesh of group.meshes) {
      const overlay = new THREE.InstancedMesh(
        mesh.geometry,
        markMaterial,
        indices.length,
      );
      const originals = group.originals.get(mesh)!;
      indices.forEach((index, k) =>
        overlay.setMatrixAt(k, matrix.fromArray(originals, index * 16)),
      );
      overlay.userData.guids = indices.map(
        (i) => group.mapping.instanceGuids[i],
      );
      overlay.matrixAutoUpdate = false;
      overlay.matrix.copy(mesh.matrixWorld);
      overlay.matrixWorldNeedsUpdate = true;
      overlay.renderOrder = 1;
      overlay.computeBoundingSphere();
      overlay.computeBoundingBox();
      overlay.visible = modelVisible(group.model);
      scene.add(overlay);
      overlays.push({ overlay, mesh, model: group.model });
    }
  mark = { row, overlays, isolated: false };
  if (keepIsolated) isolateMark();
  renderMarkCard();
  markActiveRow();
  syncUi();
  if (fitView) fit(markBounds());
}
function markBounds() {
  const box = new THREE.Box3();
  for (const { overlay } of mark?.overlays ?? [])
    if (overlay.boundingBox)
      box.union(overlay.boundingBox.clone().applyMatrix4(overlay.matrix));
  return box;
}
// Isolated mark: only its products remain, drawn in their own IFC colours.
function isolateMark() {
  if (!mark) return;
  clear();
  isolated = true;
  mark.isolated = true;
  for (const group of groups) group.object.visible = false;
  for (const o of mark.overlays) o.overlay.material = o.mesh.material;
  renderMarkCard();
  syncUi();
}
let sbzhQuery = "";
function renderSbzh() {
  const has = sbzh.rows.length > 0;
  el("sbzh-empty").hidden = has;
  el("sbzh-content").hidden = !has;
  const t = sbzh.totals;
  const tile = (value: string, label: string) => {
    const item = node("div", "mini-stat");
    item.append(node("b", undefined, value), node("span", undefined, label));
    return item;
  };
  el("sbzh-summary").replaceChildren(
    ...(has
      ? [
          tile(fmt(t.marks, 0), plural(t.marks, "марка", "марки", "марок")),
          tile(
            fmt(t.products, 0),
            plural(t.products, "изделие", "изделия", "изделий"),
          ),
          tile(fmt(t.volumeM3, 1), "м³ бетона"),
          tile(fmt(t.massT, 1), "т (расчётная)"),
        ]
      : []),
  );
  el("tab-btn-sbzh").dataset.count = has ? fmt(t.products, 0) : "";
  renderSbzhRows();
  renderMarkCard();
}
function renderSbzhRows() {
  const q = sbzhQuery.trim().toLowerCase();
  const rows = sbzh.rows.filter(
    (r) =>
      !q ||
      [r.mark, r.name, r.kind, r.concreteGrade]
        .filter(Boolean)
        .some((v) => v!.toLowerCase().includes(q)),
  );
  const body = el("sbzh-rows");
  const shown = rows.slice(0, 1500);
  body.replaceChildren(
    ...shown.map((r) => {
      const tr = node("tr");
      tr.dataset.key = rowKey(r);
      tr.tabIndex = 0;
      const nameCell = node("td", "name", r.name ?? "—");
      if (r.kind) nameCell.append(node("small", undefined, r.kind));
      tr.append(
        node("td", "mark", r.mark),
        nameCell,
        node("td", "num", fmt(r.count, 0)),
        node("td", "num", fmt(r.volumeTotalM3, 2)),
        node("td", "num", fmt(r.massTotalT, 1)),
      );
      tr.onclick = () => highlightMark(r, true);
      tr.onkeydown = (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          highlightMark(r, true);
        }
      };
      return tr;
    }),
  );
  if (!rows.length) {
    const tr = node("tr");
    const td = node("td", "empty-row", "Ничего не найдено");
    td.colSpan = 5;
    tr.append(td);
    body.append(tr);
  }
  markActiveRow();
}
function markActiveRow() {
  const key = mark ? rowKey(mark.row) : null;
  for (const tr of el("sbzh-rows").querySelectorAll<HTMLElement>("tr"))
    tr.classList.toggle("is-active", tr.dataset.key === key);
}
function renderMarkCard() {
  const card = el("sbzh-active");
  card.hidden = !mark;
  if (!mark) return card.replaceChildren();
  const r = mark.row;
  const head = node("div", "sbzh-active-head");
  head.append(
    node("span", "badge badge-amber", r.mark),
    node("span", "panel-text", [r.name, r.kind].filter(Boolean).join(" · ")),
  );
  const list = node("dl", "kv");
  const rows: [string, string][] = [
    ["Количество", `${fmt(r.count, 0)} шт`],
    ["Бетон", concrete(r)],
    ["Арматура", r.reinforcementClass ?? "—"],
    ["Код ЭЛ", r.elementCode ?? "—"],
    ["Объём ед.", `${span(r.unitVolumeM3)} м³`],
    ["Объём всего", `${fmt(r.volumeTotalM3)} м³`],
    ["Масса ед. (расч.)", `${span(r.unitMassT)} т`],
    ["Масса всего (расч.)", `${fmt(r.massTotalT)} т`],
    ["Модель", r.model ? modelName(r.model) : "—"],
    ["Этажи", r.storey ?? "—"],
  ];
  for (const [label, value] of rows) {
    const row = node("div", "kv-row");
    row.append(node("dt", undefined, label), node("dd", undefined, value));
    list.append(row);
  }
  const actions = node("div", "actions");
  const button = (text: string, cls: string, onclick: () => void) => {
    const b = node("button", `btn btn-sm ${cls}`, text);
    b.type = "button";
    b.onclick = onclick;
    return b;
  };
  actions.append(
    button("Показать на модели", "btn-secondary", () => fit(markBounds())),
    mark.isolated
      ? button("Показать всю модель", "btn-secondary", () => {
          showAll();
          fit();
        })
      : button("Изолировать марку", "btn-secondary", () => {
          isolateMark();
          fit(markBounds());
        }),
    button("Снять подсветку", "btn-ghost", clearMark),
  );
  card.replaceChildren(head, list, actions);
}
el<HTMLInputElement>("sbzh-search").oninput = (e) => {
  sbzhQuery = (e.target as HTMLInputElement).value;
  renderSbzhRows();
};
el("sbzh-csv").onclick = () =>
  downloadCsv(
    sbzh,
    `СБЖ_спецификация_${(currentSet?.id ?? loadedModels[0]?.source.id ?? "модель").replace(/[^\p{L}\p{N}_-]+/gu, "_")}.csv`,
  );

// ─── Models of the set ────────────────────────────────────────
function setModelVisible(id: string, visible: boolean) {
  const model = loadedModels.find((m) => m.source.id === id);
  if (!model) return;
  model.object.visible = visible;
  if (!visible && selected?.group.model === id) clear();
  for (const o of mark?.overlays ?? [])
    if (o.model === id) o.overlay.visible = visible;
}
function renderModels() {
  el("set-title").textContent =
    currentSet?.title ?? (loadedModels.length === 1 ? "Модель" : "Модели");
  el("model-list").replaceChildren(
    ...loadedModels.map((m) => {
      const li = node("li", "model-row");
      const label = node("label", "model-toggle");
      const box = node("input");
      box.type = "checkbox";
      box.checked = m.object.visible;
      box.onchange = () => setModelVisible(m.source.id, box.checked);
      const name = node("span", "model-name", m.source.name);
      label.append(box, name);
      const meta = node("div", "model-meta");
      if (m.source.discipline)
        meta.append(node("span", "badge badge-blue", m.source.discipline));
      const info = m.source.info;
      meta.append(
        node(
          "span",
          undefined,
          [
            `${fmt(m.elements, 0)} элементов`,
            info?.triangles
              ? `${fmt(info.triangles / 1e6, 1)} млн треуг.`
              : null,
            info?.glbBytes
              ? `GLB ${fmt(info.glbBytes / 1048576, 1)} МиБ`
              : null,
          ]
            .filter(Boolean)
            .join(" · "),
        ),
      );
      const products = sbzh.rows
        .filter((r) => r.model === m.source.id)
        .reduce((n, r) => n + r.count, 0);
      if (products)
        meta.append(
          node("span", "badge badge-amber", `СБЖ ${fmt(products, 0)}`),
        );
      li.append(label, meta);
      return li;
    }),
  );
  const box = el("alignment");
  const a = currentSet?.alignment;
  box.hidden = !a || loadedModels.length < 2;
  if (!a) return;
  const ok = a.status === "OK";
  const head = node("div", "alignment-head");
  head.append(
    node(
      "span",
      `badge ${ok ? "badge-success" : "badge-amber"}`,
      ok ? "Совмещение: OK" : "Совмещение: проверить",
    ),
  );
  const pairs = a.pairs.map((p) =>
    node(
      "p",
      "panel-text",
      `${p.models.map(modelName).join(" ↔ ")}: перекрытие в плане ${fmt(p.planOverlapRatio * 100, 0)} %, ` +
        (p.maxStoreyElevationDeltaMeters === null
          ? "общих этажей нет"
          : `расхождение отметок этажей ${fmt(p.maxStoreyElevationDeltaMeters * 1000, 1)} мм`),
    ),
  );
  box.replaceChildren(head, node("p", "panel-text", a.method), ...pairs);
}

// ─── Tabs ─────────────────────────────────────────────────────
const tabIds = ["element", "sbzh", "models", "section", "bench"] as const;
type Tab = (typeof tabIds)[number];
const panelId = (t: Tab) => (t === "element" ? "inspector" : `tab-${t}`);
function showTab(tab: Tab) {
  for (const t of tabIds) {
    const button = el(`tab-btn-${t}`);
    button.setAttribute("aria-selected", String(t === tab));
    button.tabIndex = t === tab ? 0 : -1;
    el(panelId(t)).hidden = t !== tab;
  }
}
for (const [i, t] of tabIds.entries()) {
  const button = el(`tab-btn-${t}`);
  button.onclick = () => showTab(t);
  button.onkeydown = (e) => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    const next = tabIds[(i + step + tabIds.length) % tabIds.length];
    showTab(next);
    el(`tab-btn-${next}`).focus();
  };
}
showTab("element");
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
  const targets: THREE.Object3D[] = meshes.filter((m) => isShown(m));
  if (mark?.isolated)
    for (const o of mark.overlays)
      if (o.overlay.visible) targets.push(o.overlay);
  const hits = raycaster.intersectObjects(targets, false);
  lastRaycastMs = performance.now() - before;
  const resolve = (h: THREE.Intersection) => {
    if (h.instanceId === undefined) return null;
    const markHit = mark?.overlays.find((o) => o.overlay === h.object);
    if (markHit) {
      const guid = markHit.overlay.userData.guids[h.instanceId] as string;
      return guidIndex.get(guid) ?? null;
    }
    const group = meshGroups.get(h.object as THREE.InstancedMesh);
    return group ? { group, index: h.instanceId } : null;
  };
  const hit = hits
    .filter((h) => !clippedAway(h.point))
    .map(resolve)
    .find((r) => r !== null && !hidden.has(guidAt(r.group.mapping, r.index)));
  return measure(
    "selection",
    () => {
      if (hit) {
        select(hit.group, hit.index);
        if (focus) {
          focusSelected();
          showTab("element");
        }
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
  clearMark();
  clear();
  if (root) {
    scene.remove(root);
    disposeObject(root);
  }
  root = null;
  groups = [];
  meshes = [];
  meshGroups.clear();
  guidIndex.clear();
  loadedModels = [];
  hidden.clear();
  hiddenStack.length = 0;
  isolated = false;
  focusAnimation = null;
  sbzh = combine([]);
  sbzhByKey.clear();
  setSectionEnabled(false);
  syncUi();
}
async function fetchModel(url: string, signal: AbortSignal, label = "") {
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
      `${label}Загрузка GLB: ${(received / 1048576).toFixed(1)} МиБ${total ? " / " + (total / 1048576).toFixed(1) : ""}`,
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
  return all.buffer;
}
async function fetchJson<T>(
  source: string | File,
  signal: AbortSignal,
): Promise<T | null> {
  if (typeof source !== "string") return JSON.parse(await source.text()) as T;
  const result = await fetch(source, {
    signal,
    cache: params.has("cold") ? "no-store" : "default",
  });
  return result.ok ? ((await result.json()) as T) : null;
}
/** Registers every InstancedMesh of one model; returns its element count. */
function registerGroups(object: THREE.Object3D, model: string) {
  const logical = new Map<THREE.Object3D, LogicalGroup>();
  object.traverse((child) => {
    if (!(child instanceof THREE.InstancedMesh)) return;
    const found = mappingFor(child);
    if (!found)
      throw new Error(`FAIL: у меша нет IFC-сопоставления ${child.name}`);
    let group = logical.get(found.object);
    if (!group) {
      group = {
        model,
        object: found.object,
        mapping: found.mapping,
        meshes: [],
        originals: new Map(),
      };
      logical.set(found.object, group);
    }
    if (child.count !== group.mapping.instanceGuids.length)
      throw new Error("FAIL: число экземпляров не совпадает с числом GUID");
    group.meshes.push(child);
    group.originals.set(child, new Float32Array(child.instanceMatrix.array));
    meshes.push(child);
    meshGroups.set(child, group);
    child.computeBoundingSphere();
    child.computeBoundingBox();
  });
  let count = 0;
  for (const group of logical.values()) {
    groups.push(group);
    group.mapping.instanceGuids.forEach((guid, index) => {
      if (guidIndex.has(guid))
        throw new Error("FAIL: повторяющиеся GUID в сопоставлении");
      guidIndex.set(guid, { group, index });
    });
    count += group.mapping.instanceGuids.length;
  }
  return count;
}
async function load(
  sources: ModelSource[],
  title: string,
  reportUrl: string,
  set: ModelSet | null = null,
) {
  const token = ++generation;
  networkController?.abort();
  networkController = new AbortController();
  const signal = networkController.signal;
  loading = true;
  unload();
  metadata = { schemaVersion: 1, elements: {} };
  currentSet = set;
  modelUrl = reportUrl;
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
    root = new THREE.Group();
    root.name = title;
    scene.add(root);
    const perModel: Record<string, unknown>[] = [];
    let downloadMs = 0,
      downloadBytes = 0,
      parseMs = 0;
    for (const [i, source] of sources.entries()) {
      const label =
        sources.length > 1
          ? `${source.name} (${i + 1}/${sources.length}) · `
          : "";
      const t0 = performance.now();
      const bytes =
        typeof source.glb === "string"
          ? await fetchModel(source.glb, signal, label)
          : await source.glb.arrayBuffer();
      const fetched = performance.now() - t0;
      if (token !== generation) return;
      setStatus(`${label}Разбор GLB и распаковка Draco…`, "loading");
      const start = performance.now();
      const gltf = await loader.parseAsync(bytes, "");
      const parsed = performance.now() - start;
      if (token !== generation) {
        disposeObject(gltf.scene);
        return;
      }
      gltf.scene.name = source.id;
      root.add(gltf.scene);
      gltf.scene.updateMatrixWorld(true);
      const elements = registerGroups(gltf.scene, source.id);
      loadedModels.push({ source, object: gltf.scene, elements });
      downloadMs += fetched;
      downloadBytes += bytes.byteLength;
      parseMs += parsed;
      perModel.push({
        id: source.id,
        downloadMs: fetched,
        downloadBytes: bytes.byteLength,
        glbParseIncludingDracoMs: parsed,
        elements,
      });
    }
    timing.downloadMs = downloadMs;
    timing.downloadBytes = downloadBytes;
    timing.glbParseIncludingDracoMs = parseMs;
    timing.models = perModel;
    timing.dracoRequests = stats(decodeTimes);
    timing.dracoTimingDefinition =
      "Per primitive request-to-callback; overlapping worker tasks, do not sum as wall time";
    if (!guidIndex.size)
      throw new Error("FAIL: нет доступных для выбора элементов");
    modelBounds.setFromObject(root);
    fit();
    timing.mappingCount = guidIndex.size;
    timing.geometryGroups = groups.length;
    const upload = performance.now();
    renderer.render(scene, camera);
    timing.firstRenderCpuSubmitMs = performance.now() - upload;
    timing.gpuUploadMs = null;
    timing.gpuUploadNote =
      "Not separately measurable without GPU timing instrumentation";
    renderSummary(guidIndex.size, groups.length, loadedModels.length);
    renderModels();
    renderSectionPanel();
    setStatus("Загрузка свойств элементов…", "loading");
    const start = performance.now();
    const parts: SbzhData[] = [];
    for (const source of sources) {
      // Without an explicit sidecar a URL model looks for metadata.json next to it.
      const sidecar =
        source.metadata !== undefined
          ? source.metadata
          : typeof source.glb === "string"
            ? new URL(source.glb, location.href).href.replace(
                /[^/]+$/,
                "metadata.json",
              )
            : null;
      if (sidecar) {
        const md = await fetchJson<Metadata>(sidecar, signal);
        if (md) Object.assign(metadata.elements, md.elements);
      }
      if (source.sbzh) {
        const data = await fetchJson<SbzhData>(source.sbzh, signal);
        if (data) parts.push({ ...data, model: data.model ?? source.id });
      }
      if (token !== generation) return;
    }
    timing.metadataFetchAndParseMs = performance.now() - start;
    sbzh = combine(parts);
    for (const row of sbzh.rows) sbzhByKey.set(rowKey(row), row);
    renderSbzh();
    if (token !== generation) return;
    setStatus(
      sources.length === 1 && !set
        ? `Готово · ${modelUrl.split("/").at(-1)} · каждый экземпляр имеет GlobalId`
        : `Готово · ${title} · ${loadedModels.length} ${plural(loadedModels.length, "модель", "модели", "моделей")} · каждый экземпляр имеет GlobalId`,
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
  clearMark();
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
  clearMark();
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
  if (model)
    await load(
      [{ id: model.name, name: model.name, glb: model, metadata: md ?? null }],
      model.name,
      model.name,
    );
  else if (md) {
    metadata = JSON.parse(await md.text());
    if (selected) select(selected.group, selected.index);
  }
}
const single = (url: string): ModelSource[] => {
  const name = decodeURIComponent(url.split("/").at(-1) ?? url);
  return [{ id: name, name, glb: url }];
};
async function loadSet(url: string) {
  try {
    const response = await fetch(url, {
      cache: params.has("cold") ? "no-store" : "default",
    });
    if (!response.ok)
      throw new Error(`комплект: ошибка HTTP ${response.status}`);
    const set = (await response.json()) as ModelSet;
    const base = new URL(url, location.href);
    const resolve = (path?: string | null) =>
      path ? new URL(path, base).href : null;
    await load(
      set.models.map((m) => ({
        id: m.id,
        name: m.name,
        discipline: m.discipline,
        glb: resolve(m.glb)!,
        metadata: resolve(m.metadata),
        sbzh: resolve(m.sbzh),
        info: m,
      })),
      set.title,
      url,
      set,
    );
  } catch (error) {
    setStatus(
      `Ошибка: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
  }
}
interface Catalog {
  default?: string;
  sets: { id: string; title: string; url: string }[];
}
async function start() {
  const catalog = await fetch("/models/catalog.json", { cache: "no-store" })
    .then((r) => (r.ok ? (r.json() as Promise<Catalog>) : null))
    .catch(() => null);
  const setUrl = (s: { url: string }) => `/models/${s.url}`;
  const requested = params.get("set");
  const model = params.get("model");
  const chosen =
    catalog?.sets.find((s) => setUrl(s) === requested) ??
    (!requested && !model
      ? (catalog?.sets.find((s) => s.id === catalog.default) ??
        catalog?.sets[0])
      : undefined);
  if (catalog && catalog.sets.length > 1) {
    const select = el<HTMLSelectElement>("set-select");
    select.replaceChildren(
      ...catalog.sets.map((s) => {
        const option = node("option", undefined, s.title);
        option.value = setUrl(s);
        return option;
      }),
    );
    if (model) {
      const option = node(
        "option",
        undefined,
        `Файл: ${model.split("/").at(-1)}`,
      );
      option.value = "";
      select.prepend(option);
    }
    select.value = chosen ? setUrl(chosen) : (requested ?? "");
    select.onchange = () => {
      if (select.value)
        location.search = `?set=${encodeURIComponent(select.value)}`;
    };
    (select.parentElement as HTMLElement).hidden = false;
  }
  if (model) return load(single(model), model, model);
  if (requested && !chosen) return loadSet(requested);
  if (chosen) return loadSet(setUrl(chosen));
  return load(
    single("/models/km/model.glb"),
    "model.glb",
    "/models/km/model.glb",
  );
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
void start();
// Explicitly enabled developer diagnostics for reproducible pointer-event tests.
if (params.get("test") === "1") {
  const diagnostics = {
    state: () => ({
      selectedGuid: selected?.guid ?? null,
      highlightedElements: selected ? 1 : 0,
      highlightedPrimitives: selectionObjects.length,
      isolated,
      hiddenCount: hidden.size,
      models: loadedModels.map((m) => ({
        id: m.source.id,
        visible: m.object.visible,
        elements: m.elements,
      })),
      mark: mark
        ? {
            mark: mark.row.mark,
            count: mark.row.count,
            isolated: mark.isolated,
          }
        : null,
      sbzhProducts: sbzh.totals.products,
      section: {
        enabled: section.enabled,
        axis: section.axis,
        value: section.value,
        flipped: section.flipped,
      },
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
