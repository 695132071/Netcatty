"use strict";
/* global process, __dirname, console, document, requestAnimationFrame */
if (!process.versions.electron) {
  require("node:test")("inline image pixels stay aligned across terminal resizes", {
    skip: "run with Electron to exercise real DOM and canvas rendering",
  }, () => {});
} else {
  const { app, BrowserWindow } = require("electron");
  const fs = require("node:fs");
  const path = require("node:path");
  const esbuild = require("esbuild");
  const temp = require("../electron/bridges/tempDirBridge.cjs");
  const root = path.resolve(__dirname, "..");
  const userData = fs.mkdtempSync(`${temp.getTempFilePath("image-resize")}-`);
  app.setPath("userData", userData);
  app.on("window-all-closed", () => {});
  let win;
  const cleanup = code => {
    win?.destroy();
    fs.rmSync(userData, { recursive: true, force: true });
    app.exit(code);
  };

  async function exercise({ Terminal, ImageAddon }) {
    const check = (actual, expected, label) => {
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
      }
    };
    const host = document.createElement("div");
    document.body.appendChild(host);
    const term = new Terminal({ cols: 40, rows: 18, fontFamily: "monospace", fontSize: 16, cursorBlink: false, allowProposedApi: true });
    term.open(host);
    const addon = new ImageAddon({ sixelSupport: false, iipSupport: false, kittySupport: false });
    term.loadAddon(addon);
    const render = async () => {
      term.refresh(0, term.rows - 1);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    };
    await render();
    const originalCell = { ...addon._renderer.cellSize };
    const source = document.createElement("canvas");
    source.width = Math.round(originalCell.width * 40);
    source.height = Math.round(originalCell.height * 8);
    check(Math.ceil(source.width / originalCell.width), 40, "fixture covers 40 image columns");
    const context = source.getContext("2d");
    const color = (col, row) => [32 + (col % 7) * 32, 32 + row * 24, 192, 255];
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 40; col++) {
        const [r, g, b] = color(col, row);
        context.fillStyle = `rgb(${r},${g},${b})`;
        context.fillRect(Math.floor(col * originalCell.width), Math.floor(row * originalCell.height), Math.ceil(originalCell.width), Math.ceil(originalCell.height));
      }
    }
    // Insert once into the real terminal buffer. All subsequent frames must use
    // the original tile IDs, just like an image already printed by any protocol.
    const id = addon._storage.addImage(source, { scrolling: true, layer: "top", zIndex: 0, cursorPos: "vt340" });
    const spec = addon._storage._images.get(id);
    const samples = [];
    let roundedStrideChanged = false;
    for (const cols of [40, 53, 67, 91, 40, 53, 40]) {
      term.resize(cols, 18);
      await render();
      const cell = addon._renderer.cellSize;
      const badStride = Math.ceil(spec.actual.width / cell.width);
      roundedStrideChanged ||= badStride !== 40;
      const output = host.querySelector(".xterm-image-layer-top").getContext("2d");
      for (const row of [0, 1, 2, 7]) {
        for (const col of [0, 1, 5, 20, 38]) {
          const pixel = [...output.getImageData(Math.floor((col + 0.5) * cell.width), Math.floor((row + 0.5) * cell.height), 1, 1).data];
          check(pixel, color(col, row), `canvas pixel at cols=${cols}, cell=${col},${row}`);
          const tile = addon.extractTileAtBufferCell(col, row);
          const extracted = [...tile.getContext("2d").getImageData(Math.floor(tile.width / 2), Math.floor(tile.height / 2), 1, 1).data];
          check(extracted, color(col, row), `extracted tile at cols=${cols}, cell=${col},${row}`);
        }
      }
      samples.push({ cols, cellWidth: cell.width, canvasWidth: spec.actual.width, roundedStride: badStride });
    }
    check(roundedStrideChanged, true, "exercise fractional cell widths that triggered the regression");
    term.dispose();
    host.remove();
    return { samples, pixelChecks: 280, repeatedResizes: true };
  }

  void app.whenReady().then(async () => {
    const bundle = esbuild.buildSync({
      stdin: {
        contents: 'export { Terminal } from "@xterm/xterm"; export { ImageAddon } from "@xterm/addon-image";',
        resolveDir: root,
      },
      bundle: true, format: "iife", globalName: "ImageResizeTest", platform: "browser", write: false,
    }).outputFiles[0].text;
    win = new BrowserWindow({ show: true, width: 1000, height: 600, webPreferences: { backgroundThrottling: false } });
    await win.loadURL("data:text/html,<body style='margin:0;background:black'>");
    await win.webContents.insertCSS(fs.readFileSync(require.resolve("@xterm/xterm/css/xterm.css"), "utf8"));
    const result = await win.webContents.executeJavaScript(`${bundle}\n(${exercise.toString()})(ImageResizeTest)`);
    console.log("IMAGE_RESIZE_RENDERING_OK", JSON.stringify(result));
    cleanup(0);
  }).catch(error => { console.error(error); cleanup(1); });
}
