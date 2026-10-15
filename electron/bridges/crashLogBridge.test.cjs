"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  MAX_LOG_FILE_BYTES,
  MAX_LOG_ENTRY_BYTES,
  appendEntryLine,
  boundedText,
  serializeEntry,
  truncateFileToTail,
} = require("./crashLogBridge.cjs").__internals;

// Creates a unique temp directory for one test and registers teardown on the
// test context so fixture files never outlive the run.
function tmpFile(t, name = "crash-2026-10-10.log") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-crashlog-"));
  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort cleanup
    }
  });
  return { dir, filePath: path.join(dir, name) };
}

function entryLine(padLen = 0) {
  return JSON.stringify({
    timestamp: "2026-10-10T00:00:00.000Z",
    source: "test",
    message: "boom",
    ...(padLen > 0 ? { pad: "p".repeat(padLen) } : {}),
  });
}

test("appendEntryLine stops accepting entries once the per-day file reaches the size cap", (t) => {
  const { filePath } = tmpFile(t);

  assert.equal(appendEntryLine(filePath, entryLine()), true, "first entry written");
  assert.equal(
    appendEntryLine(filePath, "x".repeat(MAX_LOG_ENTRY_BYTES)),
    false,
    "oversized entry rejected",
  );

  // Model the boundary with a small real file, without allocating a full log.
  const filler = JSON.stringify({ message: "\u4e2d" });
  const lineBytes = Buffer.byteLength(filler, "utf-8");
  const before = fs.readFileSync(filePath, "utf-8");
  const stat = t.mock.method(fs, "statSync", () => ({ size: MAX_LOG_FILE_BYTES - lineBytes }));
  assert.equal(appendEntryLine(filePath, filler), false, "newline would exceed cap by one byte");
  assert.equal(fs.readFileSync(filePath, "utf-8"), before);
  stat.mock.mockImplementation(() => ({ size: MAX_LOG_FILE_BYTES - lineBytes - 1 }));
  assert.equal(appendEntryLine(filePath, filler), true, "entry plus newline fits exactly");
  assert.equal(fs.readFileSync(filePath, "utf-8"), before + filler + "\n");
});

test("serializeEntry keeps serialized lines bounded even for huge extras", () => {
  const huge = { blob: "z".repeat(MAX_LOG_ENTRY_BYTES + 1) };
  const line = serializeEntry({
    timestamp: "2026-10-10T00:00:00.000Z",
    source: "test",
    message: "boom",
    stack: new Error("boom").stack,
    extra: huge,
  });
  assert.ok(line.length <= MAX_LOG_ENTRY_BYTES, `line length ${line.length} exceeds cap`);
  const entry = JSON.parse(line);
  assert.equal(entry.source, "test");
  assert.equal(entry.message, "boom");
});

test("boundedText truncates long strings and leaves short ones alone", () => {
  assert.equal(boundedText("short", 100), "short");
  const cut = boundedText("a".repeat(5000), 4096);
  assert.equal(cut.length, 4096 + " ... [truncated]".length);
  assert.ok(cut.startsWith("a".repeat(4096)));
  assert.ok(cut.endsWith("[truncated]"));
});

test("truncateFileToTail trims oversized files to their last lines", (t) => {
  const { filePath } = tmpFile(t);

  const maxBytes = 1024;
  const line = entryLine(128);
  const content = (line + "\n").repeat(8);
  fs.writeFileSync(filePath, content);
  assert.ok(fs.statSync(filePath).size > maxBytes);

  assert.equal(truncateFileToTail(filePath, maxBytes), true);
  const newSize = fs.statSync(filePath).size;
  assert.ok(newSize <= maxBytes, `trimmed size ${newSize} exceeds cap`);
  assert.equal(appendEntryLine(filePath, entryLine()), true, "trimmed log remains appendable");
  // Every remaining line must be a complete, parseable JSONL entry.
  const remaining = fs.readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
  assert.ok(remaining.length > 0);
  for (const l of remaining) assert.doesNotThrow(() => JSON.parse(l));

  // Files under the cap are left untouched.
  assert.equal(truncateFileToTail(filePath, maxBytes), false);
});

test("truncateFileToTail tolerates a tail with no newline and missing files", (t) => {
  const { dir, filePath } = tmpFile(t);

  // Missing file
  assert.equal(truncateFileToTail(path.join(dir, "crash-2026-01-01.log"), MAX_LOG_FILE_BYTES), false);

  // Discard an oversized unterminated line so later entries can be appended.
  fs.appendFileSync(filePath, "g".repeat(8192));
  assert.equal(truncateFileToTail(filePath, 4096), true);
  assert.equal(fs.statSync(filePath).size, 0);

  // Oversized tail whose final write was interrupted before its trailing
  // newline: three terminated entries followed by one entry whose trailing
  // newline was never written. The partial final line must be dropped so the
  // rewritten file ends on a complete JSONL boundary and the next append does
  // not merge with a partial object.
  fs.appendFileSync(
    filePath,
    Array.from({ length: 3 }, () => entryLine(1200) + "\n").join("") +
      entryLine(1200),
  );
  assert.ok(fs.statSync(filePath).size > 4096);
  assert.equal(truncateFileToTail(filePath, 4096), true);
  const trimmed = fs.readFileSync(filePath, "utf-8");
  assert.ok(trimmed.endsWith("\n"), "trimmed file must end on a line boundary");
  for (const l of trimmed.split("\n").filter(Boolean)) {
    assert.doesNotThrow(() => JSON.parse(l));
  }
});

test("truncateFileToTail leaves symlink targets and non-regular files untouched", (t) => {
  const { dir, filePath } = tmpFile(t);
  const target = path.join(dir, "unrelated.txt");
  const content = (entryLine() + "\n").repeat(4);
  fs.writeFileSync(target, content);
  fs.symlinkSync(target, filePath);
  assert.equal(truncateFileToTail(filePath, 128), false);
  assert.equal(fs.readFileSync(target, "utf-8"), content);
  assert.ok(fs.lstatSync(filePath).isSymbolicLink());
  assert.equal(truncateFileToTail(dir, 1), false);
});

test("truncateFileToTail verifies the opened file before modifying it", (t) => {
  const { dir, filePath } = tmpFile(t);
  const replacement = path.join(dir, "replacement.log");
  const content = (entryLine() + "\n").repeat(4);
  fs.writeFileSync(filePath, content);
  fs.writeFileSync(replacement, content);
  const openSync = fs.openSync;
  const open = t.mock.method(fs, "openSync", (_filePath, flags) => openSync(replacement, flags));
  assert.equal(truncateFileToTail(filePath, 128), false);
  open.mock.restore();
  assert.equal(fs.readFileSync(filePath, "utf-8"), content);
  assert.equal(fs.readFileSync(replacement, "utf-8"), content);
});
