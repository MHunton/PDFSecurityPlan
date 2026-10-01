// Project state (autosave), project file (embedded in exported PDFs) and the device schedule CSV.
import type { LegendState } from "./legend";
import { newId, type Device, type DeviceType } from "./devices.ts"; // .ts: also used by node --test

export const PROJECT_ATTACHMENT = "plan-security-markup-project.json";
const APP = "plan-security-markup";

export interface ProjectFloor {
  name: string; source: number; page: number; devices: Device[];
  scale?: number | null; legend?: LegendState;
}
export interface ProjectFile {
  app: typeof APP; version: 1;
  types: DeviceType[]; symbolScale: number; coneOpacity: number; showLegend: boolean;
  photos: Record<string, string>; // device id -> JPEG data URL
  sources: { fileName: string; data: string }[]; // original PDFs, base64: the file is self-contained
  floors: ProjectFloor[];
}

/** In-memory project with the original PDFs as bytes (autosave stores this). */
export interface ProjectState {
  types: DeviceType[]; symbolScale: number; coneOpacity: number; showLegend: boolean;
  photos: Record<string, string>;
  sources: { id: string; fileName: string; bytes: Uint8Array }[];
  floors: ProjectFloor[];
}

export const toProjectFile = ({ sources, ...s }: ProjectState): ProjectFile =>
  ({ app: APP, version: 1, ...s, sources: sources.map((x) => ({ fileName: x.fileName, data: toBase64(x.bytes) })) });
export const fromProjectFile = ({ app: _, version: __, sources, ...p }: ProjectFile): ProjectState =>
  ({ ...p, sources: sources.map((x) => ({ id: newId(), fileName: x.fileName, bytes: fromBase64(x.data) })) });

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function fromBase64(b64: string): Uint8Array {
  const s = atob(b64), out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** Parse and sanity-check a project file; throws a readable error for anything else. */
export function parseProject(text: string): ProjectFile {
  const p = JSON.parse(text);
  if (p?.app !== APP || !Array.isArray(p.floors) || !Array.isArray(p.sources)) throw new Error("not a Security Plan Markup project");
  if (p.version !== 1) throw new Error(`project version ${p.version} is newer than this app`);
  return p;
}

/** Pt per metre at a drawing scale (unknown: 1:100 assumed). */
export const ptPerM = (scale?: number | null) => 72 / 0.0254 / (scale || 100);

interface CsvFloor { name: string; devices: Device[]; scale?: number | null }

/** Device schedule: one row per device, floors in order, then by label. */
export function deviceCsv(floors: CsvFloor[], types: DeviceType[]): string {
  const cell = (v: string | number) => { const s = String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const rows: (string | number)[][] = [["Floor", "Label", "Device", "Code", "Model", "IP address", "MAC address", "Field of view (°)", "Range (m)", "Notes"]];
  for (const f of floors) {
    const byLabel = [...f.devices].sort((a, b) => (a.label ?? "").localeCompare(b.label ?? "", undefined, { numeric: true }));
    for (const d of byLabel) {
      const t = types.find((x) => x.id === d.typeId);
      const range = d.aim ? (Math.hypot(d.aim[0] - d.at[0], d.aim[1] - d.at[1]) / ptPerM(f.scale)).toFixed(1) : "";
      rows.push([f.name, d.label ?? "", t?.name ?? "", t?.code ?? "", d.model ?? "", d.ip ?? "", d.mac ?? "", d.aim ? d.fov ?? "" : "", range, d.notes ?? ""]);
    }
  }
  return "﻿" + rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n"; // BOM: Excel reads UTF-8 (°)
}
