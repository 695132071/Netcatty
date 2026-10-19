#!/usr/bin/env node
/* global process, console */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const EXPECTED_VERSION = "0.10.0-beta.292";

// External IIP metadata must not overwrite fields.type, the parser's internal
// SequenceType discriminator. In particular, nu_plugin_charton emits type=image/png
// and otherwise skips FILE decoder initialization (Netcatty #3700).
// Pinned-version workaround pending an upstream release; patch both runtime bundles.
const PATCHES = [
  ...["lib/addon-image.js", "lib/addon-image.mjs"].map(file => ({
    file,
    original: "this._key=t,this.fields[t]=null,!0",
    replacement: 'this._key=t,t!=="type"&&(this.fields[t]=null),!0',
  })),
  ...["lib/addon-image.js", "lib/addon-image.mjs"].map(file => ({
    file,
    original: "_storeValue(e){if(this._key){try{",
    replacement: '_storeValue(e){if(this._key){if(this._key==="type")return!0;try{',
  })),
];

function patchImageSource(source, patch) {
  const originalCount = source.split(patch.original).length - 1;
  const patchedCount = source.split(patch.replacement).length - 1;
  if (originalCount === 1 && patchedCount === 0) {
    return { source: source.replace(patch.original, patch.replacement), changed: true };
  }
  if (originalCount === 0 && patchedCount === 1) return { source, changed: false };
  throw new Error(
    `${patch.file}: unexpected image-iip-type patch shape ` +
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
    console.log(`[patch-xterm-image-iip-type] changed=${result.changed} checked=${result.checked}`);
  } catch (error) {
    console.error(`[patch-xterm-image-iip-type] ERROR: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { EXPECTED_VERSION, PATCHES, patchImageSource, patchInstalledImage };
