"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");
const { EXPECTED_VERSION, PATCHES, patchImageSource, patchInstalledImage } = require("./patch-xterm-image-iip-type.cjs");

for (const patch of PATCHES) {
  test(`${patch.file}: ${patch.original.slice(0, 24)} patches once and rejects drift`, () => {
    const first = patchImageSource(`before;${patch.original}after`, patch);
    assert.equal(first.changed, true);
    assert.equal(first.source, `before;${patch.replacement}after`);
    assert.deepEqual(patchImageSource(first.source, patch), { source: first.source, changed: false });
    for (const source of ["upstream changed", patch.original.repeat(2), patch.replacement.repeat(2), patch.original + patch.replacement]) {
      assert.throws(() => patchImageSource(source, patch), /unexpected image-iip-type patch shape/);
    }
  });
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-image-iip-type-"));
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
  assert.deepEqual(patchInstalledImage(root), { changed: 4, checked: 4 });
  assert.equal(fs.existsSync(cache), false);
  for (const patch of PATCHES) assert.ok(fs.readFileSync(path.join(base, patch.file), "utf8").includes(patch.replacement));
  assert.deepEqual(patchInstalledImage(root), { changed: 0, checked: 4 });
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
  assert.throws(() => patchInstalledImage(root), /unexpected image-iip-type patch shape/);
  assert.equal(fs.readFileSync(cjs, "utf8"), original);
});

// Use the shipped handler and WASM decoder, with only browser image decoding and
// storage mocked. The desktop smoke covers the actual bitmap rendering.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64");

function setup(ImageAddon) {
  const event = () => ({ dispose() {} });
  const term = {
    cols: 80, rows: 24,
    _core: {
      open() {},
      _coreBrowserService: { window: { document: {} } },
      optionsService: { onOptionChange: event },
      _inputHandler: { onRequestReset: event, _parser: { registerOscHandler: event } },
    },
    parser: { registerCsiHandler: event, registerEscHandler: event },
    buffer: { active: { type: "normal" }, onBufferChange: event },
    onRender: event, onResize: event,
  };
  const addon = new ImageAddon({ enableSizeReports: false, sixelSupport: false, kittySupport: false });
  addon.activate(term);
  const images = [];
  addon._storage.addImage = image => images.push(image);
  return { addon, handler: addon._handlers.get("iip"), images };
}

async function send(handler, data, chunkSize) {
  const codes = Uint32Array.from(data, c => c.charCodeAt(0));
  handler.start();
  for (let start = 0; start < codes.length; start += chunkSize) {
    handler.put(codes, start, Math.min(start + chunkSize, codes.length));
  }
  await handler.end(true);
}

for (const format of ["js", "mjs"]) {
  test(`${format}: type metadata preserves FILE and multipart decoding, whole and bytewise`, async t => {
    const file = path.resolve(__dirname, `../node_modules/@xterm/addon-image/lib/addon-image.${format}`);
    const { ImageAddon } = format === "js" ? require(file) : await import(pathToFileURL(file).href);
    const originalBitmap = Object.getOwnPropertyDescriptor(globalThis, "createImageBitmap");
    globalThis.createImageBitmap = async (blob, options) => ({ blob, ...options });
    t.after(() => {
      if (originalBitmap) Object.defineProperty(globalThis, "createImageBitmap", originalBitmap);
      else delete globalThis.createImageBitmap;
    });
    for (const chunkSize of [4096, 1]) {
      const { addon, handler, images } = setup(ImageAddon);
      const body = PNG.toString("base64");
      const headers = [
        "inline=1", // unchanged standard header
        "inline=1;type=image/png", // reporter's final metadata field
        "type=image/png;inline=1", // do not prevent subsequent known fields
        "inline=1;type=application/octet-stream", // no MIME hardcoding
      ];
      for (const header of headers) {
        const count = images.length;
        await send(handler, `File=size=${PNG.length};${header}:${body}`, chunkSize);
        assert.equal(images.length, count + 1, header);
        assert.equal(handler._hp.fields.type, 1);
        assert.equal(images.at(-1).blob.type, "image/png", "image type still comes from payload bytes");
        assert.deepEqual(Buffer.from(await images.at(-1).blob.arrayBuffer()), PNG);
      }
      const count = images.length;
      await send(handler, `MultipartFile=inline=1;size=${PNG.length};type=image/png`, chunkSize);
      assert.equal(handler._hp.fields.type, 2, "final type value must not break HeaderParser.end()");
      await send(handler, `FilePart=${body}`, chunkSize);
      await send(handler, "FileEnd", chunkSize);
      assert.equal(images.length, count + 1);
      assert.deepEqual(Buffer.from(await images.at(-1).blob.arrayBuffer()), PNG);
      await send(handler, `File=inline=0;type=image/png:${body}`, chunkSize);
      assert.equal(images.length, count + 1, "non-inline files stay suppressed");
      addon.dispose();
    }
  });
}
