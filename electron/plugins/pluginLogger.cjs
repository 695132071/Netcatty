"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const { PLUGIN_LOG_MAX_BYTES, PLUGIN_LOG_MAX_FILES } = require("./constants.cjs");
const { assertPluginStorageSegment } = require("./paths.cjs");

const SENSITIVE_KEY = /(?:password|passwd|token|secret|private.?key|credential|authorization|cookie|totp|otpauth)/iu;

function redactLogValue(value, key = "", depth = 0) {
  if (SENSITIVE_KEY.test(key)) return "[REDACTED]";
  if (depth >= 8) return "[TRUNCATED]";
  if (value == null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value.slice(0, 2_048);
  if (Array.isArray(value)) {
    const output = [];
    for (let index = 0; index < Math.min(value.length, 64); index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      output.push(descriptor && "value" in descriptor
        ? redactLogValue(descriptor.value, "", depth + 1)
        : "[UNAVAILABLE]");
    }
    return output;
  }
  if (typeof value === "object") {
    const output = {};
    for (const entryKey of Object.keys(value).slice(0, 64)) {
      if (SENSITIVE_KEY.test(entryKey)) {
        output[entryKey.slice(0, 128)] = "[REDACTED]";
        continue;
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, entryKey);
      output[entryKey.slice(0, 128)] = descriptor && "value" in descriptor
        ? redactLogValue(descriptor.value, entryKey, depth + 1)
        : "[UNAVAILABLE]";
    }
    return output;
  }
  return "[UNSUPPORTED]";
}

class PluginLogger {
  constructor(options) {
    this.pluginId = assertPluginStorageSegment(options.pluginId, "ID");
    this.directory = path.join(options.logsDirectory, this.pluginId);
    this.maxBytes = options.maxBytes ?? PLUGIN_LOG_MAX_BYTES;
    this.maxFiles = options.maxFiles ?? PLUGIN_LOG_MAX_FILES;
    this.maxPendingBytes = options.maxPendingBytes ?? Math.min(this.maxBytes, 256 * 1024);
    this.pendingBytes = 0;
    this.queue = Promise.resolve();
  }

  write(level, message, fields) {
    const record = JSON.stringify({
      timestamp: new Date().toISOString(),
      level: ["debug", "info", "warn", "error"].includes(level) ? level : "info",
      message: String(message ?? "").slice(0, 2_048),
      ...(fields === undefined ? {} : { fields: redactLogValue(fields) }),
    });
    const line = `${record}\n`;
    const bytes = Buffer.byteLength(line);
    if (this.pendingBytes + bytes > this.maxPendingBytes) return Promise.resolve();
    this.pendingBytes += bytes;
    this.queue = this.queue
      .then(() => this.#append(line))
      .catch(() => {})
      .finally(() => { this.pendingBytes -= bytes; });
    return this.queue;
  }

  async #append(line) {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const activePath = path.join(this.directory, "runtime.log");
    let size = 0;
    try { size = (await fs.stat(activePath)).size; } catch {}
    if (size + Buffer.byteLength(line) > this.maxBytes) await this.#rotate();
    await fs.appendFile(activePath, line, { encoding: "utf8", mode: 0o600 });
  }

  async #rotate() {
    await fs.rm(path.join(this.directory, `runtime.${this.maxFiles}.log`), { force: true });
    for (let index = this.maxFiles - 1; index >= 1; index -= 1) {
      try {
        await fs.rename(
          path.join(this.directory, index === 1 ? "runtime.log" : `runtime.${index - 1}.log`),
          path.join(this.directory, `runtime.${index}.log`),
        );
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  }
}

module.exports = { PluginLogger, redactLogValue };
