"use strict";

const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");
const { PLUGIN_LOG_MAX_BYTES, PLUGIN_LOG_MAX_FILES } = require("./constants.cjs");
const { TokenBucket, DEFAULT_QUOTAS } = require("./quotaManager.cjs");

const SENSITIVE_KEY = /(?:password|passwd|token|secret|api.?key|private.?key|credential|authorization|cookie|totp|otpauth|prompt|notes?|sql|results?|terminal|content|body|payload)/iu;

// Bounds apply to the entire traversal, including hostile, cyclic or wide input.
// This is damage limitation for opt-in diagnostics, not a guarantee of secrecy.
function redactLogValue(value, key = "", depth = 0, budget = { remaining: 4096 }) {
  if (SENSITIVE_KEY.test(key)) return "[REDACTED]";
  if (depth >= 6 || budget.remaining <= 0) return "[TRUNCATED]";
  budget.remaining -= 16;
  if (value == null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const text = value.slice(0, Math.min(2048, Math.max(0, budget.remaining))).replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, " ");
    budget.remaining -= text.length;
    return text;
  }
  if (typeof value !== "object") return "[UNSUPPORTED]";
  try {
    const output = Array.isArray(value) ? [] : Object.create(null);
    // Stop enumeration as soon as the budget is exhausted.
    let count = 0;
    for (const entryKey in value) {
      if (budget.remaining <= 0 || count++ >= 32) break;
      const descriptor = Object.getOwnPropertyDescriptor(value, entryKey);
      if (!descriptor?.enumerable) continue;
      const safeKey = entryKey.slice(0, 64).replace(/[\u0000-\u001f\u007f]/gu, " ");
      budget.remaining -= safeKey.length;
      const item = "value" in descriptor ? redactLogValue(descriptor.value, entryKey, depth + 1, budget) : "[UNAVAILABLE]";
      if (Array.isArray(output)) output.push(item);
      else output[safeKey] = item;
    }
    return output;
  } catch { return "[UNAVAILABLE]"; }
}

/** One app-owned sink gives every plugin a shared disk and queue budget. */
class PluginLogSink {
  constructor(options) {
    this.directory = options.directory;
    this.maxBytes = options.maxBytes ?? PLUGIN_LOG_MAX_BYTES;
    this.maxFiles = options.maxFiles ?? PLUGIN_LOG_MAX_FILES;
    this.maxPendingBytes = options.maxPendingBytes ?? 256 * 1024;
    this.retentionMs = options.retentionMs ?? 7 * 24 * 60 * 60 * 1000;
    for (const value of [this.maxBytes, this.maxFiles, this.maxPendingBytes, this.retentionMs]) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError("Invalid plugin log limit");
    }
    this.clock = options.clock ?? Date.now;
    this.enabled = false;
    this.closed = false;
    this.pendingBytes = 0;
    this.diagnosticPendingBytes = 0;
    this.dropped = 0;
    this.writeErrors = 0;
    this.queue = Promise.resolve();
    this.generation = 0;
  }

  enqueue(record) {
    if (!this.enabled || this.closed) return;
    if (this.clearing) { this.dropped++; return; }
    let line;
    try { line = `${JSON.stringify({ ...record, droppedRecords: this.dropped, writeErrors: this.writeErrors })}\n`; }
    catch { this.dropped++; return; }
    const bytes = Buffer.byteLength(line);
    const diagnostic = record.recordType === "plugin-diagnostic";
    if ((diagnostic && this.diagnosticPendingBytes + bytes > this.maxPendingBytes / 4) || bytes > Math.min(this.maxBytes, 16 * 1024) || this.pendingBytes + bytes > this.maxPendingBytes) {
      this.dropped++; return;
    }
    const generation = this.generation;
    this.pendingBytes += bytes;
    if (diagnostic) this.diagnosticPendingBytes += bytes;
    this.queue = this.queue.then(async () => {
      if (generation !== this.generation) { this.dropped++; return; }
      await this.prune();
      const active = this.file(0);
      let size = 0;
      try { size = (await fs.stat(active)).size; } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (size + bytes > this.maxBytes) {
        await fs.rm(this.file(this.maxFiles - 1), { force: true });
        for (let index = this.maxFiles - 2; index >= 0; index--) {
          try { await fs.rename(this.file(index), this.file(index + 1)); }
          catch (error) { if (error.code !== "ENOENT") throw error; }
        }
      }
      const handle = await fs.open(active, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0), 0o600);
      try {
        if (!(await handle.stat()).isFile()) throw new Error("Unsafe plugin log file");
        await handle.writeFile(line);
      } finally { await handle.close(); }
    }).catch(() => { this.dropped++; this.writeErrors++; }).finally(() => {
      this.pendingBytes -= bytes;
      if (diagnostic) this.diagnosticPendingBytes -= bytes;
    });
  }

  file(index) { return path.join(this.directory, index === 0 ? "runtime.jsonl" : `runtime.${index}.jsonl`); }
  async prune() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    for (let index = 0; index < this.maxFiles; index++) {
      try {
        const stats = await fs.lstat(this.file(index));
        if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("Unsafe plugin log file");
        if (this.clock() - stats.mtimeMs > this.retentionMs || stats.size > this.maxBytes) await fs.rm(this.file(index));
      } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }
  flush() { return this.queue; }
  async setEnabled(enabled) {
    this.enabled = false;
    this.generation++;
    await this.flush();
    if (enabled === true && !this.closed) {
      await this.prune();
      this.enabled = true;
    }
  }
  async clear() {
    this.clearing = true;
    this.generation++;
    try {
      await this.flush();
      for (let index = 0; index < this.maxFiles; index++) await fs.rm(this.file(index), { force: true });
    } finally { this.clearing = false; }
  }
  async close() { this.closed = true; this.enabled = false; await this.flush(); }
  status() { return { droppedRecords: this.dropped, writeErrors: this.writeErrors, pendingBytes: this.pendingBytes }; }
}

class PluginLogger {
  constructor(options = {}) {
    this.sink = options.sink;
    this.identity = options.identity;
    this.verbose = options.verbose ?? (() => false);
    this.closed = false;
    this.audit = options.audit ?? (() => {});
    this.bucket = new TokenBucket(DEFAULT_QUOTAS.logWritesPerMinute, DEFAULT_QUOTAS.logWritesPerMinute / 60000, options.clock ?? Date.now);
  }
  write(level, message, fields) {
    if (this.closed || !this.sink?.enabled || !this.verbose()) return Promise.resolve();
    if (!this.bucket.consume()) { this.sink.dropped++; return Promise.resolve(); }
    this.sink.enqueue({
      timestamp: new Date().toISOString(),
      recordType: "plugin-diagnostic", trust: "plugin-authored-unverified",
      ...this.identity,
      level: ["debug", "info", "warn", "error"].includes(level) ? level : "info",
      diagnostic: {
        message: redactLogValue(typeof message === "string" ? message : "[INVALID MESSAGE]"),
        fields: redactLogValue(fields),
      },
    });
    return Promise.resolve();
  }
  close() { this.closed = true; }
}

module.exports = { PluginLogger, PluginLogSink, redactLogValue };
