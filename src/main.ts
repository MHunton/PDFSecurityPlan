import "./style.css";
import { clearSession, loadSession, peekSession, saveSession } from "./autosave";
import type { Mat } from "./coords";
import { defaultTypes, newId, type DeviceType } from "./devices";
import { Editor } from "./editor";
import { exportPdf, type ExportFloor } from "./exportPdf";
import { editFloors, type Floor, type Source } from "./floorDialog";
import { drawingScale, floorRank } from "./floorName";
import { KeyPanel } from "./key";
import { defaultLegend, renderLegendSvg } from "./legend";
import { loadPdf } from "./pdf";
import { deviceCsv, fromProjectFile, parseProject, PROJECT_ATTACHMENT, ptPerM, toProjectFile, type ProjectState } from "./project";
import { Viewer } from "./viewer";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const viewer = new Viewer($("viewer"));
const editor = new Editor(viewer);
viewer.tool = editor;
const legendLayer = document.createElementNS("http://www.w3.org/2000/svg", "g"); // view space, above the devices
viewer.svg.append(legendLayer);
let showLegend = true, symbolScale = 1;
let autosaveOn = false, autosaveOk = true, dirty = false, saveTimer = 0;
let floors: Floor[] = [];
let current: Floor | null = null;
const types: DeviceType[] = defaultTypes();
let photos: Record<string, string> = {}; // device id -> snapshot (JPEG data URL), kept out of undo history
const allDevices = () => floors.flatMap((f) => f.devices);
editor.allDevices = allDevices;
const key = new KeyPanel(types, editor, allDevices, () => ptPerM(current?.scale));

const say = (msg: string) => ($("msg").textContent = msg);
const isPdf = (f: File) => /\.pdf$/i.test(f.name) || f.type === "application/pdf";
async function addFiles(files: File[]) {
  const added: Floor[] = [];
  const problems = files.filter((f) => !isPdf(f)).map((f) => `${f.name} is not a PDF.`);
  for (const file of files.filter(isPdf)) {
    say(`Opening ${file.name}…`);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const task = loadPdf(bytes.slice()); // pdf.js detaches the buffer it is given; keep the original for export
      const src: Source = { id: newId(), fileName: file.name, bytes, task, doc: await task.promise };
      const project = await embeddedProject(src);
      if (project && confirm(`${file.name} was exported by Security Plan Markup. Open its editable project?\n\nCancel adds it as a plain drawing instead.`)) {
        task.destroy();
        return openProject(file.name, project);
      }
      for (let p = 1; p <= src.doc.numPages; p++) added.push({ name: "", src, page: p, devices: [] });
    } catch (e) {
      problems.push(`Could not open ${file.name}: ${(e as Error).message}`);
    }
  }
  say("");
  if (problems.length) alert(problems.join("\n")); // status line would be overwritten by the next render
  if (!added.length) return;
  startAutosave();
  await manageFloors(added);
}

async function manageFloors(added: Floor[] = []) {
  const all = [...floors, ...added];
  const result = await editFloors(all, new Set(added));
  if (result) floors = result.sort((a, b) => floorRank(a.name) - floorRank(b.name));
  // Free pdf.js memory for files no floor uses any more (cancelled adds, removed floors).
  const used = new Set(floors.map((f) => f.src));
  for (const src of new Set(all.map((f) => f.src))) if (!used.has(src)) src.task.destroy();

  showChrome();
  markDirty();
  if (!floors.length) {
    current = null;
    renderTabs();
    viewer.clear();
    editor.setFloor(null);
    return say("");
  }
  for (const f of added) {
    if (!floors.includes(f) || f.scale !== undefined) continue;
    const text = (await (await f.src.doc.getPage(f.page)).getTextContent()).items.map((t) => ("str" in t ? t.str : "")).join(" ");
    f.scale = drawingScale(text);
  }
  // Show the first newly added floor; otherwise stay put (no re-render, keeps zoom) unless the current one was removed.
  const next = added.find((f) => floors.includes(f)) ?? (current && floors.includes(current) ? current : floors[0]);
  if (next !== current) return showFloor(next);
  renderTabs();
  say(floorStatus(next));
}

