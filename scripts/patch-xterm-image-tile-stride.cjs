#!/usr/bin/env node
/* global process, console */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const EXPECTED_VERSION = "0.10.0-beta.292";

// ImageStorage.addImage assigns tile IDs using ceil(orig.width/origCellSize.width).
// Keep that stride for draw, extractTile and viewportResize. Recomputing it from
// the rescaled canvas can add a column: ceil(400 * 9.51 / 10) / 9.51 > 40.
// DOM cell widths can change fractionally on window resize, shifting each image
// row one more tile and producing diagonal corruption (Netcatty #3746).
// Local pinned-version workaround pending an upstream release, not a merged
// upstream backport. The open draft uses the same original-grid principle:
// https://github.com/xtermjs/xterm.js/issues/5861
// https://github.com/xtermjs/xterm.js/pull/6145
// Patch both runtime bundles using the existing install-time patch pattern.
const PATCHES = [
  {
    file: "lib/addon-image.js",
    original: "const n=e.actual,h=Math.ceil(n.width/o),",
    replacement: "const n=e.actual,h=Math.ceil(e.orig.width/e.origCellSize.width),",
  },
  {
    file: "lib/addon-image.js",
    original: "const s=e.actual,o=Math.ceil(s.width/A),",
    replacement: "const s=e.actual,o=Math.ceil(e.orig.width/e.origCellSize.width),",
  },
  {
    file: "lib/addon-image.js",
    original: "const h=Math.ceil(((null===(t=n.actual)||void 0===t?void 0:t.width)||0)/n.actualCellSize.width);",
    replacement: "const h=Math.ceil(((null===(t=n.orig)||void 0===t?void 0:t.width)||0)/n.origCellSize.width);",
  },
  {
    file: "lib/addon-image.mjs",
    original: "let h=t.actual,g=Math.ceil(h.width/o),",
    replacement: "let h=t.actual,g=Math.ceil(t.orig.width/t.origCellSize.width),",
  },
  {
    file: "lib/addon-image.mjs",
    original: "let a=t.actual,n=Math.ceil(a.width/A),",
    replacement: "let a=t.actual,n=Math.ceil(t.orig.width/t.origCellSize.width),",
  },
  {
    file: "lib/addon-image.mjs",
    original: "let h=Math.ceil((d.actual?.width||0)/d.actualCellSize.width);",
    replacement: "let h=Math.ceil((d.orig?.width||0)/d.origCellSize.width);",
  },
];

function patchImageSource(source, patch) {
  const originalCount = source.split(patch.original).length - 1;
  const patchedCount = source.split(patch.replacement).length - 1;
  if (originalCount === 1 && patchedCount === 0) {
    return { source: source.replace(patch.original, patch.replacement), changed: true };
  }
  if (originalCount === 0 && patchedCount === 1) return { source, changed: false };
  throw new Error(
    `${patch.file}: unexpected image-tile-stride patch shape ` +
      `(original=${originalCount}, patched=${patchedCount})`,
  );
}

function patchInstalledImage(root = process.cwd()) {
  const base = path.resolve(root, "node_modules/@xterm/addon-image");
  const version = JSON.parse(fs.readFileSync(path.join(base, "package.json"), "utf8")).version;
  if (version !== EXPECTED_VERSION) {
    throw new Error(`unsupported @xterm/addon-image version ${version}; expected ${EXPECTED_VERSION}`);
  }
  // Validate both complete bundles before writing either one.
  const files = new Map();
  let changed = 0;
  for (const patch of PATCHES) {
    const source = files.get(patch.file) ?? fs.readFileSync(path.join(base, patch.file), "utf8");
    const result = patchImageSource(source, patch);
    files.set(patch.file, result.source);
    if (result.changed) changed++;
  }
  if (changed) {
    for (const [file, source] of files) fs.writeFileSync(path.join(base, file), source);
    fs.rmSync(path.resolve(root, "node_modules/.vite"), { recursive: true, force: true });
  }
  return { changed, checked: PATCHES.length };
}

if (require.main === module) {
  try {
    const result = patchInstalledImage();
    console.log(`[patch-xterm-image-tile-stride] changed=${result.changed} checked=${result.checked}`);
  } catch (error) {
    console.error(`[patch-xterm-image-tile-stride] ERROR: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { EXPECTED_VERSION, PATCHES, patchImageSource, patchInstalledImage };
