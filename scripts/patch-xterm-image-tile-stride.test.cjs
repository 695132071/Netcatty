"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");
const { EXPECTED_VERSION, PATCHES, patchImageSource, patchInstalledImage } = require("./patch-xterm-image-tile-stride.cjs");

for (const patch of PATCHES) {
  test(`${patch.file}: ${patch.original.slice(0, 24)} patches once and rejects drift`, () => {
    const first = patchImageSource(`before;${patch.original}after`, patch);
    assert.equal(first.changed, true);
    assert.equal(first.source, `before;${patch.replacement}after`);
    assert.deepEqual(patchImageSource(first.source, patch), { source: first.source, changed: false });
    for (const source of ["upstream changed", patch.original.repeat(2), patch.replacement.repeat(2), patch.original + patch.replacement]) {
      assert.throws(() => patchImageSource(source, patch), /unexpected image-tile-stride patch shape/);
    }
  });
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-image-stride-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const base = path.join(root, "node_modules/@xterm/addon-image");
  fs.mkdirSync(path.join(base, "lib"), { recursive: true });
  fs.writeFileSync(path.join(base, "package.json"), JSON.stringify({ version: EXPECTED_VERSION }));
  for (const file of new Set(PATCHES.map(p => p.file))) {
    fs.writeFileSync(path.join(base, file), PATCHES.filter(p => p.file === file).map(p => p.original).join("\n"));
  }
  return { root, base };
}

test("install patches both bundles, invalidates Vite cache and is idempotent", t => {
  const { root, base } = fixture(t);
  const cache = path.join(root, "node_modules/.vite");
  fs.mkdirSync(cache);
  assert.deepEqual(patchInstalledImage(root), { changed: 6, checked: 6 });
  assert.equal(fs.existsSync(cache), false);
  for (const patch of PATCHES) assert.ok(fs.readFileSync(path.join(base, patch.file), "utf8").includes(patch.replacement));
  assert.deepEqual(patchInstalledImage(root), { changed: 0, checked: 6 });
});

test("install fails closed on a changed version or bundle before writing anything", t => {
  const { root, base } = fixture(t);
  const cjs = path.join(base, "lib/addon-image.js");
  const original = fs.readFileSync(cjs, "utf8");
  fs.writeFileSync(path.join(base, "package.json"), JSON.stringify({ version: "future" }));
  assert.throws(() => patchInstalledImage(root), /unsupported @xterm\/addon-image version/);
  assert.equal(fs.readFileSync(cjs, "utf8"), original);
  fs.writeFileSync(path.join(base, "package.json"), JSON.stringify({ version: EXPECTED_VERSION }));
  fs.writeFileSync(path.join(base, "lib/addon-image.mjs"), "upstream changed");
  assert.throws(() => patchInstalledImage(root), /unexpected image-tile-stride patch shape/);
  assert.equal(fs.readFileSync(cjs, "utf8"), original);
});

// Exercise the installed addon itself, not a copy of its stride expression.
// Canvas calls are captured so these regressions also run in the normal Node suite.
function canvas(width, height) {
  const calls = [];
  const element = { width, height, calls, remove() {} };
  element.getContext = () => ({ canvas: element, drawImage: (...args) => calls.push(args), clearRect() {} });
  return element;
}

