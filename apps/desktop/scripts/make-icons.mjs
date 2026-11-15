// Generates the app icons and the favicon from assets/brand/mark.svg. A dev-time script: run it after changing the
// mark, and commit what it writes.
//
//   node apps/desktop/scripts/make-icons.mjs
//
// Run with Node, it starts Electron (a dev dependency) on this same file. Run inside Electron, it rasterises the SVG
// in a hidden, sandboxed window with a canvas, then writes:
//   apps/desktop/build/icon.png   1024x1024, full bleed
//   apps/desktop/build/icon.ico   PNG entries at 16, 32, 48 and 256 (Windows), full bleed
//   apps/desktop/build/icon.icns  PNG entries ic07-ic14 (macOS), on Apple's icon grid: the mark at 824 of 1024
//   apps/ui/public/favicon.svg    a copy of the mark
// Both icon containers are written by hand from their format headers, so no other tool is needed.
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const DESKTOP = join(dirname(SELF), "..");
const REPO = join(DESKTOP, "..", "..");
const MARK = join(REPO, "assets", "brand", "mark.svg");
const BUILD = join(DESKTOP, "build");
const FAVICON = join(REPO, "apps", "ui", "public", "favicon.svg");

const SIZES = [16, 32, 48, 64, 128, 256, 512, 1024];
const ICO_SIZES = [16, 32, 48, 256];
/** icns PNG entry types and their pixel sizes. */
const ICNS_TYPES = [
  ["ic11", 32],
  ["ic12", 64],
  ["ic07", 128],
  ["ic13", 256],
  ["ic08", 256],
  ["ic14", 512],
  ["ic09", 512],
  ["ic10", 1024],
];
/** Apple's macOS icon grid: the icon body is 824 of 1024 pixels, centred. */
const MAC_BODY = 824 / 1024;

/** An ICO file of PNG entries: a 6-byte header, a 16-byte directory entry per image, then the images. */
export function buildIco(pngs) {
  const header = Buffer.alloc(6 + 16 * pngs.length);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(pngs.length, 4);
  let offset = header.length;
  pngs.forEach(({ size, png }, i) => {
    const e = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, e); // width, 0 means 256
    header.writeUInt8(size >= 256 ? 0 : size, e + 1); // height
    header.writeUInt8(0, e + 2); // palette colours
    header.writeUInt8(0, e + 3); // reserved
    header.writeUInt16LE(1, e + 4); // colour planes
    header.writeUInt16LE(32, e + 6); // bits per pixel
    header.writeUInt32LE(png.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...pngs.map((p) => p.png)]);
}

/** An icns file: "icns" and the total length, then per entry its type, its length (header included) and its PNG. */
export function buildIcns(entries) {
  const parts = entries.map(({ type, png }) => {
    const head = Buffer.alloc(8);
    head.write(type, 0, 4, "latin1");
    head.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([head, png]);
  });
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.write("icns", 0, 4, "latin1");
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

/** Draws the SVG on a canvas at each size (scaled by `body`, centred) in the page and returns base64 PNGs. */
const RENDER = `async (svg, sizes, body) => {
  const img = new Image();
  img.src = "data:image/svg+xml;base64," + btoa(svg);
  await img.decode();
  return sizes.map((size) => {
    const c = document.createElement("canvas");
    c.width = c.height = size;
    const ctx = c.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    const s = size * body;
    ctx.drawImage(img, (size - s) / 2, (size - s) / 2, s, s);
    return c.toDataURL("image/png").split(",")[1];
  });
}`;

async function renderInElectron() {
  const { app, BrowserWindow } = await import("electron");
  app.disableHardwareAcceleration();
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 64, height: 64, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await win.loadURL("about:blank");
  const svg = readFileSync(MARK, "utf8");
  const call = (sizes, body) =>
    win.webContents.executeJavaScript(`(${RENDER})(${JSON.stringify(svg)}, ${JSON.stringify(sizes)}, ${body})`).then((list) => list.map((b) => Buffer.from(b, "base64")));

  const full = await call(SIZES, 1);
  const png = new Map(SIZES.map((s, i) => [s, full[i]]));
  const macSizes = [...new Set(ICNS_TYPES.map(([, s]) => s))];
  const macList = await call(macSizes, MAC_BODY);
  const mac = new Map(macSizes.map((s, i) => [s, macList[i]]));

  mkdirSync(BUILD, { recursive: true });
  writeFileSync(join(BUILD, "icon.png"), png.get(1024));
  writeFileSync(join(BUILD, "icon.ico"), buildIco(ICO_SIZES.map((size) => ({ size, png: png.get(size) }))));
  writeFileSync(join(BUILD, "icon.icns"), buildIcns(ICNS_TYPES.map(([type, size]) => ({ type, png: mac.get(size) }))));
  mkdirSync(dirname(FAVICON), { recursive: true });
  copyFileSync(MARK, FAVICON);
  console.log("Wrote icon.png, icon.ico, icon.icns and favicon.svg");
  app.exit(0);
}

if (process.versions.electron) {
  renderInElectron().catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else if (process.argv[1] && resolve(process.argv[1]) === SELF) {
  // Under Node: start Electron on this file. Electron's package exports the path of its binary.
  const electron = createRequire(join(DESKTOP, "package.json"))("electron");
  const child = spawn(electron, [SELF], { stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 1));
}