const floorStatus = (f: Floor) =>
  `${f.name} · ${f.src.fileName}, page ${f.page} · ${f.scale ? `1:${f.scale}` : "scale unknown (1:100 assumed)"}`;

async function showFloor(floor: Floor) {
  current = floor;
  renderTabs();
  editor.setFloor(null);
  say("Rendering…");
  const page = await floor.src.doc.getPage(floor.page);
  if (current !== floor) return;
  await viewer.setPage(page);
  if (current !== floor) return;
  floor.legend ??= defaultLegend(viewer.width, viewer.height);
  applyFloorSettings();
  editor.setFloor(floor);
  say(floorStatus(floor));
}

/** Symbol size and metres for the current floor's page. */
function applyFloorSettings() {
  editor.radius = symbolRadius(viewer.width);
  editor.ptPerM = ptPerM(current?.scale);
  if (document.activeElement !== $("scale")) $<HTMLInputElement>("scale").value = current?.scale ? String(current.scale) : "";
}
const symbolRadius = (pageW: number) => (pageW / 250) * symbolScale; // A0 ≈ 5 mm radius at 1×

function renderTabs() {
  $("tabList").replaceChildren(...floors.map((f) => {
    const tab = document.createElement("button");
    tab.className = "tab";
    tab.role = "tab";
    tab.textContent = f.name;
    tab.ariaSelected = String(f === current);
    tab.addEventListener("click", () => f !== current && showFloor(f));
    return tab;
  }));
  $("tabList").querySelector<HTMLElement>("[aria-selected=true]")?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

viewer.onViewChange = () => {
  $("zoomPct").textContent = `${Math.round((viewer.view.zoom * 72) / 96 * 100)}%`; // 100% = paper size
  editor.refresh(); // grab areas and handles stay a constant size on screen
};

editor.onChange = () => {
  $<HTMLButtonElement>("undo").disabled = !editor.canUndo;
  $<HTMLButtonElement>("redo").disabled = !editor.canRedo;
  $<HTMLButtonElement>("deleteDev").disabled = !editor.selected;
  const sel = editor.selected, type = sel && editor.typeOf(sel), placing = types.find((t) => t.id === editor.brush);
  $("hint").textContent = !current ? "" : placing
    ? `Placing ${placing.name}: tap the plan to add one. Esc stops.`
    : sel ? `${sel.label ?? ""} ${type?.name ?? ""} · drag to move${sel.aim ? ", drag the end of the view to aim, its sides to widen" : ""}`
    : "Pick a device in the key, then tap the plan to place it. Tap a device to select it.";
  $("hint").hidden = !current;
  $("viewer").classList.toggle("drawing", !!placing);
  key.refresh();
  renderPhoto();
  renderLegend();
  markDirty();
};
$("undo").addEventListener("click", () => editor.undo());
$("redo").addEventListener("click", () => editor.redo());
$("deleteDev").addEventListener("click", () => editor.deleteSelected());
viewer.onCursor = (p) => ($("cursor").textContent = p ? `x ${p[0].toFixed(1)}  y ${p[1].toFixed(1)} pt` : "");

for (const input of document.querySelectorAll<HTMLInputElement>("input[type=file]:not(#photoFile)")) {
  input.addEventListener("change", () => {
    if (input.files?.length) addFiles([...input.files]);
    input.value = ""; // allow adding the same file again
  });
}
$("editFloors").addEventListener("click", () => manageFloors());
$("zoomIn").addEventListener("click", () => viewer.zoomCentre(1.5));
$("zoomOut").addEventListener("click", () => viewer.zoomCentre(1 / 1.5));
$("zoomFit").addEventListener("click", () => viewer.fit());
$("scale").addEventListener("change", (e) => {
  if (!current) return;
  const n = Number((e.target as HTMLInputElement).value);
  current.scale = n >= 1 ? n : null;
  applyFloorSettings();
  say(floorStatus(current));
  editor.refresh();
});
const sizeInput = $<HTMLInputElement>("symbolSize"), opacityInput = $<HTMLInputElement>("opacity");
function setSymbolScale(v: number) {
  symbolScale = v;
  sizeInput.value = String(v);
  $("symbolSizeVal").textContent = `${v}×`;
  if (current) applyFloorSettings();
  editor.refresh();
}
function setOpacity(v: number) {
  opacityInput.value = String(Math.round(v * 100));
  $("viewer").style.setProperty("--cone-opacity", String(v));
  $("opacityVal").textContent = `${Math.round(v * 100)}%`;
  markDirty();
}
const coneOpacity = () => Number(opacityInput.value) / 100;
sizeInput.addEventListener("input", () => setSymbolScale(Number(sizeInput.value)));
opacityInput.addEventListener("input", () => setOpacity(coneOpacity()));
setOpacity(coneOpacity());

addEventListener("dragover", (e) => e.preventDefault());
addEventListener("drop", (e) => {
  e.preventDefault();
  const files = [...(e.dataTransfer?.files ?? [])];
  if (files.length && !$<HTMLDialogElement>("floorDialog").open) addFiles(files);
});
addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement ||
    $<HTMLDialogElement>("floorDialog").open || $<HTMLDialogElement>("photoDialog").open || !current) return;
  const ctrl = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
  if (ctrl && k === "z") editor[e.shiftKey ? "redo" : "undo"]();
  else if (ctrl && k === "y") editor.redo();
  else if (ctrl) return;
  else if (e.key === "Escape") editor.brush !== null ? key.setBrush(null) : editor.select(null);
  else if (e.key === "Delete" || e.key === "Backspace") editor.deleteSelected();
  else if (k === "q" || k === "e") editor.turn(k === "q" ? -15 : 15);
  else if (e.key === "+" || e.key === "=") viewer.zoomCentre(1.5);
  else if (e.key === "-") viewer.zoomCentre(1 / 1.5);
  else if (e.key === "0") viewer.fit();
  else if ((e.key === "PageUp" || e.key === "PageDown") && current) { // PageUp = floor above
    const next = floors[floors.indexOf(current) + (e.key === "PageUp" ? 1 : -1)];
    if (next) showFloor(next);
  } else return;
  e.preventDefault(); // e.g. Backspace navigating back, Ctrl+Y opening history
});

