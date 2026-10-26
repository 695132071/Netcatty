"use strict";

const { createHmac, randomBytes, randomUUID, timingSafeEqual } = require("node:crypto");
const { createDefinitionValidator } = require("./contractValidator.cjs");
const { PluginRpcError, RPC_ERRORS } = require("./rpcRouter.cjs");
const schema = require("./generated/plugin-contract.schema.json");
const LIMITS = schema.$defs.HostInteractionLimits.const;
const HOST_INTERACTION_FEATURE = schema.$defs.HostInteractionFeature.const;
const validateRequest = createDefinitionValidator("HostInteractionRequest");
const validateResponse = createDefinitionValidator("HostInteractionResponse");
const validateResult = createDefinitionValidator("HostInteractionResult");
const validateSingleLineInput = createDefinitionValidator("HostSingleLineInputText");
const PROMPT_CHANNEL = "netcatty:plugins:host-interaction";

function fail(code, message) { return new PluginRpcError(RPC_ERRORS[code], message); }
function assertTextBytes(text) {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > LIMITS.textBytes || text.includes("\0")) {
    throw fail("resourceExhausted", "Host interaction text exceeds its limit");
  }
  return text;
}
function assertInteractionRequest(params) {
  if (!validateRequest(params)) throw fail("invalidArgument", "Host interaction request is invalid");
  if (Buffer.byteLength(JSON.stringify(params)) > LIMITS.requestBytes) {
    throw fail("resourceExhausted", "Host interaction request exceeds its limit");
  }
  if (params.kind === "input") assertTextBytes(params.initialValue ?? "");
  if (params.kind === "clipboard.write") assertTextBytes(params.text);
  if (params.kind === "quickPick" && new Set(params.items.map((item) => item.id)).size !== params.items.length) {
    throw fail("invalidArgument", "Host interaction choice IDs must be unique");
  }
  return Object.freeze(structuredClone(params));
}
function interactionAuthorization(params) {
  const permission = params.kind === "clipboard.read" ? "clipboard.read"
    : params.kind === "clipboard.write" ? "clipboard.write" : "ui.interact";
  return {
    permission,
    resources: [permission.startsWith("clipboard.") ? "clipboard:text" : "*"],
    reason: permission.startsWith("clipboard.") ? "Explicitly share or replace clipboard text" : "Show a host input or choice dialog",
    operationId: `ui:${params.kind}`,
    ...(permission.startsWith("clipboard.") ? { allowedScopes: ["once"] } : {}),
  };
}

class PluginHostInteractionService {
  constructor(options) {
    this.database = options.database;
    this.permissionEngine = options.permissionEngine;
    this.quotaManager = options.quotaManager;
    this.clipboard = options.clipboard;
    this.getWindow = options.getWindow ?? (() => null);
    this.isLocked = options.isLocked ?? (() => true);
    this.clock = options.clock ?? Date.now;
    this.timeoutMs = Math.min(options.timeoutMs ?? LIMITS.timeoutMs, LIMITS.timeoutMs);
    this.key = randomBytes(32);
    this.pending = new Map();
    this.rates = new Map();
    this.admissions = new WeakMap();
    this.admissionGuards = new Map();
    this.admissionRevision = 0;
    this.focusRestoreMs = Math.min(options.focusRestoreMs ?? 1_000, 1_000);
    this.owner = null;
    this.ownerCleanup = null;
    this.closed = false;
    this.revocation = this.permissionEngine.onDidRevoke((event) => this.releasePlugin(event.pluginId));
    this.unsubscribeLock = options.subscribeLock?.((state) => { if (state.locked) this.cancelAll(); });
  }

  registerRpcCapabilities(registry) {
    registry.registerRequest("ui.interact", (params, context) => this.request(params, context), {
      metadata: { capability: "ui", mutating: true },
      validateParams: assertInteractionRequest,
      authorization: (params, context) => {
        const sender = this.#admit(params, context);
        let guard = this.admissionGuards.get(context.runtimeId);
        if (!guard) { guard = { active: true }; this.admissionGuards.set(context.runtimeId, guard); }
        this.admissions.set(params, { sender, runtimeId: context.runtimeId, revision: this.admissionRevision, guard });
        return interactionAuthorization(params);
      },
    });
  }

