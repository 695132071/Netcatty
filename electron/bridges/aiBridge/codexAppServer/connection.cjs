"use strict";

const path = require("node:path");
const { spawn } = require("node:child_process");
const { createHash } = require("node:crypto");
const { StringDecoder } = require("node:string_decoder");

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const INITIALIZE_TIMEOUT_MS = 10_000;
const MAX_STDERR_CHARS = 32_000;
const MAX_JSONL_LINE_BYTES = 16 * 1024 * 1024;
const CLOSE_KILL_GRACE_MS = 750;

function createBoundedLineReader(stream, onLine, onError, maxLineBytes) {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  let bufferedBytes = 0;
  let closed = false;

  const fail = () => {
    buffer = "";
    bufferedBytes = 0;
    onError(new Error(`Codex App Server message exceeded ${maxLineBytes} bytes`));
  };
  const onData = (chunk) => {
    if (closed) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk || ""));
    bufferedBytes += bytes.length;
    buffer += decoder.write(bytes);
    let index;
    let consumedLine = false;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      consumedLine = true;
      if (line) onLine(line);
      if (closed) return;
    }
    if (consumedLine) bufferedBytes = Buffer.byteLength(buffer, "utf8") + decoder.lastNeed;
    if (bufferedBytes > maxLineBytes) fail();
  };
  const onEnd = () => {
    if (closed) return;
    buffer += decoder.end();
    const line = buffer.trim();
    buffer = "";
    bufferedBytes = 0;
    if (line) onLine(line);
  };

  stream?.on?.("data", onData);
  stream?.once?.("end", onEnd);
  return {
    close() {
      if (closed) return;
      closed = true;
      buffer = "";
      bufferedBytes = 0;
      stream?.removeListener?.("data", onData);
      stream?.removeListener?.("end", onEnd);
    },
  };
}

function buildCodexAppServerLaunch(binPath, args = ["app-server", "--stdio"], {
  nodePath = process.execPath,
} = {}) {
  const executable = String(binPath || "").trim();
  if (!executable) {
    throw new Error("Codex binary not found. Configure Codex in Settings -> AI.");
  }
  const extension = path.extname(executable).toLowerCase();
  if (extension === ".js" || extension === ".cjs" || extension === ".mjs") {
    return {
      command: nodePath,
      args: [executable, ...args],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    };
  }
  if (extension === ".cmd" || extension === ".bat" || extension === ".ps1") {
    throw new Error(
      `Codex App Server cannot launch the shell shim ${executable}. ` +
      "Configure the native Codex executable or reinstall the Codex CLI.",
    );
  }
  return { command: executable, args };
}

function buildCodexAppServerKey(binPath, env) {
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(
      Object.entries(env || {})
        .map(([key, value]) => [key, String(value)])
        .sort(([left], [right]) => left.localeCompare(right)),
    ))
    .digest("hex");
  return `${String(binPath || "")}\u0000${fingerprint}`;
}

class CodexAppServerConnection {
  constructor({
    binPath,
    env,
    appVersion = "0.0.0",
    spawnImpl = spawn,
    onNotification,
    onServerRequest,
    onFatal,
    closeKillGraceMs = CLOSE_KILL_GRACE_MS,
    maxJsonlLineBytes = MAX_JSONL_LINE_BYTES,
  }) {
    this.binPath = binPath;
    this.env = env || {};
    this.appVersion = appVersion;
    this.spawnImpl = spawnImpl;
    this.onNotification = onNotification;
    this.onServerRequest = onServerRequest;
    this.onFatal = onFatal;
    this.closeKillGraceMs = closeKillGraceMs;
    this.maxJsonlLineBytes = maxJsonlLineBytes;
    this.process = null;
    this.closingProcesses = new Map();
    this.readline = null;
    this.nextRequestId = 1;
    this.pending = new Map();
    this.startPromise = null;
    this.initialized = false;
    this.closing = false;
    this.stderr = "";
  }

