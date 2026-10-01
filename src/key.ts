import { formatMac, newId, type Device, type DeviceType } from "./devices";
import type { Editor } from "./editor";

const PALETTE = ["#2563eb", "#f59e0b", "#7c3aed", "#db2777", "#65a30d", "#ea580c", "#4f46e5", "#0f766e", "#a16207", "#64748b"];

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/**
 * Key side panel: device types (place radio, colour, code, name, count) in Cameras and Access control lists, and
 * the selected device's fields. `types` is the project's list, edited in place. Inputs are only rebuilt when the
 * list itself changes, so typing in them never loses focus.
 */
export class KeyPanel {
  constructor(private readonly types: DeviceType[], private readonly editor: Editor, private readonly allDevices: () => Device[], private readonly ptPerM: () => number) {
    editor.types = types;
    $("addCamera").addEventListener("click", () => this.add(true));
    $("addAccess").addEventListener("click", () => this.add(false));
    $("brushNone").addEventListener("change", () => this.setBrush(null));
    const num = (id: string) => Number($<HTMLInputElement>(id).value);
    $("devLabel").addEventListener("change", (e) => editor.update({ label: (e.target as HTMLInputElement).value.trim() }));
    $("devType").addEventListener("change", (e) => editor.update({ typeId: (e.target as HTMLSelectElement).value }));
    $("devNotes").addEventListener("change", (e) => editor.update({ notes: (e.target as HTMLTextAreaElement).value.trim() }));
    $("devModel").addEventListener("change", (e) => editor.update({ model: (e.target as HTMLInputElement).value.trim() }));
    $("devIp").addEventListener("change", (e) => editor.update({ ip: (e.target as HTMLInputElement).value.trim() }));
    $("devMac").addEventListener("change", (e) => editor.update({ mac: formatMac((e.target as HTMLInputElement).value) }));
    $("devFov").addEventListener("change", () => num("devFov") > 0 && editor.update({ fov: Math.min(360, num("devFov")) }));
    $("devRange").addEventListener("change", () => num("devRange") > 0 && editor.update({ range: num("devRange") }));
    $("turnLeft").addEventListener("click", () => editor.turn(-15));
    $("turnRight").addEventListener("click", () => editor.turn(15));
    this.renderList();
  }

  reload(): void {
    this.editor.brush = null;
    this.renderList();
  }

  setBrush(id: string | null): void {
    this.editor.brush = id;
    this.refresh();
    this.editor.onChange?.(); // hint text
  }

  /** Counts, radio state and selected-device fields; cheap, call on every editor change. */
  refresh(): void {
    const counts = new Map<string, number>();
    for (const d of this.allDevices()) counts.set(d.typeId, (counts.get(d.typeId) ?? 0) + 1);
    for (const li of document.querySelectorAll<HTMLElement>(".cats .cat")) {
      li.querySelector(".count")!.textContent = String(counts.get(li.dataset.id!) ?? 0);
      li.querySelector<HTMLInputElement>("[type=radio]")!.checked = this.editor.brush === li.dataset.id;
    }
    $<HTMLInputElement>("brushNone").checked = this.editor.brush === null;

    const sel = this.editor.selected;
    $("devPanel").hidden = !sel;
    if (!sel) return;
    const setIfIdle = (el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, v: string) => { if (document.activeElement !== el) el.value = v; };
    setIfIdle($("devLabel"), sel.label ?? "");
    setIfIdle($("devType"), sel.typeId);
    setIfIdle($("devNotes"), sel.notes ?? "");
    setIfIdle($("devModel"), sel.model ?? "");
    setIfIdle($("devIp"), sel.ip ?? "");
    setIfIdle($("devMac"), sel.mac ?? "");
    $("ipDup").hidden = !sel.ip || !this.allDevices().some((d) => d !== sel && d.ip === sel.ip);
    $("camFields").hidden = !sel.aim;
    if (sel.aim) {
      setIfIdle($("devFov"), String(sel.fov ?? 90));
      setIfIdle($("devRange"), (Math.hypot(sel.aim[0] - sel.at[0], sel.aim[1] - sel.at[1]) / this.ptPerM()).toFixed(1));
    }
    $("devDup").hidden = !sel.label || !this.allDevices().some((d) => d !== sel && d.label === sel.label);
  }

  private add(camera: boolean): void {
    const used = new Set(this.types.map((t) => t.colour));
    const colour = PALETTE.find((c) => !used.has(c)) ?? PALETTE[this.types.length % PALETTE.length];
    const type: DeviceType = camera
      ? { id: newId(), name: "New camera type", code: "C", colour, camera: { fov: 90, range: 10 } }
      : { id: newId(), name: "New device type", code: "X", colour };
    this.types.push(type);
    this.renderList();
    this.setBrush(type.id); // ready to place
    const input = document.querySelector<HTMLInputElement>(`.cat[data-id="${type.id}"] .cat-name`);
    input?.focus();
    input?.select();
  }

  private remove(type: DeviceType): void {
    const n = this.allDevices().filter((d) => d.typeId === type.id).length;
    if (n) return alert(`"${type.name}" is used by ${n} device${n === 1 ? "" : "s"}. Change or delete them first.`);
    this.types.splice(this.types.indexOf(type), 1);
    if (this.editor.brush === type.id) this.editor.brush = null;
    this.renderList();
    this.editor.refresh();
  }

  private renderList(): void {
    for (const [id, camera] of [["cameraTypes", true], ["accessTypes", false]] as const) {
      $(id).replaceChildren(...this.types.filter((t) => !!t.camera === camera).map((type) => {
        const li = document.createElement("li");
        li.className = "cat";
        li.dataset.id = type.id;
        li.innerHTML = `
          <input type="radio" name="brush" aria-label="Place this device">
          <input type="color" aria-label="Colour">
          <input type="text" class="cat-code" aria-label="Symbol code" maxlength="3">
          <input type="text" class="cat-name" aria-label="Name">
          <span class="count" title="Placed, all floors">0</span>
          <button class="del" aria-label="Delete type" title="Delete type">×</button>`;
        const [radio, colour, code, name] = li.querySelectorAll("input");
        colour.value = type.colour;
        code.value = type.code;
        name.value = type.name;
        radio.addEventListener("change", () => this.setBrush(type.id));
        li.addEventListener("click", (e) => { if (e.target === li || (e.target as HTMLElement).classList.contains("count")) this.setBrush(type.id); });
        colour.addEventListener("input", () => { type.colour = colour.value; this.editor.refresh(); });
        code.addEventListener("input", () => { type.code = code.value.trim() || "?"; this.editor.refresh(); });
        name.addEventListener("input", () => { type.name = name.value; this.renderOptions(); this.editor.onChange?.(); });
        name.addEventListener("change", () => { type.name = name.value.trim() || "Unnamed type"; name.value = type.name; this.renderOptions(); });
        li.querySelector(".del")!.addEventListener("click", () => this.remove(type));
        return li;
      }));
    }
    this.renderOptions();
    this.refresh();
  }

  private renderOptions(): void {
    $("devType").replaceChildren(...this.types.map((t) => new Option(t.name, t.id)));
    const sel = this.editor.selected;
    if (sel) $<HTMLSelectElement>("devType").value = sel.typeId;
  }
}