  setReady(sender, ready) {
    const window = this.getWindow();
    if (!sender || window?.webContents !== sender || sender.isDestroyed?.()) {
      throw fail("permissionDenied", "Host interaction window is not the owner");
    }
    if (typeof ready !== "boolean") throw fail("invalidArgument", "Host interaction readiness is invalid");
    if (!ready) { this.releaseWindow(sender); return true; }
    if (this.closed) throw fail("unavailable", "Host interactions are unavailable");
    if (this.owner === sender) return true;
    if (this.owner) this.releaseWindow(this.owner);
    this.owner = sender;
    const close = () => this.releaseWindow(sender);
    // A native permission dialog can temporarily blur its parent. Already
    // displayed interactions still cancel immediately; pre-prompt admission
    // can only resume once this same owner actually regains focus.
    const blur = () => this.cancelAll(false);
    const hide = () => this.cancelAll();
    const navigate = (details, _url, isInPlace, isMainFrame) => {
      const main = details?.isMainFrame ?? isMainFrame;
      const sameDocument = details?.isSameDocument ?? isInPlace;
      if (main !== false && sameDocument !== true) close();
    };
    sender.once?.("destroyed", close);
    sender.on?.("did-start-navigation", navigate);
    sender.on?.("render-process-gone", close);
    window.on?.("blur", blur);
    window.on?.("hide", hide);
    this.ownerCleanup = () => {
      sender.removeListener?.("destroyed", close);
      sender.removeListener?.("did-start-navigation", navigate);
      sender.removeListener?.("render-process-gone", close);
      window.removeListener?.("blur", blur);
      window.removeListener?.("hide", hide);
    };
    return true;
  }

