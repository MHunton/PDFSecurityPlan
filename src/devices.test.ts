import { test } from "node:test";
import assert from "node:assert/strict";
import { cone, formatMac, nextLabel, type Device, type DeviceType } from "./devices.ts";
import { deviceCsv } from "./project.ts";

const camType: DeviceType = { id: "c", name: "Dome", code: "D", colour: "#000000", camera: { fov: 90, range: 10 } };
const reader: DeviceType = { id: "r", name: "Card reader", code: "CR", colour: "#000000" };

test("cone: apex, arc centred on the aim, radius = range; 360° is a closed circle", () => {
  const p = cone([0, 0], [10, 0], 90, 2);
  assert.deepEqual(p[0], [0, 0]);
  assert.equal(p.length, 4);
  for (const q of p.slice(1)) assert.ok(Math.abs(Math.hypot(q[0], q[1]) - 10) < 1e-9);
  assert.ok(Math.abs(p[2][0] - 10) < 1e-9 && Math.abs(p[2][1]) < 1e-9, "middle of the arc on the aim");
  assert.ok(Math.abs(Math.atan2(p[3][1], p[3][0]) - Math.PI / 4) < 1e-9, "edge at +45°");
  const circle = cone([0, 0], [5, 0], 360, 8);
  assert.equal(circle.length, 8, "no apex, no repeated point");
});

test("nextLabel: cameras share CAM numbering, others use their code; gaps aren't reused", () => {
  const d = (label: string): Device => ({ id: label, typeId: "x", at: [0, 0], label });
  assert.equal(nextLabel(camType, []), "CAM01");
  assert.equal(nextLabel(camType, [d("CAM01"), d("CAM07"), d("CR03")]), "CAM08");
  assert.equal(nextLabel(reader, [d("CAM01"), d("cr-2")]), "CR03");
});

test("deviceCsv: range in metres from the drawing scale, sorted by label", () => {
  const ptPerM = 72 / 0.0254 / 50;
  const devices: Device[] = [
    { id: "2", typeId: "r", at: [0, 0], label: "CR10" },
    { id: "1", typeId: "c", at: [0, 0], aim: [3 * ptPerM, 4 * ptPerM], fov: 60, label: "CAM02", notes: 'over "main" door', ip: "10.0.0.5" },
  ];
  const rows = deviceCsv([{ name: "Ground floor", devices, scale: 50 }], [camType, reader]).replace(/^﻿/, "").trim().split("\r\n");
  assert.equal(rows[1], 'Ground floor,CAM02,Dome,D,,10.0.0.5,,60,5.0,"over ""main"" door"');
  assert.equal(rows[2], "Ground floor,CR10,Card reader,CR,,,,,,");
});

test("formatMac: any common notation to colon form; other text kept", () => {
  assert.equal(formatMac("aabb.ccdd.eeff"), "AA:BB:CC:DD:EE:FF");
  assert.equal(formatMac("AA-BB-CC-DD-EE-FF"), "AA:BB:CC:DD:EE:FF");
  assert.equal(formatMac("tbc"), "tbc");
});
