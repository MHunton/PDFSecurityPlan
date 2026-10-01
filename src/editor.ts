import { apply, invert, type Pt } from "./coords";
import { cone, History, newId, nextLabel, rotate, snapshot, type Device, type DeviceType } from "./devices";
import { codeSize, type LegendState } from "./legend";
import type { Tool, Viewer } from "./viewer";

const SVG_NS = "http://www.w3.org/2000/svg";
const GRAB_PX = matchMedia("(pointer: coarse)").matches ? 22 : 14; // minimum grab radius on screen
const HANDLE_PX = matchMedia("(pointer: coarse)").matches ? 10 : 7;

type FloorDevices = { devices: Device[] };
type Drag =
  | { kind: "move"; dev: Device; start: Pt; at: Pt; aim?: Pt; before: Device[] }
  | { kind: "aim" | "fov"; dev: Device; before: Device[] }
  | { kind: "legend"; resize: boolean; start: Pt; orig: LegendState; w: number };

/**
 * Devices on the current floor, drawn in view space (upright, whatever the page rotation) from PDF-space positions.
 * Place: tap the plan to add a device of `brush`. Select: tap to select, drag to move; a selected camera has a
 * handle at the end of its view (drag to aim and set range) and at each side (drag to widen/narrow).
 */
export class Editor implements Tool {
  selectedId: string | null = null;
  /** Device type placed by tapping the plan; null = select only. */
  brush: string | null = null;
  types: DeviceType[] = [];
  /** Symbol radius on this floor (view pt). */
  radius = 10;
  /** Metres to pt on this floor (for new cameras' range). */
  ptPerM = 72 / 0.0254 / 100;
  /** All devices on every floor, for numbering. */
  allDevices: () => Device[] = () => this.floorDevices;
  onChange?: () => void;
  legend: LegendState | null = null;
  onLegend?: () => void;

  private floor: FloorDevices | null = null;
  private readonly history = new History<FloorDevices>();
  readonly layer = document.createElementNS(SVG_NS, "g"); // view space
  private active: Drag | null = null;

  constructor(private readonly viewer: Viewer) {
    viewer.svg.append(this.layer);
  }

  get selected(): Device | undefined { return this.floor?.devices.find((d) => d.id === this.selectedId); }
  get floorDevices(): Device[] { return this.floor?.devices ?? []; }
  get canUndo(): boolean { return !!this.floor && this.history.canUndo(this.floor); }
  get canRedo(): boolean { return !!this.floor && this.history.canRedo(this.floor); }
  typeOf = (d: Device) => this.types.find((t) => t.id === d.typeId);

  setFloor(floor: FloorDevices | null): void {
    this.floor = floor;
    this.selectedId = null;
    this.render();
  }

  select(id: string | null): void {
    this.selectedId = id;
    this.render();
  }

  // ---- Tool ----

  down(p: Pt, target: Element): boolean {
    if (!this.floor) return false;
    const v = this.toView(p);
    const lg = target.closest("[data-legend]");
    if (lg && this.legend) {
      const w = Number(target.closest("[data-w]")?.getAttribute("data-w")) || 1;
      this.active = { kind: "legend", resize: lg.getAttribute("data-legend") === "resize", start: v, orig: { ...this.legend }, w };
      return true;
    }
    const handle = target.getAttribute("data-handle"), sel = this.selected;
    if (handle && sel) {
      this.active = { kind: handle as "aim" | "fov", dev: sel, before: snapshot(this.floor.devices) };
      return true;
    }
    const dev = this.floor.devices.find((d) => d.id === target.closest("[data-dev]")?.getAttribute("data-dev"));
    if (!dev) return false;
    const before = snapshot(this.floor.devices);
    this.selectedId = dev.id;
    this.active = { kind: "move", dev, start: p, at: dev.at, aim: dev.aim, before };
    this.render();
    return true;
  }

  drag(p: Pt): void {
    const d = this.active;
    if (!d) return;
    if (d.kind === "legend") {
      if (!this.legend) return;
      const [x, y] = this.toView(p), dx = x - d.start[0], dy = y - d.start[1];
      if (d.resize) this.legend.size = Math.max(2, d.orig.size * (d.w + dx) / d.w);
      else Object.assign(this.legend, { x: d.orig.x + dx, y: d.orig.y + dy });
      return this.onLegend?.();
    }
    const dev = d.dev;
    if (d.kind === "move") {
      const dx = p[0] - d.start[0], dy = p[1] - d.start[1];
      dev.at = [d.at[0] + dx, d.at[1] + dy];
      if (d.aim) dev.aim = [d.aim[0] + dx, d.aim[1] + dy];
    } else if (d.kind === "aim") {
      if (Math.hypot(p[0] - dev.at[0], p[1] - dev.at[1]) > 1) dev.aim = p;
    } else if (dev.aim) {
      const a = Math.atan2(p[1] - dev.at[1], p[0] - dev.at[0]), m = Math.atan2(dev.aim[1] - dev.at[1], dev.aim[0] - dev.at[0]);
      const off = Math.abs(Math.atan2(Math.sin(a - m), Math.cos(a - m))) * 360 / Math.PI;
      dev.fov = off > 350 ? 360 : Math.max(5, Math.round(off));
    }
    this.render();
  }

  up(_p: Pt, moved: boolean): void {
    const d = this.active;
    this.active = null;
    if (d && d.kind !== "legend" && moved) this.history.push(this.floor!, d.before);
    this.render();
  }

