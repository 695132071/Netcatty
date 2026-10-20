"use strict";

const fs = require("node:fs");
const { spawn, spawnSync, execFile } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const { prepareCommandForSpawn, resolveCliFromPath, stripAnsi } = require("../../ai/shellUtils.cjs");
const { buildSdkAgentEnv } = require("./env.cjs");
const {
  OPENCODE_LIST_SERVER_IDLE_MS,
  OPENCODE_SERVER_START_TIMEOUT_MS,
  buildOpenCodeConfig,
  buildOpenCodePromptParts,
  classifyOpenCodeSpawnError,
  parseOpenCodeModel,
  resolveUsableOpenCodeBinPath,
  withOpenCodeServerPort,
} = require("./opencodeDriver.cjs");

const OPENCODE_V2_PASSWORD_GRACE_MS = 400;
const OPENCODE_V2_VERSION_PROBE_MS = 8000;
const OPENCODE_V2_CATALOG_SETTLE_POLL_MS = 100;
const OPENCODE_V2_CATALOG_SETTLE_QUIET_MS = 400;
const OPENCODE_V2_CATALOG_SETTLE_MAX_MS = 8000;
const OPENCODE_V2_USERNAME = "opencode";
const OPENCODE_V2_TRANSPORT_MESSAGE = /^(?:terminated|fetch failed|other side closed)$/i;
const OPENCODE_V1_NOT_FOUND = "OpenCode CLI not found or not runnable. Install OpenCode and ensure `opencode` is on PATH, or set a custom path in Settings.";

const versionCache = new Map();
const listServers = new Map();
const stoppingChildren = new WeakSet();

function openCodeV2UserError(message) {
  const error = new Error(message);
  error.code = "OPENCODE_V2_USER";
  return error;
}

function isOpenCodeV2UserMessage(message) {
  return /^ai\.opencode\.v2\.[A-Za-z0-9]+$/.test(String(message || ""));
}

function parseOpenCodeVersionOutput(text) {
  const lines = stripAnsi(String(text || "")).split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/^(?:file|node):\/\//i.test(line) || /^\s*at\s+/i.test(line)) continue;
    if (/\b(?:Error|TypeError|ReferenceError|SyntaxError|ERR_[A-Z_]+)\b/.test(line)) continue;
    if (/https?:\/\//i.test(line) || /\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/.test(line)) continue;
    const match = line.match(/(?:^|[^\d.])v?(\d+)\.(\d+)(?:\.(\d+))?(?:[-+][0-9A-Za-z.-]+)?(?=$|[^\d.])/i);
    if (!match) continue;
    // Node.js and Bun crash banners end with their own runtime version.
    const runtime = line.slice(0, match.index).trim();
    if (/(?:^|\b)(?:node\.js|bun)$/i.test(runtime)) continue;
    const major = Number(match[1]);
    if (!Number.isInteger(major) || major > 100) continue;
    return {
      major,
      minor: Number(match[2]),
      patch: match[3] == null ? 0 : Number(match[3]),
    };
  }
  return null;
}

function isOpenCodeV2Version(version) {
  return Boolean(version && Number(version.major) >= 2);
}

function versionCacheKey(resolvedPath, env) {
  let mtime = "";
  if (resolvedPath) {
    try { mtime = String(fs.statSync(resolvedPath).mtimeMs); } catch {}
  }
  return [resolvedPath || "", mtime, env?.PATH || ""].join("\0");
}