function setup(ImageAddon, { imageWidth = 400, cellWidth = 10, cols = 80, layer = "top" } = {}) {
  const event = () => ({ dispose() {} });
  const lines = Array.from({ length: 24 }, () => ({
    _data: new Uint32Array(100 * 3), _extendedAttrs: {},
    getBg(x) { return this._data[x * 3 + 2]; },
  }));
  const cell = { width: cellWidth, height: 20 };
  const buffer = { x: 0, y: 0, ybase: 0, lines: { get: y => lines[y], length: lines.length } };
  const term = {
    cols, rows: 24, dimensions: { css: { cell } },
    _core: {
      open() {}, buffer,
      _coreBrowserService: { window: { document: { createElement: () => canvas(0, 0) } } },
      optionsService: { onOptionChange: event },
      _inputHandler: { onRequestReset: event, _dirtyRowTracker: { markDirty() {} }, lineFeed: () => buffer.y++ },
    },
    parser: { registerCsiHandler: event, registerEscHandler: event },
    buffer: { active: { type: "normal" }, onBufferChange: event },
    onRender: event, onResize: event,
    registerMarker: () => ({ onDispose() {}, dispose() {} }),
  };
  const addon = new ImageAddon({ enableSizeReports: false, sixelSupport: false, iipSupport: false, kittySupport: false });
  addon.activate(term);
  const image = canvas(imageWidth, 400);
  const imageId = addon._storage.addImage(image, { scrolling: true, layer, zIndex: 0, cursorPos: "vt340" });
  const spec = addon._storage._images.get(imageId);
  const output = canvas(1000, 480);
  addon._renderer._layers.set(layer, output.getContext("2d"));
  return { addon, cell, spec, output, lines };
}

for (const format of ["js", "mjs"]) {
  const loadAddon = async () => {
    const file = path.resolve(__dirname, `../node_modules/@xterm/addon-image/lib/addon-image.${format}`);
    return format === "js" ? require(file) : import(pathToFileURL(file).href);
  };
  for (const layer of ["top", "bottom"]) {
    test(`${format}: ${layer} image rows and extracted tiles keep their original stride through repeated resizes`, async () => {
      const { ImageAddon } = await loadAddon();
      for (const options of [{}, { imageWidth: 397 }, { imageWidth: 384, cellWidth: 9.6 }]) {
        const { addon, cell, spec, output, lines } = setup(ImageAddon, { ...options, layer });
        const stride = Math.ceil(spec.orig.width / spec.origCellSize.width);
        assert.equal(stride, 40);
        assert.equal(lines[1]._extendedAttrs[0].tileId, stride);
        const originalWidth = cell.width;
        for (const width of [originalWidth, 9.51, 10.02, 12, 8.73, originalWidth]) {
          cell.width = width;
          for (const tileId of [40, 41, 79, 80, 799]) {
            addon._renderer.draw(spec, tileId, 3, 2);
            const [, sx, sy, , , dx, dy] = output.calls.at(-1);
            assert.equal(sx, Math.floor((tileId % stride) * width), `draw x: tile=${tileId}, width=${width}`);
            assert.equal(sy, Math.floor(tileId / stride) * cell.height, `draw y: tile=${tileId}, width=${width}`);
            assert.equal(dx, Math.floor(3 * width));
            assert.equal(dy, 2 * cell.height);
            const tile = addon._renderer.extractTile(spec, tileId);
            assert.equal(tile.calls[0][1], sx, "extractTile uses the same source column as draw");
            assert.equal(tile.calls[0][2], sy, "extractTile uses the same source row as draw");
          }
          addon._renderer.draw(spec, stride, 0, 1, stride);
          assert.equal(output.calls.at(-1)[1], 0, "batched second row starts at the left edge");
          assert.equal(output.calls.at(-1)[2], cell.height);
        }
        assert.equal(spec.actual, spec.orig, "restoring cell metrics restores the original image");
      }
    });
  }

  test(`${format}: viewport growth after rescaling does not append the next image row`, async () => {
    const { ImageAddon } = await loadAddon();
    for (const cols of [20, 40]) {
      const { addon, cell, spec, lines } = setup(ImageAddon, { cols });
      cell.width = 9.51;
      addon._renderer.draw(spec, 0, 0, 0);
      assert.equal(spec.actual.width, 381, "rescaled integer canvas would incorrectly imply 41 columns");
      addon._storage.viewportResize({ cols: 50, rows: 24 });
      for (let row = 0; row < 20; row++) {
        for (let col = 0; col < 40; col++) assert.equal(lines[row]._extendedAttrs[col].tileId, row * 40 + col);
        assert.equal(lines[row]._extendedAttrs[40], undefined, "must stop at the original row boundary");
      }
      assert.equal(spec.tileCount, 800);
    }
  });
}
