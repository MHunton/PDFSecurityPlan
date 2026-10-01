import type { Pt } from "./coords";

/**
 * A kind of device in the key. Project-wide, shared by all floors. `camera`: drawn with a view cone; `fov` (degrees)
 * and `range` (metres) are what new cameras of this type start with.
 */
export interface DeviceType { id: string; name: string; code: string; colour: string; camera?: { fov: number; range: number } }

/**
 * A placed device. Points are PDF user-space of the floor's page (see coords.ts). Cameras also have `aim` (end of
 * the centre line of the view: direction and range in one) and `fov` (degrees, 360 = all round).
 * Photos (snapshots) live in the project's `photos`, keyed by device id, outside undo history.
 */
export interface Device {
  id: string; typeId: string; at: Pt; label?: string; notes?: string; aim?: Pt; fov?: number;
  model?: string; ip?: string; mac?: string;
}

export const newId = () => Math.random().toString(36).slice(2, 10);

const cam = (name: string, code: string, colour: string, fov: number, range: number): DeviceType => ({ id: newId(), name, code, colour, camera: { fov, range } });
const acc = (name: string, code: string, colour: string): DeviceType => ({ id: newId(), name, code, colour });

/** Starting key for a new project. Colours stay clear of the red/green/cyan fire plans already use. */
export const defaultTypes = (): DeviceType[] => [
  cam("Fixed dome camera", "D", "#2563eb", 90, 10),
  cam("Bullet camera", "B", "#4f46e5", 60, 15),
  cam("PTZ camera", "PTZ", "#7c3aed", 360, 20),
  cam("360° camera", "360", "#0f766e", 360, 8),
  acc("Card reader", "CR", "#ea580c"),
  acc("Door contact", "DC", "#a16207"),
  acc("Exit button", "EB", "#db2777"),
  acc("Maglock", "ML", "#64748b"),
  acc("Electric strike", "ES", "#475569"),
  acc("Door controller", "DCU", "#1d2330"),
  acc("Green break glass", "BG", "#65a30d"),
];

/** Next free label for a new device of `type`: cameras share CAM01, CAM02…; others use their code (CR01…). */
export function nextLabel(type: DeviceType, all: Device[]): string {
  const prefix = type.camera ? "CAM" : type.code.toUpperCase();
  const re = new RegExp(`^${prefix.replace(/[^A-Z0-9]/g, "\\$&")}\\s*-?(\\d+)$`, "i");
  const n = Math.max(0, ...all.map((d) => Number(d.label?.match(re)?.[1] ?? 0)));
  return `${prefix}${String(n + 1).padStart(2, "0")}`;
}

/**
 * Outline of a camera's view: the apex at `at`, an arc of radius |aim - at| across `fov` degrees centred on `aim`.
 * Works in any space whose axes are orthonormal (PDF or view). 360° gives a circle.
 */
export function cone(at: Pt, aim: Pt, fov: number, steps = 32): Pt[] {
  const r = Math.hypot(aim[0] - at[0], aim[1] - at[1]), mid = Math.atan2(aim[1] - at[1], aim[0] - at[0]);
  const full = fov >= 360, half = (Math.min(fov, 360) * Math.PI) / 360;
  const arc: Pt[] = [];
  for (let k = 0; k <= steps; k++) {
    const t = mid - half + (2 * half * k) / steps;
    arc.push([at[0] + r * Math.cos(t), at[1] + r * Math.sin(t)]);
  }
  return full ? arc.slice(0, -1) : [at, ...arc];
}

/** 12 hex digits in any common notation become AA:BB:CC:DD:EE:FF; anything else is kept as typed. */
export function formatMac(s: string): string {
  const hex = s.replace(/[^0-9a-f]/gi, "");
  return hex.length === 12 && /^[0-9a-f:.\-\s]+$/i.test(s.trim()) ? hex.toUpperCase().match(/../g)!.join(":") : s.trim();
}

/** Rotate `p` about `c` by `rad` (same space). */
export const rotate = (p: Pt, c: Pt, rad: number): Pt => {
  const dx = p[0] - c[0], dy = p[1] - c[1], cs = Math.cos(rad), sn = Math.sin(rad);
  return [c[0] + dx * cs - dy * sn, c[1] + dx * sn + dy * cs];
};

const LIMIT = 200;

/**
 * Per-floor undo/redo by snapshot: before each edit, push a copy of the floor's whole device list.
 * ponytail: snapshots copy every device on the floor (fine for hundreds); switch to diffs if floors get huge.
 */
export class History<F extends { devices: Device[] }> {
  private stacks = new WeakMap<F, { undo: Device[][]; redo: Device[][] }>();

  private get(floor: F) {
    let s = this.stacks.get(floor);
    if (!s) this.stacks.set(floor, (s = { undo: [], redo: [] }));
    return s;
  }

  push(floor: F, before: Device[]): void {
    const s = this.get(floor);
    s.undo.push(before);
    if (s.undo.length > LIMIT) s.undo.shift();
    s.redo = [];
  }

  undo(floor: F): boolean { return this.step(floor, "undo", "redo"); }
  redo(floor: F): boolean { return this.step(floor, "redo", "undo"); }
  canUndo(floor: F): boolean { return this.get(floor).undo.length > 0; }
  canRedo(floor: F): boolean { return this.get(floor).redo.length > 0; }

  private step(floor: F, from: "undo" | "redo", to: "undo" | "redo"): boolean {
    const s = this.get(floor);
    const devices = s[from].pop();
    if (!devices) return false;
    s[to].push(snapshot(floor.devices));
    floor.devices = devices;
    return true;
  }
}

export const snapshot = (devices: Device[]): Device[] => structuredClone(devices);