function execFileResult(command, args, options, execFileImpl = execFile) {
  return new Promise((resolve, reject) => {
    execFileImpl(command, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function detectOpenCodeCliVersion({ binPath, env, execFileImpl } = {}) {
  const resolved = resolveUsableOpenCodeBinPath(binPath, env) || resolveCliFromPath("opencode", env);
  const key = versionCacheKey(resolved, env);
  if (versionCache.has(key)) return versionCache.get(key);
  const command = resolved || (binPath ? String(binPath) : "opencode");
  const spec = prepareCommandForSpawn(command, ["--version"], { unwrapNativeExe: false });
  let output = "";
  try {
    const result = await execFileResult(spec.command, spec.args, {
      env: buildSdkAgentEnv({ shellEnv: env || process.env }),
      timeout: OPENCODE_V2_VERSION_PROBE_MS,
      windowsHide: true,
      shell: spec.shell,
      encoding: "utf8",
      maxBuffer: 64 * 1024,
    }, execFileImpl);
    output = `${result.stdout || ""}\n${result.stderr || ""}`;
  } catch (error) {
    output = `${error?.stdout || ""}\n${error?.stderr || ""}`;
  }
  const version = parseOpenCodeVersionOutput(output);
  if (version) versionCache.set(key, version);
  return version;
}

function resetOpenCodeVersionCache() {
  versionCache.clear();
}

async function shouldUseOpenCodeV2(args = {}) {
  if (typeof args.openCodeFactory === "function") return false;
  try {
    const version = typeof args.versionProbe === "function"
      ? await args.versionProbe()
      : await detectOpenCodeCliVersion(args);
    return isOpenCodeV2Version(version);
  } catch {
    return false;
  }
}

function createOpenCodeServeStartupParser() {
  let pending = "";
  let url = null;
  let password = null;

  const applyLine = (line) => {
    const listen = line.match(/^(?:opencode\s+)?server listening on\s+(https?:\/\/\S+)/i);
    if (listen) url = listen[1].replace(/[),.;]+$/, "");
    const pass = line.match(/^server password:?\s+(\S+)/i);
    if (pass) password = pass[1];
  };

  return {
    push(chunk) {
      const text = stripAnsi(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk ?? ""));
      const combined = pending + text;
      const lines = combined.split(/\n/);
      pending = lines.pop() ?? "";
      if (pending.length > 8192) pending = pending.slice(-8192);
      for (const raw of lines) applyLine(raw.replace(/\r$/, "").trim());
      return { url, password, ready: Boolean(url) };
    },
  };
}

function waitForOpenCodeChildReady(child, {
  timeoutMs = OPENCODE_SERVER_START_TIMEOUT_MS,
  passwordGraceMs = OPENCODE_V2_PASSWORD_GRACE_MS,
  signal,
  stop,
} = {}) {
  return new Promise((resolve, reject) => {
    const parser = createOpenCodeServeStartupParser();
    let settled = false;
    let grace = null;
    let url = null;
    let password = null;

    const detach = () => {
      clearTimeout(timer);
      clearTimeout(grace);
      signal?.removeEventListener("abort", onAbort);
      child.stdout?.removeListener?.("data", onData);
      child.stderr?.removeListener?.("data", onData);
      child.removeListener?.("exit", onExit);
      child.removeListener?.("error", onError);
    };
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      detach();
      fn(value);
    };
    const fail = (error) => {
      try { stop?.(child); } catch {}
      finish(reject, error);
    };
    const succeed = () => finish(resolve, { url, password });
    const armGrace = () => {
      if (grace || settled) return;
      grace = setTimeout(succeed, passwordGraceMs);
    };
    const timer = setTimeout(() => fail(openCodeV2UserError("ai.opencode.v2.startupTimeout")), timeoutMs);
    const onData = (chunk) => {
      const next = parser.push(chunk);
      if (next.url) url = next.url;
      if (next.password) password = next.password;
      if (url && password) succeed();
      else if (url) armGrace();
    };
    const onExit = () => fail(openCodeV2UserError("ai.opencode.v2.exited"));
    const onError = (error) => fail(error);
    const onAbort = () => {
      const reason = signal?.reason;
      fail(reason instanceof Error ? reason : new Error("aborted"));
    };

    child.stdout?.on?.("data", onData);
    child.stderr?.on?.("data", onData);
    child.on?.("exit", onExit);
    child.on?.("error", onError);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function buildOpenCodeBasicAuthorization(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function flattenOpenCodePermissionRules(permission) {
  const rules = [];
  for (const [action, value] of Object.entries(permission || {})) {
    if (value === "allow" || value === "deny" || value === "ask") {
      rules.push({ action, resource: "*", effect: value });
      continue;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    for (const [resource, effect] of Object.entries(value)) {
      if (effect === "allow" || effect === "deny" || effect === "ask") {
        rules.push({ action, resource, effect });
      }
    }
  }
  return rules;
}

function buildOpenCodeV2ConfigContent(v1Config = {}) {
  const content = {
    share: typeof v1Config.share === "string" ? v1Config.share : "disabled",
  };
  if (v1Config.autoupdate === false || v1Config.update === "disable") content.update = "disable";
  const permissions = flattenOpenCodePermissionRules(v1Config.permission);
  if (permissions.length) content.permissions = permissions;
  const servers = {};
  for (const [name, cfg] of Object.entries(v1Config.mcp || {})) {
    if (!name || !cfg || !Array.isArray(cfg.command) || cfg.command.length === 0) continue;
    servers[name] = {
      type: "local",
      command: cfg.command,
      environment: cfg.environment && typeof cfg.environment === "object" ? cfg.environment : {},
      disabled: cfg.enabled === false,
    };
  }
  if (Object.keys(servers).length) content.mcp = { servers };
  if (typeof v1Config.model === "string" && parseOpenCodeModel(v1Config.model)) {
    // Root config accepts this qualified string. The expanded object is a
    // different shape and is not required for a selected provider/model.
    content.model = v1Config.model;
  }
  return content;
}

function mergeOpenCodeV2ConfigContent(generated, callerText) {
  let caller = null;
  if (typeof callerText === "string" && callerText.trim()) {
    try {
      const parsed = JSON.parse(callerText);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) caller = parsed;
    } catch {
      caller = null;
    }
  }
  if (!caller) return generated;
  const merged = { ...caller, ...generated };
  // 1.x keys and the server username must not override the 2.x child env.
  for (const key of ["permission", "autoupdate", "username"]) {
    if (!Object.prototype.hasOwnProperty.call(generated, key)) delete merged[key];
  }
  if (caller.mcp && typeof caller.mcp === "object" && generated.mcp && typeof generated.mcp === "object") {
    const callerServers = caller.mcp?.servers && typeof caller.mcp.servers === "object" && !Array.isArray(caller.mcp.servers)
      ? caller.mcp.servers
      : {};
    const generatedServers = generated.mcp.servers && typeof generated.mcp.servers === "object" && !Array.isArray(generated.mcp.servers)
      ? generated.mcp.servers
      : {};
    merged.mcp = {
      ...caller.mcp,
      ...generated.mcp,
      servers: { ...callerServers, ...generatedServers },
    };
  }
  return merged;
}

function sanitizeOpenCodeV2Detail(message) {
  const raw = String(message || "").trim();
  if (!raw || /[\r\n]/.test(raw) || raw.length > 240) return "";
  if (/server password|authorization\s*[:=]|bearer\s+\S+|basic\s+[a-z0-9+/=]{8,}/i.test(raw)) return "";
  if (/<html|<!doctype|node:internal|\bat\s+\S+:\d+:\d+\b/i.test(raw)) return "";
  return raw;
}

function isOpenCodeTransportError(error) {
  const seen = new Set();
  let current = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if (current.name === "AbortError") return false;
    const code = String(current.code || "");
    const message = String(current.message || "").trim();
    if (
      code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "ECONNRESET" || code === "EPIPE" ||
      code === "UND_ERR_SOCKET" || code === "UND_ERR_CONNECT_TIMEOUT" ||
      code === "UND_ERR_HEADERS_TIMEOUT" || code === "UND_ERR_BODY_TIMEOUT"
    ) return true;
    if (/ECONNREFUSED|ENOTFOUND|ECONNRESET|socket hang up/i.test(message)) return true;
    if (OPENCODE_V2_TRANSPORT_MESSAGE.test(message)) return true;
    current = current.cause;
  }
  return false;
}

function formatOpenCodeV2SessionError(error) {
  const safe = sanitizeOpenCodeV2Detail(error?.message || error?.data?.message || "");
  return safe || "ai.opencode.v2.sessionFailed";
}

function toUserFacingOpenCodeV2Error(error) {
  if (isOpenCodeV2UserMessage(error?.message)) {
    return error instanceof Error ? error : openCodeV2UserError(String(error.message));
  }
  // HTTP failures already carry a status. Do not run them through the spawn
  // classifier: a 400 body of "model not found" is not a missing CLI.
  if (Number.isInteger(error?.status)) {
    if (error.status === 401) return openCodeV2UserError("ai.opencode.v2.unauthorized");
    const safe = sanitizeOpenCodeV2Detail(error?.message);
    return openCodeV2UserError(safe || "ai.opencode.v2.unavailable");
  }
  if (classifyOpenCodeSpawnError(error).isSpawnEnoent) return openCodeV2UserError(OPENCODE_V1_NOT_FOUND);
  const message = String(error?.message || "");
  if (isOpenCodeTransportError(error)) return openCodeV2UserError("ai.opencode.v2.unavailable");
  if (/timeout/i.test(message)) return openCodeV2UserError("ai.opencode.v2.startupTimeout");
  const safe = sanitizeOpenCodeV2Detail(message);
  if (safe) return openCodeV2UserError(safe);
  return openCodeV2UserError("ai.opencode.v2.unavailable");
}

function appendQueryValue(params, key, value) {
  if (value === undefined) return;
  if (value === null) {
    params.append(key, "null");
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) appendQueryValue(params, key, item);
    return;
  }
  if (typeof value === "object") {
    for (const [child, item] of Object.entries(value)) appendQueryValue(params, `${key}[${child}]`, item);
    return;
  }
  params.append(key, String(value));
}

function buildOpenCodeV2Url(baseUrl, path, query) {
  const base = String(baseUrl || "").endsWith("/") ? String(baseUrl) : `${baseUrl}/`;
  const url = new URL(String(path || "").replace(/^\//, ""), base);
  if (query) {
    for (const [key, value] of Object.entries(query)) appendQueryValue(url.searchParams, key, value);
  }
  return url;
}

function catalogModelId(model) {
  if (!model || typeof model !== "object") return null;
  const providerID = typeof model.providerID === "string" ? model.providerID : "";
  // `id` is the selectable catalog id. `modelID` is the provider API id and
  // can differ for aliases such as coding-default -> gpt-5.2.
  const catalogID = typeof model.id === "string" ? model.id : "";
  if (providerID && catalogID) {
    return catalogID.startsWith(`${providerID}/`) ? catalogID : `${providerID}/${catalogID}`;
  }
  if (catalogID.includes("/")) return catalogID;
  if (providerID && typeof model.modelID === "string" && model.modelID) return `${providerID}/${model.modelID}`;
  return null;
}

function unwrapData(payload) {
  if (payload && typeof payload === "object" && Object.prototype.hasOwnProperty.call(payload, "data")) {
    return payload.data;
  }
  return payload;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function mapOpenCodeV2Catalog(modelsPayload, providersPayload, defaultPayload) {
  const providers = asArray(unwrapData(providersPayload));
  const names = new Map(providers.filter((provider) => provider && provider.id).map((provider) => [
    provider.id,
    provider.name || provider.id,
  ]));
  const models = [];
  for (const model of asArray(unwrapData(modelsPayload))) {
    if (!model || model.enabled === false) continue;
    const id = catalogModelId(model);
    if (!id) continue;
    const slash = id.indexOf("/");
    const providerId = model.providerID || (slash > 0 ? id.slice(0, slash) : id);
    const modelName = model.name || model.modelID || (slash > 0 ? id.slice(slash + 1) : id);
    models.push({
      id,
      name: `${names.get(providerId) || providerId} ${modelName}`,
    });
  }
  return {
    currentModelId: catalogModelId(unwrapData(defaultPayload)),
    models,
  };
}

function createSseJsonDecoder() {
  let buffer = "";
  return {
    push(chunk) {
      buffer += chunk;
      buffer = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      const events = [];
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = block.split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, ""))
          .join("\n");
        if (data && data !== "[DONE]") {
          try {
            events.push(JSON.parse(data));
          } catch {
            throw openCodeV2UserError("ai.opencode.v2.unavailable");
          }
        }
        boundary = buffer.indexOf("\n\n");
      }
      if (buffer.length > 1024 * 1024) buffer = "";
      return events;
    },
  };
}

async function* iterateSse(response, signal) {
  const reader = response.body?.getReader?.();
  if (!reader) throw openCodeV2UserError("ai.opencode.v2.unavailable");
  const decoder = new TextDecoder();
  const parser = createSseJsonDecoder();
  const cancelReader = () => { try { void reader.cancel().catch(() => {}); } catch {} };
  if (signal?.aborted) cancelReader();
  else signal?.addEventListener("abort", cancelReader, { once: true });
  try {
    while (!signal?.aborted) {
      let next;
      try {
        next = await reader.read();
      } catch (error) {
        if (signal?.aborted || error?.name === "AbortError") return;
        // undici reports a dead server as "terminated" or a closed socket.
        // That text is not a user-facing chat error.
        throw openCodeV2UserError("ai.opencode.v2.sessionFailed");
      }
      if (signal?.aborted) break;
      const text = decoder.decode(next.value || new Uint8Array(), { stream: !next.done });
      for (const event of parser.push(text)) yield event;
      if (next.done) break;
    }
  } finally {
    signal?.removeEventListener("abort", cancelReader);
    try { await reader.cancel(); } catch {}
  }
}

function createOpenCodeV2Client({ baseUrl, username = OPENCODE_V2_USERNAME, password, fetchImpl } = {}) {
  const authorization = buildOpenCodeBasicAuthorization(username, password ?? "");
  const fetchFn = fetchImpl || globalThis.fetch;

  async function request({ method, path, query, body, signal }) {
    const headers = {
      Authorization: authorization,
      Accept: "application/json",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let response;
    try {
      response = await fetchFn(buildOpenCodeV2Url(baseUrl, path, query), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (signal?.aborted || error?.name === "AbortError") throw error;
      throw toUserFacingOpenCodeV2Error(error);
    }
    if (response.status === 401) {
      try { await response.body?.cancel(); } catch {}
      const error = openCodeV2UserError("ai.opencode.v2.unauthorized");
      error.status = 401;
      throw error;
    }
    if (response.status === 204) {
      try { await response.body?.cancel(); } catch {}
      return null;
    }
    let text;
    try {
      text = await response.text();
    } catch (error) {
      if (signal?.aborted || error?.name === "AbortError") throw error;
      throw toUserFacingOpenCodeV2Error(error);
    }
    if (!response.ok) {
      let detail = "";
      if (text && text.length <= 2048) {
        try {
          const payload = JSON.parse(text);
          detail = sanitizeOpenCodeV2Detail(payload?.message || payload?.data?.message || "");
        } catch {}
      }
      const error = openCodeV2UserError(detail || "ai.opencode.v2.unavailable");
      error.status = response.status;
      throw error;
    }
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw openCodeV2UserError("ai.opencode.v2.unavailable");
    }
  }

  return {
    authorization,
    info(signal) {
      return request({ method: "GET", path: "/api/info", signal });
    },
    async listCatalog(signal, directory) {
      const query = directory ? { location: { directory } } : undefined;
      const modelsPayload = await request({ method: "GET", path: "/api/model", query, signal });
      const providersPayload = await request({ method: "GET", path: "/api/provider", query, signal }).catch((error) => {
        if (error?.status === 401) throw error;
        return null;
      });
      const defaultPayload = await request({ method: "GET", path: "/api/model/default", query, signal }).catch((error) => {
        if (error?.status === 401) throw error;
        return null;
      });
      return mapOpenCodeV2Catalog(modelsPayload, providersPayload, defaultPayload);
    },
    async createSession(body, signal) {
      const payload = await request({ method: "POST", path: "/api/session", body, signal });
      return payload?.data || payload;
    },
    prompt(sessionID, body, signal) {
      return request({
        method: "POST",
        path: `/api/session/${encodeURIComponent(sessionID)}/prompt`,
        body,
        signal,
      });
    },
    interrupt(sessionID, signal) {
      return request({
        method: "POST",
        path: `/api/session/${encodeURIComponent(sessionID)}/interrupt`,
        signal,
      });
    },
    switchModel(sessionID, model, signal) {
      return request({
        method: "POST",
        path: `/api/session/${encodeURIComponent(sessionID)}/model`,
        body: { model },
        signal,
      });
    },
    async putInstruction(sessionID, key, value, signal) {
      try {
        await request({
          method: "PUT",
          path: `/api/experimental/session/${encodeURIComponent(sessionID)}/instructions/entries/${encodeURIComponent(key)}`,
          body: { value },
          signal,
        });
        return { ok: true };
      } catch (error) {
        // Missing or rejected instruction routes must not block the user prompt.
        // The published client types this value as JSON, including a string.
        if (error?.status === 400 || error?.status === 404 || error?.status === 405 || error?.status === 413) {
          return { ok: false };
        }
        throw error;
      }
    },
    putMcp(name, config, directory, signal) {
      return request({
        method: "PUT",
        path: `/api/experimental/mcp/${encodeURIComponent(name)}`,
        query: directory ? { location: { directory } } : undefined,
        body: { config },
        signal,
      });
    },
    async openEventStream(signal) {
      const headers = { Authorization: authorization, Accept: "text/event-stream" };
      let response;
      try {
        response = await fetchFn(buildOpenCodeV2Url(baseUrl, "/api/event"), { method: "GET", headers, signal });
      } catch (error) {
        if (signal?.aborted || error?.name === "AbortError") throw error;
        throw toUserFacingOpenCodeV2Error(error);
      }
      if (response.status === 401) {
        try { await response.body?.cancel(); } catch {}
        const error = openCodeV2UserError("ai.opencode.v2.unauthorized");
        error.status = 401;
        throw error;
      }
      if (!response.ok) {
        try { await response.body?.cancel(); } catch {}
        throw openCodeV2UserError("ai.opencode.v2.unavailable");
      }
      const contentType = response.headers.get("content-type") || "";
      if (!contentType.toLowerCase().includes("text/event-stream")) {
        try { await response.body?.cancel(); } catch {}
        throw openCodeV2UserError("ai.opencode.v2.unavailable");
      }
      return (async function* subscribed() {
        yield* iterateSse(response, signal);
      })();
    },
  };
}

function formatOpenCodeV2ToolContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (!part) return "";
    if (typeof part === "string") return part;
    if (part.type === "text") return String(part.text || "");
    if (part.type === "file") return String(part.name || part.uri || "");
    return "";
  }).filter(Boolean).join("\n");
}

function translateOpenCodeV2Event(event, emitter, state = {}) {
  const type = event?.type;
  const data = event?.data && typeof event.data === "object" ? event.data : {};
  if (!type) return { idle: false, error: false, content: false };
  if (data.sessionID && state.sessionID && data.sessionID !== state.sessionID) {
    return { idle: false, error: false, content: false };
  }

  if (type === "session.text.delta" && typeof data.delta === "string" && data.delta.length > 0) {
    emitter.text(data.delta);
    return { idle: false, error: false, content: true };
  }
  if (type === "session.reasoning.delta" && typeof data.delta === "string" && data.delta.length > 0) {
    emitter.reasoning(data.delta);
    state.reasoningOpen = true;
    return { idle: false, error: false, content: true };
  }
  if (type === "session.reasoning.ended") {
    if (state.reasoningOpen) {
      emitter.reasoningEnd?.();
      state.reasoningOpen = false;
    }
    return { idle: false, error: false, content: false };
  }
  if (type === "session.tool.input.started") {
    state.toolNames = state.toolNames || new Map();
    if (data.id) state.toolNames.set(data.id, data.name || "tool");
    return { idle: false, error: false, content: false };
  }
  if (type === "session.tool.called" || type === "session.tool.success" || type === "session.tool.failed") {
    if (state.reasoningOpen) {
      emitter.reasoningEnd?.();
      state.reasoningOpen = false;
    }
    const callId = data.id || "";
    const toolName = state.toolNames?.get(callId) || data.name || "tool";
    state.toolCalls = state.toolCalls || new Set();
    if (!state.toolCalls.has(callId)) {
      state.toolCalls.add(callId);
      emitter.toolCall(toolName, data.input || {}, callId);
    }
    if (type === "session.tool.called") return { idle: false, error: false, content: true };
    state.toolResults = state.toolResults || new Set();
    if (!state.toolResults.has(callId)) {
      state.toolResults.add(callId);
      const output = type === "session.tool.failed"
        ? (sanitizeOpenCodeV2Detail(data.error?.message) || "OpenCode tool failed")
        : formatOpenCodeV2ToolContent(data.content);
      emitter.toolResult(callId, output, toolName);
    }
    return { idle: false, error: false, content: true };
  }
  if (type === "session.execution.failed") {
    emitter.emitError(formatOpenCodeV2SessionError(data.error));
    return { idle: false, error: true, content: false };
  }
  if (type === "session.execution.succeeded" || type === "session.execution.interrupted") {
    if (state.reasoningOpen) {
      emitter.reasoningEnd?.();
      state.reasoningOpen = false;
    }
    return { idle: true, error: false, content: false };
  }
  return { idle: false, error: false, content: false };
}

function stopOpenCodeChild(child) {
  if (!child || stoppingChildren.has(child)) return;
  const exited = child.exitCode != null || child.signalCode != null;
  if (process.platform === "win32" && child.pid) {
    const out = spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    if (!out.error && out.status === 0) {
      stoppingChildren.add(child);
      return;
    }
  }
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, "SIGTERM");
      stoppingChildren.add(child);
      const timer = setTimeout(() => {
        try { process.kill(-child.pid, "SIGKILL"); } catch {}
      }, 2000);
      timer.unref?.();
      return;
    } catch {}
  }
  if (exited) return;
  try { child.kill(); } catch {}
}