  tap(p: Pt, target: Element): void {
    if (!this.floor || target.closest("[data-legend]")) return;
    const type = this.types.find((t) => t.id === this.brush);
    if (!type) return this.select(null);
    const dev: Device = { id: newId(), typeId: type.id, at: p, label: nextLabel(type, this.allDevices()) };
    if (type.camera) {
      dev.fov = type.camera.fov;
      // Pointing down the screen to start with; the user drags the aim handle round.
      const v = this.toView(p);
      dev.aim = this.toPdf([v[0], v[1] + type.camera.range * this.ptPerM]);
    }
    this.edit(() => this.floor!.devices.push(dev));
    this.select(dev.id);
  }

  // ---- commands ----

  /** Change the selected device as one undoable step. */
  update(patch: Partial<Pick<Device, "label" | "notes" | "typeId" | "fov" | "model" | "ip" | "mac">> & { range?: number }): void {
    const dev = this.selected;
    if (!dev) return;
    this.edit(() => {
      const { range, ...rest } = patch;
      Object.assign(dev, rest);
      for (const k of ["label", "notes", "model", "ip", "mac"] as const) if (!dev[k]) delete dev[k];
      const type = this.typeOf(dev);
      if (type?.camera) {
        dev.fov ??= type.camera.fov;
        const r = range !== undefined ? range * this.ptPerM : null;
        const v = this.toView(dev.at);
        if (!dev.aim) dev.aim = this.toPdf([v[0], v[1] + (r ?? type.camera.range * this.ptPerM)]); // became a camera
        else if (r) {
          const len = Math.hypot(dev.aim[0] - dev.at[0], dev.aim[1] - dev.at[1]) || 1;
          dev.aim = [dev.at[0] + (dev.aim[0] - dev.at[0]) * r / len, dev.at[1] + (dev.aim[1] - dev.at[1]) * r / len];
        }
      } else { delete dev.aim; delete dev.fov; }
    });
    this.render();
  }

  /** Turn the selected camera by `deg` (clockwise as seen). */
  turn(deg: number): void {
    const dev = this.selected;
    if (!dev?.aim) return;
    // pdf->view may mirror (y flips), so turn in view space where clockwise is what the user sees.
    this.edit(() => (dev.aim = this.toPdf(rotate(this.toView(dev.aim!), this.toView(dev.at), (deg * Math.PI) / 180))));
    this.render();
  }

  deleteSelected(): void {
    const id = this.selectedId;
    if (!id || !this.floor) return;
    this.edit(() => (this.floor!.devices = this.floor!.devices.filter((d) => d.id !== id)));
    this.select(null);
  }

  undo(): void { if (this.floor) this.history.undo(this.floor); this.render(); }
  redo(): void { if (this.floor) this.history.redo(this.floor); this.render(); }
  refresh(): void { this.render(); }

  private edit(mutate: () => void): void {
    const before = snapshot(this.floor!.devices);
    mutate();
    this.history.push(this.floor!, before);
  }

  private toView = (p: Pt): Pt => apply(this.viewer.pdfToView, p);
  private toPdf = (v: Pt): Pt => apply(invert(this.viewer.pdfToView), v);

  // ---- rendering ----

  render(): void {
    if (this.selectedId && !this.selected) this.selectedId = null; // e.g. undone away
    const z = this.viewer.view.zoom, r = this.radius, grab = GRAB_PX / z, els: SVGElement[] = [];
    const cones: SVGElement[] = [], marks: SVGElement[] = [];
    for (const d of this.floorDevices) {
      const type = this.typeOf(d), colour = type?.colour ?? "#888", at = this.toView(d.at), sel = d.id === this.selectedId;
      if (d.aim && d.fov) cones.push(svg("polygon", { points: pts(cone(at, this.toView(d.aim), d.fov)), class: "cone", style: `--c:${colour}` }));
      const g = svg("g", { "data-dev": d.id, class: `dev${sel ? " selected" : ""}` });
      g.append(svg("circle", { cx: at[0], cy: at[1], r: Math.max(r, grab), class: "dev-hit" }));
      g.append(svg("circle", { cx: at[0], cy: at[1], r, fill: colour, class: "dev-sym" }));
      const code = type?.code ?? "?", cs = codeSize(code, r);
      g.append(svg("text", { x: at[0], y: at[1] + cs * 0.36, "font-size": cs, class: "dev-code" }, code));
      if (d.label) g.append(svg("text", { x: at[0] + r * 1.25, y: at[1] - r * 0.6, "font-size": r * 0.9, class: "dev-label" }, d.label));
      const tip = svg("title");
      tip.textContent = [d.label, type?.name].filter(Boolean).join(" · ") + (d.notes ? `\n${d.notes}` : "");
      g.append(tip);
      marks.push(g);
    }
    els.push(...cones, ...marks);
    const sel = this.selected;
    if (sel?.aim && sel.fov) {
      const at = this.toView(sel.at), aim = this.toView(sel.aim), h = HANDLE_PX / z;
      const handle = (p: Pt, kind: string) => {
        els.push(svg("circle", { cx: p[0], cy: p[1], r: h, class: `handle ${kind}` }));
        els.push(svg("circle", { cx: p[0], cy: p[1], r: Math.max(h, grab), class: "handle-hit", "data-handle": kind }));
      };
      els.push(svg("line", { x1: at[0], y1: at[1], x2: aim[0], y2: aim[1], class: "aim-line" }));
      if (sel.fov < 360) for (const s of [-1, 1]) handle(rotate(aim, at, (s * sel.fov * Math.PI) / 360), "fov");
      handle(aim, "aim");
    }
    this.layer.replaceChildren(...els);
    this.onChange?.();
  }
}

const pts = (p: Pt[]) => p.map(([x, y]) => `${x},${y}`).join(" ");

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, text?: string): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  if (text !== undefined) el.textContent = text;
  return el;
}