$("togglePanel").addEventListener("click", () => document.body.classList.toggle("panel-hidden"));
if (matchMedia("(max-width: 760px)").matches) document.body.classList.add("panel-hidden"); // phones: plan first

// Autosave covers closing the tab; warn only if it can't (unavailable, or changes not written yet).
addEventListener("beforeunload", (e) => { if (allDevices().length && (dirty || !autosaveOk)) e.preventDefault(); });

// ---- snapshots ----
let shownPhoto: string | undefined;
function renderPhoto() {
  const sel = editor.selected, url = sel && photos[sel.id];
  if (url === shownPhoto) return;
  shownPhoto = url;
  $("photoView").hidden = $("photoRemove").hidden = !url;
  $("photoAddLabel").firstChild!.textContent = url ? "Replace snapshot" : "Add snapshot";
  if (url) $<HTMLImageElement>("photoImg").src = url;
}
/** Shrink to 1600 px on the long side as JPEG: keeps autosave and the exported PDF a sensible size. */
async function toJpeg(file: File): Promise<string> {
  const img = await createImageBitmap(file), s = Math.min(1, 1600 / Math.max(img.width, img.height));
  const c = Object.assign(document.createElement("canvas"), { width: Math.round(img.width * s), height: Math.round(img.height * s) });
  c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
  img.close();
  return c.toDataURL("image/jpeg", 0.82);
}
$<HTMLInputElement>("photoFile").addEventListener("change", async (e) => {
  const input = e.target as HTMLInputElement, file = input.files?.[0], sel = editor.selected;
  input.value = "";
  if (!file || !sel) return;
  try { photos[sel.id] = await toJpeg(file); } catch { return alert(`${file.name} isn't an image this browser can read.`); }
  renderPhoto();
  markDirty();
});
$("photoRemove").addEventListener("click", () => {
  const sel = editor.selected;
  if (!sel || !confirm("Remove this snapshot?")) return;
  delete photos[sel.id];
  renderPhoto();
  markDirty();
});
$("photoView").addEventListener("click", () => {
  const sel = editor.selected;
  if (!sel || !photos[sel.id]) return;
  $<HTMLImageElement>("photoFull").src = photos[sel.id];
  $("photoCaption").textContent = [sel.label, sel.model, sel.ip].filter(Boolean).join(" · ");
  $<HTMLDialogElement>("photoDialog").showModal();
});

