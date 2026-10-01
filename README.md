# Security Plan Markup

Place CCTV cameras and access control devices on site plan PDFs, in the browser. Sister app of
[Plan Colour-Coder](https://github.com/MHunton/PDFPlansColourer), sharing its viewer, floors, autosave and export.

- **Add PDF**: each page becomes a floor. The drawing scale (e.g. 1:100) is read from the drawing text, or type it in.
- **Key**: camera types (fixed dome, bullet, PTZ, 360°) and access control types (card reader, door contact, exit
  button, maglock, electric strike, door controller, green break glass). Change any name, code or colour, or add your own.
- **Place**: tick a type and tap the plan. Devices are numbered automatically (CAM01…, CR01…).
- **Cameras**: drag the orange end handle to aim the camera and set its range. Drag the side handles to widen or narrow
  the field of view. Q / E turn it 15°. You can also type the field of view and range (in metres) in the panel.
- **Device details**: name/label, model, IP address, MAC address, notes, and a snapshot photo (stored at up to 1600 px JPEG).
- **Export PDF**: the original pages with devices, view cones and a key drawn as vectors. The editable project is
  attached, including the snapshots. Open the exported PDF with **+ Add PDF** to carry on.
- **Device schedule (CSV)**: one row per device with its type, model, IP, MAC, field of view, range and notes.

Work is autosaved in this browser (IndexedDB). Files never leave the device: there is no server.

## Develop

```
npm install
npm run dev
npm test
npm run build
```

Pushing to `main` deploys to GitHub Pages (`.github/workflows/deploy.yml`; set Settings > Pages > Source to "GitHub Actions").

## Code

- `src/devices.ts`: device and type model, default key, labels, view cone geometry, undo history
- `src/editor.ts`: placing, selecting, moving and aiming devices (drawn in view space so symbols stay upright)
- `src/key.ts`: key panel and selected-device fields
- `src/exportPdf.ts`: PDF export (pdf-lib)
- `src/project.ts`: project file, device schedule CSV
- `src/viewer.ts`, `src/pdf.ts`, `src/coords.ts`, `src/floorDialog.ts`, `src/floorName.ts`, `src/autosave.ts`: shared with Plan Colour-Coder
