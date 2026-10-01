// PDF export: every floor's original page copied untouched into one document, devices (view cones, symbols,
// labels) and the key drawn on top as vectors, and the editable project attached.
import { apply, invert, type Mat, type Pt } from "./coords";
import { cone, type Device, type DeviceType } from "./devices";
import { codeSize, LEGEND_TITLE, legendLayout, type LegendItem, type LegendState } from "./legend";
import { PROJECT_ATTACHMENT } from "./project";

export interface ExportFloor {
  bytes: Uint8Array;  // original source PDF
  page: number;       // 1-based page in it
  pdfToView: Mat;     // pdf.js viewport transform at scale 1 (rotation applied)
  devices: Device[];
  radius: number;     // symbol radius, view pt
  legend: LegendState | null;
}

export async function exportPdf(floors: ExportFloor[], types: DeviceType[], coneOpacity: number, projectJson: string): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb, degrees } = await import("pdf-lib"); // loaded on first export only
  const out = await PDFDocument.create();
  const font = await out.embedFont(StandardFonts.Helvetica), bold = await out.embedFont(StandardFonts.HelveticaBold);
  const colour = (hex: string) => rgb(...([1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number]));
  // Standard fonts only encode WinAnsi (Latin-1-ish): replace anything else rather than fail the export.
  const safe = (t: string) => t.replace(/[^\x20-\x7e\xa0-\xff]/g, "?");
  const sources = new Map<Uint8Array, Awaited<ReturnType<typeof PDFDocument.load>>>();
  const used = new Set(floors.flatMap((f) => f.devices.map((d) => d.typeId)));
  const items: LegendItem[] = types.filter((t) => used.has(t.id)).map((t) => ({ name: safe(t.name), colour: t.colour, code: safe(t.code) }));

  for (const f of floors) {
    let src = sources.get(f.bytes);
    if (!src) sources.set(f.bytes, (src = await PDFDocument.load(f.bytes, { ignoreEncryption: true })));
    const [page] = await out.copyPages(src, [f.page - 1]);
    out.addPage(page);

    // Everything is laid out in view space (upright as seen) and mapped into PDF space, rotating text with the page.
    const toPdf = invert(f.pdfToView), toView = (p: Pt) => apply(f.pdfToView, p);
    const rotate = degrees((Math.atan2(toPdf[1], toPdf[0]) * 180) / Math.PI); // view +x direction in PDF space
    const text = (t: string, [x, y]: Pt, size: number, b = false, centre = false, c = rgb(0.1, 0.1, 0.12)) => {
      const f2 = b ? bold : font, w = centre ? f2.widthOfTextAtSize(t, size) / 2 : 0;
      const [px, py] = apply(toPdf, [x - w, y]);
      page.drawText(t, { x: px, y: py, size, font: f2, rotate, color: c });
    };
    const disc = (v: Pt, r: number, hex: string) => { const [x, y] = apply(toPdf, v); page.drawCircle({ x, y, size: r, color: colour(hex) }); };
    // drawSvgPath flips y (SVG is y-down), so negate y to land exactly on PDF user-space coordinates.
    const poly = (pts: Pt[], hex: string) => page.drawSvgPath("M" + pts.map(([x, y]) => `${x},${-y}`).join("L") + "Z",
      { x: 0, y: 0, color: colour(hex), opacity: coneOpacity, borderColor: colour(hex), borderWidth: 0.5, borderOpacity: 0.9 });

    const typeOf = (d: Device) => types.find((t) => t.id === d.typeId);
    for (const d of f.devices) if (d.aim && d.fov) poly(cone(d.at, d.aim, d.fov), typeOf(d)?.colour ?? "#888888");
    const r = f.radius;
    for (const d of f.devices) {
      const t = typeOf(d), v = toView(d.at), code = safe(t?.code ?? "?"), cs = codeSize(code, r);
      disc(v, r, t?.colour ?? "#888888");
      text(code, [v[0], v[1] + cs * 0.36], cs, true, true, rgb(1, 1, 1));
      if (d.label) text(safe(d.label), [v[0] + r * 1.25, v[1] - r * 0.6], r * 0.9, true);
    }

    if (!f.legend || !items.length) continue;
    const lg = f.legend, at = (x: number, y: number): Pt => [lg.x + x, lg.y + y];
    const L = legendLayout(items, lg.size, (t, size, b) => (b ? bold : font).widthOfTextAtSize(t, size));
    const [bx, by] = apply(toPdf, at(0, L.h));
    page.drawRectangle({ x: bx, y: by, width: L.w, height: L.h, rotate, color: rgb(1, 1, 1), borderColor: rgb(0.2, 0.2, 0.2), borderWidth: 0.6 });
    text(LEGEND_TITLE, at(L.title.x, L.title.y), L.title.size, true);
    for (const row of L.rows) {
      const rad = row.swatch.w / 2, c = at(row.swatch.x + rad, row.swatch.y + rad), cs = codeSize(row.code, rad);
      disc(c, rad, row.colour);
      text(row.code, [c[0], c[1] + cs * 0.36], cs, true, true, rgb(1, 1, 1));
      text(row.name, at(row.text.x, row.text.y), row.text.size);
    }
  }

  await out.attach(new TextEncoder().encode(projectJson), PROJECT_ATTACHMENT, {
    mimeType: "application/json",
    description: "Editable Security Plan Markup project: open this PDF in Security Plan Markup to continue",
  });
  out.setProducer("Security Plan Markup");
  return out.save();
}