// ---- legend, export, open ----
function showChrome() {
  $("empty").hidden = floors.length > 0;
  $("tabs").hidden = floors.length === 0;
  $("editTools").hidden = floors.length === 0;
  $("exportPanel").hidden = floors.length === 0;
  $("floorPanel").hidden = floors.length === 0;
}

function renderLegend() {
  const f = current, used = new Set(allDevices().map((d) => d.typeId));
  const items = types.filter((t) => used.has(t.id));
  editor.legend = f && showLegend && items.length && f.legend && editor.floorDevices === f.devices ? f.legend : null;
  if (!editor.legend) return legendLayer.replaceChildren();
  renderLegendSvg(legendLayer, editor.legend, items, 12 / viewer.view.zoom);
}
editor.onLegend = () => { renderLegend(); markDirty(); };
$<HTMLInputElement>("showLegend").addEventListener("change", (e) => { showLegend = (e.target as HTMLInputElement).checked; renderLegend(); markDirty(); });

const baseName = () => (floors[0]?.src.fileName ?? "plan").replace(/\.pdf$/i, "").replace(/[\\/:*?"<>|]+/g, "_");
function download(data: BlobPart, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Photos of devices that still exist (a deleted device's photo stays in memory, so undo brings it back). */
const livePhotos = () => { const ids = new Set(allDevices().map((d) => d.id)); return Object.fromEntries(Object.entries(photos).filter(([id]) => ids.has(id))); };

function projectState(): ProjectState {
  const sources = [...new Set(floors.map((f) => f.src))];
  return {
    types, symbolScale, coneOpacity: coneOpacity(), showLegend, photos: livePhotos(),
    sources: sources.map((s) => ({ id: s.id, fileName: s.fileName, bytes: s.bytes })),
    floors: floors.map((f) => ({ name: f.name, source: sources.indexOf(f.src), page: f.page, devices: f.devices, scale: f.scale, legend: f.legend })),
  };
}

async function busy(label: string, job: () => Promise<void>) {
  const buttons = ["exportPdf", "exportCsv"].map((id) => $<HTMLButtonElement>(id));
  buttons.forEach((b) => (b.disabled = true));
  say(`${label}…`);
  try { await job(); } catch (e) { console.error(e); alert(`${label} failed: ${(e as Error).message}`); say(""); }
  finally { buttons.forEach((b) => (b.disabled = false)); }
}

$("exportPdf").addEventListener("click", () => busy("Exporting PDF", async () => {
  const input: ExportFloor[] = await Promise.all(floors.map(async (f) => {
    const vp = (await f.src.doc.getPage(f.page)).getViewport({ scale: 1 });
    return {
      bytes: f.src.bytes, page: f.page, pdfToView: vp.transform as Mat, devices: f.devices, radius: symbolRadius(vp.width),
      legend: showLegend ? (f.legend ??= defaultLegend(vp.width, vp.height)) : null,
    };
  }));
  const pdf = await exportPdf(input, types, coneOpacity(), JSON.stringify(toProjectFile(projectState())));
  download(pdf as Uint8Array<ArrayBuffer>, `${baseName()}-security.pdf`, "application/pdf");
  say(`Exported ${floors.length} floor${floors.length === 1 ? "" : "s"} to ${baseName()}-security.pdf (editable project included).`);
}));
$("exportCsv").addEventListener("click", () => busy("Exporting device schedule", async () => {
  download(deviceCsv(floors, types), `${baseName()}-devices.csv`, "text/csv");
  say(`Saved ${baseName()}-devices.csv.`);
}));

/** Project JSON attached to a PDF this app exported, if any. */
async function embeddedProject(src: Source): Promise<string | null> {
  const att = await src.doc.getAttachments();
  const entries: [string, { filename: string; content?: Uint8Array | null }][] = att instanceof Map ? [...att] : Object.entries(att ?? {});
  const hit = entries.find(([, a]) => a.filename === PROJECT_ATTACHMENT);
  if (!hit) return null;
  const content = hit[1].content ?? await src.doc.getAttachmentContent(hit[0]);
  return content ? new TextDecoder().decode(content) : null;
}

async function openProject(name: string, json: string) {
  if (allDevices().length && !confirm(`Open ${name}? The current project will be closed (export it first if needed).`)) return;
  say(`Opening ${name}…`);
  try {
    await loadProject(fromProjectFile(parseProject(json)));
    startAutosave();
    markDirty();
    say(`Opened ${name}: ${summary()}.`);
  } catch (e) {
    alert(`Could not open ${name}: ${(e as Error).message}`);
    say("");
  }
}

const summary = () => `${floors.length} floor${floors.length === 1 ? "" : "s"}, ${allDevices().length} devices`;

async function loadProject(p: ProjectState, currentIndex = 0) {
  const sources: Source[] = await Promise.all(p.sources.map(async (s) => {
    const task = loadPdf(s.bytes.slice());
    return { ...s, task, doc: await task.promise };
  }));
  for (const src of new Set(floors.map((f) => f.src))) src.task.destroy();
  floors = p.floors.map((f) => ({ name: f.name, src: sources[f.source], page: f.page, devices: f.devices, scale: f.scale, legend: f.legend }));
  types.splice(0, types.length, ...p.types);
  photos = p.photos ?? {};
  key.reload();
  setOpacity(p.coneOpacity);
  setSymbolScale(p.symbolScale);
  showLegend = p.showLegend;
  $<HTMLInputElement>("showLegend").checked = showLegend;
  current = null;
  showChrome();
  await showFloor(floors[currentIndex] ?? floors[0]);
}

// ---- autosave (this browser only) ----
function startAutosave() {
  autosaveOn = true;
  $("resume").hidden = true;
}
function markDirty() {
  if (!autosaveOn) return; // not until the user resumes or starts a project: don't overwrite the saved session
  dirty = true;
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(flush, 1500);
}
async function flush() {
  if (!dirty) return;
  dirty = false;
  try {
    if (floors.length) await saveSession(projectState(), current ? floors.indexOf(current) : 0);
    else await clearSession();
    autosaveOk = true;
    $("saved").textContent = floors.length ? `Autosaved ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "";
  } catch (e) {
    console.error(e);
    if (autosaveOk) say(`Autosave isn't available in this browser (${(e as Error).message}). Export the PDF to keep your work.`);
    autosaveOk = false;
    $("saved").textContent = "Not autosaved";
  }
}
document.addEventListener("visibilitychange", () => { if (document.hidden) flush(); });

peekSession().then((s) => {
  if (!s?.floors.length || autosaveOn) return;
  const n = s.floors.reduce((k, f) => k + f.devices.length, 0);
  const when = new Date(s.savedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  $("resumeText").textContent = `${s.sources.map((x) => x.fileName).join(", ")}: ${s.floors.length} floor${s.floors.length === 1 ? "" : "s"}, ${n} devices, saved ${when}.`;
  $("resume").hidden = false;
});
$("resumeBtn").addEventListener("click", async () => {
  say("Resuming last session…");
  try {
    const saved = await loadSession();
    if (!saved) throw new Error("nothing saved");
    await loadProject(saved.state, saved.current);
    startAutosave();
    say(`Resumed: ${summary()}.`);
  } catch (e) {
    alert(`Could not resume: ${(e as Error).message}`);
    say("");
  }
});