async function openOpenCodeV2Server({
  config, cwd, env, binPath, signal, timeout, hostname, port, spawnImpl,
} = {}) {
  const injectedPassword = randomBytes(24).toString("base64url");
  const options = await withOpenCodeServerPort({
    timeout: timeout ?? OPENCODE_SERVER_START_TIMEOUT_MS,
    hostname: hostname || "127.0.0.1",
    signal,
    port,
  });
  const resolved = resolveUsableOpenCodeBinPath(binPath, env) || resolveCliFromPath("opencode", env);
  const command = resolved || (binPath ? String(binPath) : "opencode");
  const args = ["serve", `--hostname=${options.hostname || "127.0.0.1"}`, `--port=${options.port}`];
  const spec = prepareCommandForSpawn(command, args, { unwrapNativeExe: false });
  const childEnv = {
    ...buildSdkAgentEnv({ shellEnv: env || process.env }),
    OPENCODE_CONFIG_CONTENT: JSON.stringify(mergeOpenCodeV2ConfigContent(
      buildOpenCodeV2ConfigContent(config || {}),
      env?.OPENCODE_CONFIG_CONTENT,
    )),
    OPENCODE_SERVER_USERNAME: OPENCODE_V2_USERNAME,
    OPENCODE_SERVER_PASSWORD: injectedPassword,
  };
  const child = (spawnImpl || spawn)(spec.command, spec.args, {
    cwd: cwd || undefined,
    env: childEnv,
    shell: spec.shell,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  try {
    const ready = await waitForOpenCodeChildReady(child, {
      timeoutMs: options.timeout,
      passwordGraceMs: OPENCODE_V2_PASSWORD_GRACE_MS,
      signal,
      stop: stopOpenCodeChild,
    });
    const client = createOpenCodeV2Client({
      baseUrl: ready.url,
      username: OPENCODE_V2_USERNAME,
      password: ready.password || injectedPassword,
    });
    return {
      client,
      server: {
        url: ready.url,
        close: () => stopOpenCodeChild(child),
      },
    };
  } catch (error) {
    stopOpenCodeChild(child);
    throw toUserFacingOpenCodeV2Error(error);
  }
}

function listServerKey(binPath, env) {
  const resolved = resolveUsableOpenCodeBinPath(binPath, env) || binPath || env?.OPENCODE_BIN || "default";
  return [
    resolved,
    env?.HOME,
    env?.USERPROFILE,
    env?.XDG_CONFIG_HOME,
    env?.OPENCODE_CONFIG,
    env?.OPENCODE_CONFIG_DIR,
    env?.OPENCODE_CONFIG_CONTENT,
    env?.PATH,
  ].map((value) => (value == null ? "" : String(value))).join("\0");
}

function disposeOpenCodeV2ListServer(key, entry) {
  const current = listServers.get(key);
  if (current && current !== entry) return;
  listServers.delete(key);
  if (entry?.idle) clearTimeout(entry.idle);
  try { entry?.server?.server?.close?.(); } catch {}
  entry.server = null;
}

function releaseOpenCodeV2ListServer(key) {
  const entry = listServers.get(key);
  if (!entry) return;
  entry.refs = Math.max(0, (entry.refs || 0) - 1);
  if (entry.refs > 0) return;
  if (entry.idle) clearTimeout(entry.idle);
  entry.idle = setTimeout(() => {
    if (listServers.get(key) !== entry || entry.refs > 0) return;
    disposeOpenCodeV2ListServer(key, entry);
  }, OPENCODE_LIST_SERVER_IDLE_MS);
  entry.idle.unref?.();
}

function resetOpenCodeV2ListServerPool() {
  for (const [key, entry] of listServers.entries()) disposeOpenCodeV2ListServer(key, entry);
  listServers.clear();
}

async function acquireOpenCodeV2ListServer(args) {
  const key = listServerKey(args.binPath, args.env);
  let entry = listServers.get(key);
  if (!entry) {
    entry = { refs: 0, server: null, ready: null, idle: null };
    entry.ready = openOpenCodeV2Server({
      config: { autoupdate: false, share: "disabled" },
      env: args.env,
      binPath: args.binPath,
      cwd: args.cwd,
    }).then((server) => {
      entry.server = server;
      return server;
    }).catch((error) => {
      disposeOpenCodeV2ListServer(key, entry);
      throw error;
    });
    listServers.set(key, entry);
  } else if (entry.idle) {
    clearTimeout(entry.idle);
    entry.idle = null;
  }
  entry.refs += 1;
  try {
    return { key, server: await entry.ready };
  } catch (error) {
    entry.refs = Math.max(0, entry.refs - 1);
    if (entry.refs <= 0) disposeOpenCodeV2ListServer(key, entry);
    throw error;
  }
}

function emptyCatalog() {
  return { currentModelId: null, models: [] };
}

function delayForCatalogSettle(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const error = signal.reason instanceof Error ? signal.reason : new Error("aborted");
      if (!error.name) error.name = "AbortError";
      reject(error);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      const error = signal.reason instanceof Error ? signal.reason : new Error("aborted");
      if (!(signal.reason instanceof Error)) error.name = "AbortError";
      reject(error);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function listSettledOpenCodeV2Catalog(client, signal, directory, limits = {}) {
  const maxMs = limits.maxMs ?? OPENCODE_V2_CATALOG_SETTLE_MAX_MS;
  const quietMs = limits.quietMs ?? OPENCODE_V2_CATALOG_SETTLE_QUIET_MS;
  const pollMs = limits.pollMs ?? OPENCODE_V2_CATALOG_SETTLE_POLL_MS;
  if (typeof client.openEventStream !== "function") return client.listCatalog(signal, directory);
  const streamAbort = new AbortController();
  const stopStream = () => streamAbort.abort(signal?.reason);
  if (signal?.aborted) stopStream();
  else signal?.addEventListener("abort", stopStream);
  const updates = { count: 0 };
  let reader = Promise.resolve();
  try {
    let subscription;
    try {
      subscription = await client.openEventStream(streamAbort.signal);
    } catch (error) {
      if (signal?.aborted || error?.name === "AbortError") throw error;
      return client.listCatalog(signal, directory);
    }
    reader = (async () => {
      try {
        for await (const event of subscription) {
          if (event?.type === "model.updated" || event?.type === "provider.updated") updates.count += 1;
        }
      } catch (error) {
        if (streamAbort.signal.aborted || error?.name === "AbortError") return;
        throw error;
      }
    })();
    const started = Date.now();
    // Count updates before the fetch. An event that arrives while the
    // request is in flight belongs to a newer snapshot than this response.
    let seen = updates.count;
    let current = await client.listCatalog(signal, directory);
    let quietAt = updates.count === seen ? Date.now() : null;
    let refetchedAfterDeadline = false;
    while (true) {
      if (updates.count !== seen) {
        // A slow read can consume the whole budget. Still fetch the snapshot
        // that the in-flight update announced before publishing.
        if (Date.now() - started >= maxMs && refetchedAfterDeadline) return current;
        if (Date.now() - started >= maxMs) refetchedAfterDeadline = true;
        seen = updates.count;
        current = await client.listCatalog(signal, directory);
        quietAt = updates.count === seen ? Date.now() : null;
        continue;
      }
      if (Date.now() - started >= maxMs) return current;
      if (quietAt != null && Date.now() - quietAt >= quietMs) return current;
      await delayForCatalogSettle(pollMs, signal);
    }
  } finally {
    stopStream();
    signal?.removeEventListener("abort", stopStream);
    await Promise.race([
      reader.catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 200)),
    ]);
  }
}

async function listOpenCodeV2Models(args = {}) {
  const signal = args.signal || args.abortController?.signal;
  if (signal?.aborted) return emptyCatalog();
  let acquiredKey = null;
  let opened = null;
  try {
    if (typeof args.openCodeV2Factory === "function") {
      opened = await args.openCodeV2Factory({ purpose: "catalog", signal });
    } else {
      const acquired = await acquireOpenCodeV2ListServer(args);
      acquiredKey = acquired.key;
      opened = acquired.server;
    }
    if (signal?.aborted) return emptyCatalog();
    return await listSettledOpenCodeV2Catalog(opened.client, signal, args.cwd, args.catalogSettle);
  } catch (error) {
    if (signal?.aborted || error?.name === "AbortError") return emptyCatalog();
    throw toUserFacingOpenCodeV2Error(error);
  } finally {
    if (acquiredKey) releaseOpenCodeV2ListServer(acquiredKey);
    else try { opened?.server?.close?.(); } catch {}
  }
}

async function runOpenCodeV2Turn({
  prompt, systemPrompt, attachments, cwd, model, injectedMcpServers, toolIntegrationMode,
  skillsPathAllowlist, resumeSessionId, env, binPath, emitter, abortController, openCodeV2Factory, assertSessionValid,
} = {}) {
  const signal = abortController?.signal;
  const config = buildOpenCodeConfig({ model, injectedMcpServers, toolIntegrationMode, skillsPathAllowlist });
  const state = { reasoningOpen: false };
  let opened = null;
  let sessionId = resumeSessionId || null;
  let hasContent = false;
  let failed = false;
  let removeAbortListener = null;
  let removeStreamAbort = null;

  try {
    opened = typeof openCodeV2Factory === "function"
      ? await openCodeV2Factory({ purpose: "turn", config, signal, cwd })
      : await openOpenCodeV2Server({ config, cwd, env, binPath, signal });
    const { client } = opened;
    const parsed = parseOpenCodeModel(model);
    const sessionModel = parsed ? { id: parsed.modelID, providerID: parsed.providerID } : undefined;
    const permissions = flattenOpenCodePermissionRules(config.permission);
    const createBody = { title: "Netcatty OpenCode" };
    if (cwd) createBody.location = { directory: cwd };
    if (sessionModel) createBody.model = sessionModel;
    if (permissions.length) createBody.permissions = permissions;

    if (sessionId && sessionModel) {
      try {
        await client.switchModel(sessionId, sessionModel, signal);
      } catch (error) {
        if (error?.status !== 404) throw error;
        sessionId = null;
      }
    }
    if (!sessionId) {
      const created = await client.createSession(createBody, signal);
      sessionId = created?.id || created?.data?.id || null;
    }
    if (!sessionId) throw openCodeV2UserError("ai.opencode.v2.unavailable");
    state.sessionID = sessionId;
    emitter.sessionId(sessionId);

    if (systemPrompt) {
      assertSessionValid?.();
      const wrote = await client.putInstruction(sessionId, "netcatty", String(systemPrompt), signal);
      if (!wrote.ok && emitter.warning) emitter.warning("opencode-v2-context", "ai.opencode.v2.contextSkipped");
    }
    for (const [name, cfg] of Object.entries(config.mcp || {})) {
      if (!cfg?.command) continue;
      try {
        await client.putMcp(name, {
          type: "local",
          command: cfg.command,
          environment: cfg.environment,
          disabled: cfg.enabled === false,
        }, cwd, signal);
      } catch {
        if (emitter.warning) emitter.warning(`opencode-v2-mcp:${name}`, "ai.opencode.v2.mcpSkipped");
      }
    }

    const streamAbort = new AbortController();
    if (signal?.aborted) streamAbort.abort(signal.reason);
    else if (signal) {
      const stopStream = () => streamAbort.abort(signal.reason);
      signal.addEventListener("abort", stopStream);
      removeStreamAbort = () => signal.removeEventListener("abort", stopStream);
    }
    const abortOpenCode = async () => {
      streamAbort.abort(signal?.reason);
      if (sessionId) {
        try { await client.interrupt(sessionId, signal); } catch {}
      }
      try { opened?.server?.close?.(); } catch {}
    };
    if (signal) {
      const onAbort = () => { void abortOpenCode(); };
      signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener("abort", onAbort);
    }

    const parts = buildOpenCodePromptParts(prompt, attachments);
    const textPart = parts.find((part) => part.type === "text");
    const files = parts.filter((part) => part.type === "file").map((part) => ({
      uri: part.url,
      ...(part.filename ? { name: part.filename } : {}),
    }));
    const promptBody = { text: textPart?.text ?? String(prompt || "") };
    if (files.length) promptBody.files = files;

    let streamError = null;
    let turnSettled = false;
    // The live /api/event stream does not replay. Wait until the server has
    // accepted the subscriber, then start reading, and only then post the prompt.
    const subscription = await client.openEventStream(streamAbort.signal);
    const eventLoop = (async () => {
      try {
        for await (const event of subscription) {
          if (signal?.aborted) break;
          const result = translateOpenCodeV2Event(event, emitter, state);
          if (result.content) hasContent = true;
          if (result.error) {
            failed = true;
            turnSettled = true;
            break;
          }
          if (result.idle) {
            turnSettled = true;
            break;
          }
        }
        if (!turnSettled && !signal?.aborted && !streamAbort.signal.aborted) {
          streamError = openCodeV2UserError("ai.opencode.v2.sessionFailed");
        }
      } catch (error) {
        if (signal?.aborted || streamAbort.signal.aborted || error?.name === "AbortError") return;
        streamError = isOpenCodeV2UserMessage(error?.message)
          ? error
          : openCodeV2UserError("ai.opencode.v2.sessionFailed");
      }
    })();

    try {
      assertSessionValid?.();
      await client.prompt(sessionId, promptBody, signal);
    } catch (error) {
      failed = true;
      // A rejected prompt does not emit a terminal execution event, so the
      // global SSE stream would otherwise stay open and block this turn.
      streamAbort.abort(signal?.reason);
      try { opened?.server?.close?.(); } catch {}
      await eventLoop;
      throw error;
    }
    await eventLoop;
    if (streamError) throw streamError;

    if (signal?.aborted) return { sessionId };
    if (failed) return { sessionId };
    if (!hasContent) {
      emitter.emitError("ai.opencode.v2.empty");
      return { sessionId };
    }
    emitter.emitDone();
    return { sessionId };
  } catch (error) {
    if (signal?.aborted || error?.name === "AbortError") return { sessionId };
    emitter.emitError(toUserFacingOpenCodeV2Error(error).message);
    return { sessionId };
  } finally {
    removeAbortListener?.();
    removeStreamAbort?.();
    try { opened?.server?.close?.(); } catch {}
  }
}

module.exports = {
  OPENCODE_V2_PASSWORD_GRACE_MS,
  buildOpenCodeBasicAuthorization,
  buildOpenCodeV2ConfigContent,
  mergeOpenCodeV2ConfigContent,
  createOpenCodeServeStartupParser,
  createOpenCodeV2Client,
  detectOpenCodeCliVersion,
  flattenOpenCodePermissionRules,
  formatOpenCodeV2SessionError,
  isOpenCodeV2Version,
  listOpenCodeV2Models,
  mapOpenCodeV2Catalog,
  parseOpenCodeVersionOutput,
  resetOpenCodeV2ListServerPool,
  resetOpenCodeVersionCache,
  runOpenCodeV2Turn,
  sanitizeOpenCodeV2Detail,
  shouldUseOpenCodeV2,
  translateOpenCodeV2Event,
  waitForOpenCodeChildReady,
};