  #assertWindow(sender = this.owner) {
    const window = this.getWindow();
    if (this.closed || this.isLocked() || !sender || sender !== this.owner
      || window?.webContents !== sender || window.isDestroyed?.()
      || sender.isDestroyed?.() || window.isVisible?.() === false || window.isFocused?.() !== true) {
      throw fail("unavailable", "Host interactions require the focused unlocked main window");
    }
    return sender;
  }

  #token(entry) {
    const nonce = randomBytes(24).toString("base64url");
    const binding = JSON.stringify([
      nonce, entry.id, entry.context.pluginId, entry.context.pluginVersion,
      entry.context.runtimeId, entry.sender.id, entry.params.kind, entry.phase, entry.expiresAt,
    ]);
    return `${nonce}.${createHmac("sha256", this.key).update(binding).digest("base64url")}`;
  }

  #present(entry) {
    entry.actionToken = this.#token(entry);
    entry.sender.send(PROMPT_CHANNEL, {
      requestId: entry.id, actionToken: entry.actionToken,
      pluginId: entry.context.pluginId, pluginVersion: entry.context.pluginVersion,
      expiresAt: entry.expiresAt, phase: entry.phase, request: entry.params,
      ...(entry.previewText === undefined ? {} : { previewText: entry.previewText }),
    });
  }

  #finish(entry, result, error) {
    if (this.pending.get(entry.id) !== entry) return false;
    this.pending.delete(entry.id);
    entry.actionToken = null;
    entry.previewText = undefined;
    clearTimeout(entry.timer);
    entry.context.signal?.removeEventListener("abort", entry.onAbort);
    try { entry.sender.send(PROMPT_CHANNEL, { requestId: entry.id, closed: true }); } catch {}
    if (error) entry.reject(error);
    else if (!validateResult(result)) entry.reject(fail("internal", "Host interaction result is invalid"));
    else entry.resolve(result);
    return true;
  }

  #audit(entry, action) {
    // Fixed metadata only. Never record title, choices, user input, clipboard
    // bytes, action token or a hash derived from user content.
    try {
      this.database.recordSecurityAudit(entry.context.pluginId, "ui.interaction", { kind: entry.params.kind, action });
    } catch {
      throw fail("unavailable", "Host interaction audit is unavailable");
    }
  }

  #admit(params, context) {
    const sender = this.#assertWindow();
    if ((params.kind === "clipboard.read" && typeof this.clipboard?.readText !== "function")
      || (params.kind === "clipboard.write" && typeof this.clipboard?.writeText !== "function")) {
      throw fail("unavailable", "Host clipboard text is unavailable");
    }
    const now = this.clock();
    const rate = this.rates.get(context.runtimeId);
    const nextRate = !rate || now - rate.startedAt >= 60_000 ? { startedAt: now, count: 0 } : rate;
    if (nextRate.count >= LIMITS.requestsPerMinute || this.pending.size >= LIMITS.pendingTotal
      || [...this.pending.values()].some((entry) => entry.context.runtimeId === context.runtimeId || entry.sender === sender)) {
      throw fail("resourceExhausted", "Host interaction limit reached");
    }
    nextRate.count++;
    this.rates.set(context.runtimeId, nextRate);
    this.quotaManager.chargeBytes(context.runtimeId, "ui", Buffer.byteLength(JSON.stringify(params)));
    return sender;
  }

  async request(params, context) {
    await context.assertActive();
    const admission = this.admissions.get(params);
    this.admissions.delete(params);
    let sender;
    if (admission?.runtimeId === context.runtimeId) {
      // Electron may resolve showMessageBox before restoring parent focus.
      // Never focus it ourselves or defer an originally background request.
      // Owner replacement, lock, hide, revoke and runtime stop invalidate this
      // host-owned admission, including changes during the permission prompt.
      const deadline = Date.now() + this.focusRestoreMs;
      for (;;) {
        context.signal?.throwIfAborted();
        if (!admission.guard.active || admission.revision !== this.admissionRevision || admission.sender !== this.owner) {
          throw fail("cancelled", "Host interaction admission was revoked");
        }
        const window = this.getWindow();
        if (this.closed || this.isLocked() || window?.webContents !== admission.sender
          || window.isDestroyed?.() || admission.sender.isDestroyed?.() || window.isVisible?.() === false) {
          throw fail("unavailable", "Host interaction owner is unavailable");
        }
        if (window.isFocused?.() === true) break;
        if (Date.now() >= deadline) throw fail("unavailable", "Host interactions require the focused unlocked main window");
        await new Promise((resolve) => setTimeout(resolve, Math.min(20, Math.max(1, deadline - Date.now()))));
      }
      await context.assertActive();
      if (!admission.guard.active || admission.revision !== this.admissionRevision) throw fail("cancelled", "Host interaction admission was revoked");
      sender = this.#assertWindow(admission.sender);
    } else sender = this.#admit(params, context);
    if (this.pending.size >= LIMITS.pendingTotal || [...this.pending.values()].some((entry) => entry.context.runtimeId === context.runtimeId || entry.sender === sender)) {
      throw fail("resourceExhausted", "Host interaction limit reached");
    }
    const now = this.clock();
    return new Promise((resolve, reject) => {
      const entry = {
        id: randomUUID(), context, params, sender, resolve, reject,
        expiresAt: now + this.timeoutMs, phase: "request", actionToken: null,
      };
      entry.onAbort = () => this.#finish(entry, null, fail("cancelled", "Host interaction was cancelled"));
      entry.timer = setTimeout(() => this.#finish(entry, null, fail("deadlineExceeded", "Host interaction expired")), this.timeoutMs);
      entry.timer.unref?.();
      this.pending.set(entry.id, entry);
      context.signal?.addEventListener("abort", entry.onAbort, { once: true });
      if (context.signal?.aborted) { entry.onAbort(); return; }
      try { this.#present(entry); }
      catch { this.#finish(entry, null, fail("unavailable", "Host interaction window is unavailable")); }
    });
  }

  async respond(sender, response) {
    this.#assertWindow(sender);
    if (!validateResponse(response)) throw fail("invalidArgument", "Host interaction response is invalid");
    const entry = this.pending.get(response.requestId);
    if (!entry || entry.sender !== sender || !entry.actionToken || this.clock() >= entry.expiresAt) return false;
    const expected = Buffer.from(entry.actionToken);
    const supplied = Buffer.from(response.actionToken);
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return false;
    // Consume before the first asynchronous boundary. Duplicate and old-phase
    // replies cannot race the same native action.
    entry.actionToken = null;
    try {
      await entry.context.assertActive();
      this.#assertWindow(sender);
      if (this.pending.get(entry.id) !== entry) return false;
      if (response.action === "cancel") {
        this.#audit(entry, "cancelled");
        return this.#finish(entry, { cancelled: true });
      }
      if (entry.params.kind === "clipboard.read" && entry.phase === "request") {
        if (response.action !== "preview") throw fail("invalidArgument", "Clipboard sharing requires a preview action");
        this.#audit(entry, "preview-confirmed");
        let rawText;
        try { rawText = this.clipboard.readText(); }
        catch { throw fail("unavailable", "Host clipboard text is unavailable"); }
        const text = assertTextBytes(rawText);
        this.quotaManager.chargeBytes(entry.context.runtimeId, "clipboard", Buffer.byteLength(text));
        entry.previewText = text;
        entry.phase = "preview";
        try { this.#present(entry); }
        catch { throw fail("unavailable", "Host interaction window is unavailable"); }
        return true;
      }
      if (response.action !== "submit") throw fail("invalidArgument", "Host interaction action is invalid");
      let value;
      if (entry.params.kind === "input") {
        if (!validateSingleLineInput(response.value)) throw fail("invalidArgument", "Host input must be a single line");
        value = assertTextBytes(response.value);
      }
      else if (entry.params.kind === "quickPick") {
        if (!entry.params.items.some((item) => item.id === response.value)) throw fail("invalidArgument", "Host interaction choice is invalid");
        value = response.value;
      } else if (entry.params.kind === "clipboard.read") value = entry.previewText;
      else value = true;
      this.#audit(entry, entry.params.kind === "clipboard.write" ? "copy-confirmed" : "share-confirmed");
      if (entry.params.kind === "clipboard.write") {
        try { this.clipboard.writeText(entry.params.text); }
        catch { throw fail("unavailable", "Host clipboard write failed"); }
      }
      return this.#finish(entry, { cancelled: false, value });
    } catch (error) {
      this.#finish(entry, null, error);
      throw error;
    }
  }

  releaseWindow(sender) {
    if (this.owner !== sender) return;
    this.admissionRevision++;
    this.owner = null;
    this.ownerCleanup?.(); this.ownerCleanup = null;
    for (const entry of [...this.pending.values()]) {
      if (entry.sender === sender) this.#finish(entry, null, fail("cancelled", "Host interaction window closed"));
    }
  }
  releasePlugin(pluginId) {
    this.admissionRevision++;
    for (const entry of [...this.pending.values()]) {
      if (entry.context.pluginId === pluginId) this.#finish(entry, null, fail("cancelled", "Plugin access was revoked"));
    }
  }
  releaseRuntime(runtimeId) {
    this.cancelRuntimeRequests(runtimeId, "Plugin runtime stopped");
    this.rates.delete(runtimeId);
  }
  cancelRuntimeRequests(runtimeId, reason = "Host command finished") {
    const guard = this.admissionGuards.get(runtimeId);
    if (guard) guard.active = false;
    this.admissionGuards.delete(runtimeId);
    for (const entry of [...this.pending.values()]) {
      if (entry.context.runtimeId === runtimeId) this.#finish(entry, null, fail("cancelled", reason));
    }
  }
  cancelAll(invalidateAdmission = true) {
    if (invalidateAdmission) this.admissionRevision++;
    for (const entry of [...this.pending.values()]) this.#finish(entry, null, fail("cancelled", "Host interaction was cancelled"));
  }
  shutdown() {
    if (this.closed) return;
    this.closed = true;
    if (this.owner) this.releaseWindow(this.owner);
    this.cancelAll(); this.rates.clear(); this.admissionGuards.clear();
    this.revocation.dispose(); this.unsubscribeLock?.();
    this.key.fill(0);
  }
}

module.exports = { HOST_INTERACTION_FEATURE, LIMITS, PROMPT_CHANNEL, PluginHostInteractionService, assertInteractionRequest, interactionAuthorization };