  async start() {
    if (this.initialized && this.process && !this.process.killed) return this;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.#startInternal().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  async #startInternal() {
    this.closing = false;
    this.stderr = "";
    const launch = buildCodexAppServerLaunch(this.binPath);
    const child = this.spawnImpl(launch.command, launch.args, {
      cwd: process.cwd(),
      env: { ...this.env, ...(launch.env || {}) },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    });
    this.process = child;

    child.stderr?.setEncoding?.("utf8");
    child.stderr?.on?.("data", (chunk) => {
      this.stderr = `${this.stderr}${String(chunk || "")}`.slice(-MAX_STDERR_CHARS);
    });

    this.readline = createBoundedLineReader(
      child.stdout,
      (line) => this.#handleLine(line),
      (error) => this.#handleFatal(error),
      this.maxJsonlLineBytes,
    );

    child.once("error", (error) => {
      if (this.closingProcesses.has(child) || this.process !== child) return;
      this.#handleFatal(error);
    });
    child.once("exit", (code, signal) => {
      const wasClosing = this.closingProcesses.has(child);
      if (wasClosing) this.#releaseClosingProcess(child);
      if (wasClosing || this.process !== child) return;
      const detail = this.stderr.trim();
      const suffix = detail ? `\n${detail}` : "";
      this.#handleFatal(new Error(
        `Codex App Server exited unexpectedly (code ${code ?? "null"}, signal ${signal ?? "none"}).${suffix}`,
      ));
    });

    try {
      await this.request("initialize", {
        clientInfo: {
          name: "netcatty",
          title: "Netcatty",
          version: this.appVersion,
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
          mcpServerOpenaiFormElicitation: false,
        },
      }, INITIALIZE_TIMEOUT_MS, { skipStart: true });
      this.notify("initialized", {});
      this.initialized = true;
      return this;
    } catch (error) {
      this.close();
      const detail = this.stderr.trim();
      if (detail && !String(error?.message || error).includes(detail)) {
        throw new Error(`${error?.message || error}\n${detail}`);
      }
      throw error;
    }
  }

  async request(method, params = {}, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, options = {}) {
    if (!options.skipStart) await this.start();
    // Even an initialized connection yields in start(). Revalidate prompt
    // handoffs after that await, before any JSONL payload reaches the process.
    options.beforeSend?.();
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex App Server request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      try {
        this.#write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method, params = {}) {
    this.#write({ method, params });
  }

  respond(id, result) {
    this.#write({ id, result });
  }

  respondError(id, code, message, data) {
    const error = { code, message };
    if (data !== undefined) error.data = data;
    this.#write({ id, error });
  }

  #write(message) {
    const stdin = this.process?.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) {
      throw new Error("Codex App Server stdin is unavailable");
    }
    stdin.write(`${JSON.stringify(message)}\n`);
  }

  #handleLine(rawLine) {
    const line = String(rawLine || "").trim();
    if (!line) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.#handleFatal(new Error(`Codex App Server emitted invalid JSON: ${line.slice(0, 500)}`));
      return;
    }

    if (Object.prototype.hasOwnProperty.call(message, "id") && !message.method) {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) {
        const error = new Error(message.error.message || `Codex App Server ${entry.method} failed`);
        error.code = message.error.code;
        error.data = message.error.data;
        entry.reject(error);
      } else {
        entry.resolve(message.result);
      }
      return;
    }

    if (message.method && Object.prototype.hasOwnProperty.call(message, "id")) {
      Promise.resolve(this.onServerRequest?.(message, this)).catch((error) => {
        try {
          this.respondError(message.id, -32603, error?.message || String(error));
        } catch {}
      });
      return;
    }

    if (message.method) {
      try {
        this.onNotification?.(message, this);
      } catch (error) {
        this.#handleFatal(error);
      }
    }
  }

  #handleFatal(error) {
    if (this.closing) return;
    this.initialized = false;
    const fatal = error instanceof Error ? error : new Error(String(error));
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(fatal);
    }
    this.pending.clear();
    try { this.onFatal?.(fatal, this); } catch {}
    this.close();
  }

  #releaseClosingProcess(child) {
    if (!this.closingProcesses.has(child)) return;
    clearTimeout(this.closingProcesses.get(child));
    this.closingProcesses.delete(child);
  }

  getClosingProcessCountForTests() {
    return this.closingProcesses.size;
  }

  close() {
    this.closing = true;
    this.initialized = false;
    try { this.readline?.close?.(); } catch {}
    this.readline = null;
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error("Codex App Server connection closed"));
    }
    this.pending.clear();
    const child = this.process;
    this.process = null;
    if (!child) return;
    try { child.stdin?.end?.(); } catch {}
    this.closingProcesses.set(child, null);
    const killTimer = setTimeout(() => {
      if (!this.closingProcesses.has(child)) return;
      try { child.kill?.("SIGKILL"); } catch {}
      this.#releaseClosingProcess(child);
    }, this.closeKillGraceMs);
    killTimer.unref?.();
    this.closingProcesses.set(child, killTimer);
    try { child.kill?.("SIGTERM"); } catch {}
  }
}

module.exports = {
  CodexAppServerConnection,
  buildCodexAppServerKey,
  buildCodexAppServerLaunch,
  DEFAULT_REQUEST_TIMEOUT_MS,
  INITIALIZE_TIMEOUT_MS,
  CLOSE_KILL_GRACE_MS,
  MAX_JSONL_LINE_BYTES,
};
