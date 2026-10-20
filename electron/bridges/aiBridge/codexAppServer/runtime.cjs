"use strict";

const {
  CodexAppServerConnection,
  buildCodexAppServerKey,
} = require("./connection.cjs");
const {
  parseCodexModelSelection,
  toCodexMcpConfig,
} = require("../sdk/codexDriver.cjs");

const INTERACTION_TIMEOUT_MS = 5 * 60 * 1000;
const INTERRUPT_REQUEST_TIMEOUT_MS = 5_000;
const INTERRUPT_GRACE_MS = 2_000;
const MAX_STREAMED_PREFIX_CHARS = 256 * 1024;
const MAX_TOOL_OUTPUT_CHARS = 1024 * 1024;

function appendStreamState(map, itemId, delta, maxPrefixChars = MAX_STREAMED_PREFIX_CHARS) {
  const text = String(delta || "");
  const previous = map.get(itemId) || { prefix: "", length: 0, truncated: false };
  const remaining = Math.max(0, maxPrefixChars - previous.prefix.length);
  const next = {
    prefix: remaining > 0 ? previous.prefix + text.slice(0, remaining) : previous.prefix,
    length: previous.length + text.length,
    truncated: previous.truncated || text.length > remaining,
  };
  map.set(itemId, next);
  return next;
}

function appendToolOutputState(map, itemId, delta) {
  const text = String(delta || "");
  const previous = map.get(itemId) || { text: "", totalLength: 0, truncated: false };
  const remaining = Math.max(0, MAX_TOOL_OUTPUT_CHARS - previous.text.length);
  const next = {
    text: remaining > 0 ? previous.text + text.slice(0, remaining) : previous.text,
    totalLength: previous.totalLength + text.length,
    truncated: previous.truncated || text.length > remaining,
  };
  map.set(itemId, next);
  return next;
}

function formatBoundedToolOutput(value, totalLength = String(value || "").length) {
  const text = String(value || "");
  if (text.length <= MAX_TOOL_OUTPUT_CHARS && totalLength <= MAX_TOOL_OUTPUT_CHARS) return text;
  const kept = text.slice(0, MAX_TOOL_OUTPUT_CHARS);
  return `${kept}\n[output truncated: ${Math.max(totalLength, text.length)} characters total]`;
}

function resolveCodexPermissionConfig(permissionMode) {
  if (permissionMode === "observer") {
    return {
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: "read-only",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
    };
  }
  if (permissionMode === "auto") {
    return {
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: "danger-full-access",
      sandboxPolicy: { type: "dangerFullAccess" },
    };
  }
  return {
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandbox: "read-only",
    sandboxPolicy: { type: "readOnly", networkAccess: false },
  };
}

function buildThreadConfig(injectedMcpServers) {
  return {
    // Netcatty already applies its Observer/Confirm/Auto policy inside the MCP
    // bridge. Tell Codex not to add a second MCP approval prompt: App Server
    // otherwise routes the stable MCP elicitation request back to this client,
    // and rejecting/omitting that duplicate prompt surfaces as
    // "user rejected MCP tool call" before Netcatty's own gate can run.
    mcp_servers: toCodexMcpConfig(injectedMcpServers, {
      defaultToolsApprovalMode: "approve",
    }),
    model_reasoning_summary: "concise",
  };
}

function normalizeFileChanges(changes) {
  if (!Array.isArray(changes)) return [];
  return changes
    .filter((change) => change && typeof change.path === "string")
    .map((change) => ({
      path: change.path,
      kind: change.kind?.type === "add"
        ? "add"
        : change.kind?.type === "delete"
          ? "delete"
          : "update",
    }));
}

function normalizeGrantedPermissions(requested) {
  const granted = {};
  if (requested?.network != null) granted.network = requested.network;
  if (requested?.fileSystem != null) granted.fileSystem = requested.fileSystem;
  return granted;
}

function stringifyMcpContent(result) {
  if (!result) return "";
  const content = Array.isArray(result.content) ? result.content : [];
  let text = "";
  let totalLength = 0;
  for (const item of content) {
    const rawPart = item && typeof item === "object" && typeof item.text === "string"
      ? item.text
      : typeof item === "string" ? item : JSON.stringify(item);
    const part = typeof rawPart === "string" ? rawPart : "";
    totalLength += part.length;
    if (text.length < MAX_TOOL_OUTPUT_CHARS) {
      text += part.slice(0, MAX_TOOL_OUTPUT_CHARS - text.length);
    }
  }
  if (text || totalLength > 0) return formatBoundedToolOutput(text, totalLength);
  if (result.structuredContent == null) return "";
  return formatBoundedToolOutput(JSON.stringify(result.structuredContent));
}

function buildTurnInput(prompt, attachments) {
  const input = [{ type: "text", text: String(prompt || ""), text_elements: [] }];
  for (const attachment of attachments || []) {
    if (!attachment?.filePath) continue;
    if (!String(attachment.mediaType || "").toLowerCase().startsWith("image/")) continue;
    input.push({ type: "localImage", path: attachment.filePath });
  }
  return input;
}

function getActiveTurnNotSteerableKind(error) {
  const turnKind = error?.data?.activeTurnNotSteerable?.turnKind
    ?? error?.data?.codexErrorInfo?.activeTurnNotSteerable?.turnKind;
  return turnKind === "review" || turnKind === "compact" ? turnKind : null;
}

function mapAppServerModels(rawModels) {
  return (Array.isArray(rawModels) ? rawModels : [])
    .filter((model) => model && model.id && !model.hidden)
    .map((model) => ({
      id: model.id,
      name: model.displayName || model.id,
      description: model.description || undefined,
      thinkingLevels: Array.isArray(model.supportedReasoningEfforts)
        ? model.supportedReasoningEfforts
          .map((option) => option?.reasoningEffort)
          .filter(Boolean)
        : [],
      defaultThinkingLevel: model.defaultReasoningEffort || undefined,
      isDefault: model.isDefault === true,
    }));
}

function resolveAppServerModelSelection(model) {
  if (!model) return null;
  const defaultThinkingLevel = model.defaultThinkingLevel;
  if (
    defaultThinkingLevel
    && Array.isArray(model.thinkingLevels)
    && model.thinkingLevels.includes(defaultThinkingLevel)
  ) {
    return `${model.id}/${defaultThinkingLevel}`;
  }
  return model.id;
}

class CodexAppServerRuntime {
  constructor({
    appVersion = "0.0.0",
    connectionFactory,
    sendInteractionRequest,
    sendInteractionCleared,
    transformUserInputAnswers,
    interruptRequestTimeoutMs = INTERRUPT_REQUEST_TIMEOUT_MS,
    interruptGraceMs = INTERRUPT_GRACE_MS,
  } = {}) {
    this.appVersion = appVersion;
    this.connectionFactory = connectionFactory;
    this.sendInteractionRequest = sendInteractionRequest;
    this.sendInteractionCleared = sendInteractionCleared;
    this.transformUserInputAnswers = transformUserInputAnswers;
    this.interruptRequestTimeoutMs = interruptRequestTimeoutMs;
    this.interruptGraceMs = interruptGraceMs;
    this.connections = new Map();
    this.preferredConnectionKey = null;
    this.activeByRequest = new Map();
    this.activeByThread = new Map();
    this.activeByTurn = new Map();
    this.pendingInteractions = new Map();
    this.interactionCounter = 0;
    this.eventCounter = 0;
  }

  #scopedKey(connectionKey, id) {
    return `${connectionKey}\u0000${String(id || "")}`;
  }

  #getConnection(binPath, env) {
    const connectionKey = buildCodexAppServerKey(binPath, env);
    this.preferredConnectionKey = connectionKey;
    const existing = this.connections.get(connectionKey);
    if (existing) {
      this.#closeIdleConnections(connectionKey);
      return { connection: existing, connectionKey };
    }
    this.#closeIdleConnections(connectionKey);
    const factory = this.connectionFactory || ((options) => new CodexAppServerConnection(options));
    const connection = factory({
      binPath,
      env,
      appVersion: this.appVersion,
      onNotification: (message) => this.#handleNotification(connectionKey, message),
      onServerRequest: (message, source) => this.#handleServerRequest(connectionKey, source, message),
      onFatal: (error) => this.#handleConnectionFatal(connectionKey, error),
    });
    this.connections.set(connectionKey, connection);
    return { connection, connectionKey };
  }

  #closeIdleConnections(keepKey = this.preferredConnectionKey) {
    const activeConnectionKeys = new Set(
      Array.from(this.activeByRequest.values(), (context) => context.connectionKey),
    );
    for (const [connectionKey, connection] of this.connections) {
      if (connectionKey === keepKey || activeConnectionKeys.has(connectionKey)) continue;
      this.connections.delete(connectionKey);
      try { connection.close(); } catch {}
    }
  }

  #refreshPreferredConnectionKey() {
    if (this.preferredConnectionKey && this.connections.has(this.preferredConnectionKey)) return;
    const connectionKeys = Array.from(this.connections.keys());
    this.preferredConnectionKey = connectionKeys.at(-1) || null;
  }

  async runTurn({
    requestId,
    chatSessionId,
    prompt,
    attachments,
    cwd,
    model,
    permissionMode,
    env,
    binPath,
    injectedMcpServers,
    resumeThreadId,
    emitter,
    signal,
    sender,
    assertSessionValid,
  }) {
    const throwIfAborted = () => {
      if (!signal?.aborted) return;
      const error = new Error("Codex App Server turn was interrupted before it started");
      error.name = "AbortError";
      throw error;
    };
    throwIfAborted();
    const { connection, connectionKey } = this.#getConnection(binPath, env);
    await connection.start();
    throwIfAborted();
    const permission = resolveCodexPermissionConfig(permissionMode);
    const selection = parseCodexModelSelection(model);
    const threadParams = {
      model: selection.model || null,
      cwd: cwd || process.cwd(),
      approvalPolicy: permission.approvalPolicy,
      approvalsReviewer: permission.approvalsReviewer,
      sandbox: permission.sandbox,
      config: buildThreadConfig(injectedMcpServers),
    };

    assertSessionValid?.();
    const requestOptions = { beforeSend: assertSessionValid };
    const threadResult = resumeThreadId
      ? await connection.request("thread/resume", { threadId: resumeThreadId, ...threadParams }, undefined, requestOptions)
      : await connection.request("thread/start", threadParams, undefined, requestOptions);
    throwIfAborted();
    const threadId = threadResult?.thread?.id || resumeThreadId;
    if (!threadId) throw new Error("Codex App Server did not return a thread id");
    emitter.sessionId(threadId);

    const context = {
      requestId,
      chatSessionId,
      connection,
      connectionKey,
      threadId,
      turnId: null,
      emitter,
      signal,
      sender,
      assertSessionValid,
      lastError: null,
      settled: false,
      cancelRequested: false,
      interruptPromise: null,
      steerPromise: null,
      reasoningOpen: false,
      streamedTextByItem: new Map(),
      streamedReasoningByItem: new Map(),
      commandOutputByItem: new Map(),
      emittedToolCalls: new Set(),
      emittedToolResults: new Set(),
      forceCancelTimer: null,
      abortListener: null,
    };
    this.activeByRequest.set(requestId, context);
    this.activeByThread.set(this.#scopedKey(connectionKey, threadId), context);

    const completion = new Promise((resolve, reject) => {
      context.resolve = resolve;
      context.reject = reject;
    });
    if (signal) {
      context.abortListener = () => { void this.cancelTurn(requestId); };
      signal.addEventListener("abort", context.abortListener, { once: true });
      if (signal.aborted) context.abortListener();
    }

    try {
      assertSessionValid?.();
      const turnResult = await connection.request("turn/start", {
        threadId,
        input: buildTurnInput(prompt, attachments),
        cwd: cwd || process.cwd(),
        approvalPolicy: permission.approvalPolicy,
        approvalsReviewer: permission.approvalsReviewer,
        sandboxPolicy: permission.sandboxPolicy,
        model: selection.model || null,
        effort: selection.effort || null,
        summary: "concise",
      }, undefined, requestOptions);
      const turnId = turnResult?.turn?.id;
      if (turnId) this.#assignTurnId(context, turnId);
      await completion;
      return { threadId, turnId: context.turnId };
    } finally {
      this.#removeContext(context);
    }
  }

  async listModels({ binPath, env }) {
    const { connection } = this.#getConnection(binPath, env);
    await connection.start();
    const all = [];
    let cursor = null;
    do {
      const response = await connection.request("model/list", {
        cursor,
        limit: 100,
      }, 10_000);
      all.push(...(response?.data || []));
      cursor = response?.nextCursor || null;
    } while (cursor);
    const models = mapAppServerModels(all);
    const defaultModel = models.find((model) => model.isDefault);
    return {
      currentModelId: resolveAppServerModelSelection(defaultModel),
      models,
    };
  }

  async steerTurn(requestId, {
    chatSessionId,
    prompt,
    attachments,
    clientUserMessageId,
  } = {}) {
    const context = this.activeByRequest.get(requestId);
    if (!context || context.settled || context.chatSessionId !== chatSessionId) {
      return { status: "inactive" };
    }
    if (context.cancelRequested || context.signal?.aborted) {
      return { status: "cancelled" };
    }
    if (!context.turnId) {
      return { status: "busy", message: "Codex turn is still starting" };
    }
    if (context.steerPromise) {
      return { status: "busy", message: "A Codex instruction is already being sent" };
    }

    const steerPromise = (async () => {
      try {
        context.assertSessionValid?.();
        const response = await context.connection.request("turn/steer", {
          threadId: context.threadId,
          expectedTurnId: context.turnId,
          input: buildTurnInput(prompt, attachments),
          clientUserMessageId: clientUserMessageId || null,
        }, undefined, { beforeSend: context.assertSessionValid });
        if (context.cancelRequested || context.signal?.aborted || context.settled) {
          return { status: "cancelled" };
        }
        if (response?.turnId && response.turnId !== context.turnId) {
          return {
            status: "failed",
            message: "Codex App Server returned a different turn id while steering",
          };
        }
        return { status: "accepted" };
      } catch (error) {
        const turnKind = getActiveTurnNotSteerableKind(error);
        if (turnKind) {
          return {
            status: "not-steerable",
            turnKind,
            message: error?.message || "The active Codex turn cannot be steered",
          };
        }
        if (context.cancelRequested || context.signal?.aborted || context.settled) {
          return { status: "cancelled" };
        }
        return {
          status: "failed",
          message: error?.message || String(error),
        };
      }
    })();

    context.steerPromise = steerPromise;
    try {
      return await steerPromise;
    } finally {
      if (context.steerPromise === steerPromise) context.steerPromise = null;
    }
  }

  #assignTurnId(context, turnId) {
    if (!turnId || context.turnId === turnId) return;
    if (context.turnId) {
      this.activeByTurn.delete(this.#scopedKey(context.connectionKey, context.turnId));
    }
    context.turnId = turnId;
    this.activeByTurn.set(this.#scopedKey(context.connectionKey, turnId), context);
    if (context.cancelRequested) void this.#interruptAndSchedule(context);
  }

  #interruptContext(context) {
    if (!context.turnId) return Promise.resolve(false);
    if (context.interruptPromise) return context.interruptPromise;
    let timeout;
    const request = Promise.resolve().then(() => context.connection.request("turn/interrupt", {
      threadId: context.threadId,
      turnId: context.turnId,
    }, this.interruptRequestTimeoutMs)).then(() => true).catch(() => false);
    const deadline = new Promise((resolve) => {
      timeout = setTimeout(() => resolve(false), this.interruptRequestTimeoutMs);
      timeout.unref?.();
    });
    context.interruptPromise = Promise.race([request, deadline])
      .finally(() => clearTimeout(timeout));
    return context.interruptPromise;
  }

  #scheduleForcedCancellation(context, delayMs) {
    if (context.settled) return;
    clearTimeout(context.forceCancelTimer);
    context.forceCancelTimer = setTimeout(() => {
      this.#forceCancelContext(context, "Codex App Server did not complete the interrupted turn");
    }, Math.max(0, delayMs));
    context.forceCancelTimer.unref?.();
  }

  async #interruptAndSchedule(context) {
    if (context.settled) return;
    if (!context.turnId) {
      this.#scheduleForcedCancellation(
        context,
        this.interruptRequestTimeoutMs + this.interruptGraceMs,
      );
      return;
    }
    const interrupted = await this.#interruptContext(context);
    if (context.settled) return;
    if (!interrupted) {
      this.#forceCancelContext(context, "Codex App Server could not interrupt the turn");
      return;
    }
    this.#scheduleForcedCancellation(context, this.interruptGraceMs);
  }

  #forceCancelContext(context, reason) {
    if (context.settled) return;
    context.settled = true;
    clearTimeout(context.forceCancelTimer);
    context.forceCancelTimer = null;
    this.#closeReasoning(context);
    this.#clearInteractionsForContext(context, "cancel");
    context.emitter.emitDone();
    context.resolve();

    const connection = this.connections.get(context.connectionKey);
    if (connection === context.connection) {
      this.connections.delete(context.connectionKey);
      try { connection.close(); } catch {}
      this.#refreshPreferredConnectionKey();
    }
    const error = new Error(reason);
    for (const candidate of this.activeByRequest.values()) {
      if (candidate === context || candidate.connectionKey !== context.connectionKey || candidate.settled) continue;
      candidate.settled = true;
      clearTimeout(candidate.forceCancelTimer);
      candidate.forceCancelTimer = null;
      this.#clearInteractionsForContext(candidate, "cancel");
      candidate.reject(error);
    }
  }

  #findContext(connectionKey, params) {
    if (params?.turnId) {
      const byTurn = this.activeByTurn.get(this.#scopedKey(connectionKey, params.turnId));
      if (byTurn) return byTurn;
    }
    if (params?.threadId) {
      return this.activeByThread.get(this.#scopedKey(connectionKey, params.threadId)) || null;
    }
    return null;
  }

  #handleNotification(connectionKey, message) {
    const params = message.params || {};
    const context = this.#findContext(connectionKey, params);
    if (!context) {
      if (message.method === "warning") {
        const contexts = Array.from(this.activeByRequest.values())
          .filter((candidate) => candidate.connectionKey === connectionKey);
        for (const candidate of contexts) {
          candidate.emitter.warning(
            `codex-warning:connection:${++this.eventCounter}`,
            params.message || "Codex warning",
          );
        }
      }
      return;
    }
    const emitter = context.emitter;

    switch (message.method) {
      case "turn/started":
        this.#assignTurnId(context, params.turn?.id);
        return;
      case "item/agentMessage/delta": {
        appendStreamState(context.streamedTextByItem, params.itemId, params.delta);
        emitter.text(params.delta || "");
        return;
      }
      case "item/reasoning/summaryTextDelta": {
        appendStreamState(context.streamedReasoningByItem, params.itemId, params.delta);
        emitter.reasoning(params.delta || "");
        context.reasoningOpen = true;
        return;
      }
      case "item/commandExecution/outputDelta": {
        appendToolOutputState(context.commandOutputByItem, params.itemId, params.delta);
        return;
      }
      case "item/started":
        this.#handleItem(context, params.item, false);
        return;
      case "item/completed":
        this.#handleItem(context, params.item, true);
        return;
      case "turn/plan/updated":
        emitter.planUpdate(
          `codex-plan:${params.turnId}`,
          (params.plan || []).map((item) => ({
            text: item.step || "",
            completed: item.status === "completed",
          })),
          (params.plan || []).every((item) => item.status === "completed") ? "completed" : "running",
        );
        return;
      case "thread/tokenUsage/updated": {
        const usage = params.tokenUsage?.last;
        if (usage) {
          emitter.usage({
            inputTokens: Number(usage.inputTokens) || 0,
            cachedInputTokens: Number(usage.cachedInputTokens) || 0,
            outputTokens: Number(usage.outputTokens) || 0,
            reasoningTokens: Number(usage.reasoningOutputTokens) || 0,
            totalTokens: Number(usage.totalTokens) || 0,
          });
        }
        return;
      }
      case "warning":
        emitter.warning(
          `codex-warning:${params.turnId || context.turnId}:${++this.eventCounter}`,
          params.message || "Codex warning",
        );
        return;
      case "error":
        context.lastError = params.error?.message || "Codex App Server error";
        emitter.warning(
          `codex-error:${params.turnId || context.turnId}:${++this.eventCounter}`,
          params.willRetry ? `${context.lastError} (retrying)` : context.lastError,
        );
        return;
      case "turn/completed":
        this.#completeTurn(context, params.turn);
        return;
      default:
        return;
    }
  }

  #closeReasoning(context) {
    if (!context.reasoningOpen) return;
    context.emitter.reasoningEnd();
    context.reasoningOpen = false;
  }

  #emitToolCallOnce(context, item, name, args) {
    if (!item?.id || context.emittedToolCalls.has(item.id)) return;
    context.emittedToolCalls.add(item.id);
    this.#closeReasoning(context);
    context.emitter.toolCall(name, args || {}, item.id);
  }

  #emitToolResultOnce(context, item, output, name) {
    if (!item?.id || context.emittedToolResults.has(item.id)) return;
    context.emittedToolResults.add(item.id);
    context.emitter.toolResult(item.id, output || "", name);
  }

  #handleItem(context, item, completed) {
    if (!item || typeof item !== "object") return;
    const emitter = context.emitter;
    switch (item.type) {
      case "agentMessage": {
        if (!completed) return;
        this.#closeReasoning(context);
        const streamed = context.streamedTextByItem.get(item.id);
        context.streamedTextByItem.delete(item.id);
        if (item.text && streamed && item.text.startsWith(streamed.prefix)) {
          if (item.text.length > streamed.length) emitter.text(item.text.slice(streamed.length));
        } else if (item.text && !streamed) emitter.text(item.text);
        return;
      }
      case "reasoning": {
        if (!completed) return;
        const finalText = Array.isArray(item.summary) ? item.summary.join("\n") : "";
        const streamed = context.streamedReasoningByItem.get(item.id);
        context.streamedReasoningByItem.delete(item.id);
        if (finalText && streamed && finalText.startsWith(streamed.prefix)) {
          if (finalText.length > streamed.length) emitter.reasoning(finalText.slice(streamed.length));
        } else if (finalText && !streamed) emitter.reasoning(finalText);
        context.reasoningOpen = true;
        this.#closeReasoning(context);
        return;
      }
      case "commandExecution": {
        const toolName = "codex.command";
        this.#emitToolCallOnce(context, item, toolName, { command: item.command, cwd: item.cwd });
        if (completed) {
          const streamedOutput = context.commandOutputByItem.get(item.id);
          context.commandOutputByItem.delete(item.id);
          const output = item.aggregatedOutput == null
            ? formatBoundedToolOutput(
                streamedOutput?.text || "",
                streamedOutput?.totalLength || 0,
              )
            : formatBoundedToolOutput(item.aggregatedOutput);
          const suffix = item.exitCode == null ? "" : `\n[exit code: ${item.exitCode}]`;
          this.#emitToolResultOnce(context, item, `${output}${suffix}`, toolName);
        }
        return;
      }
      case "mcpToolCall": {
        const toolName = `${item.server || "mcp"}.${item.tool || "tool"}`;
        this.#emitToolCallOnce(context, item, toolName, item.arguments || {});
        if (completed) {
          const output = item.error?.message || stringifyMcpContent(item.result);
          this.#emitToolResultOnce(context, item, output, toolName);
        }
        return;
      }
      case "fileChange":
        if (completed) {
          emitter.fileChange(
            item.id,
            normalizeFileChanges(item.changes),
            item.status === "completed" ? "completed" : "failed",
          );
        }
        return;
      case "webSearch":
        emitter.webSearch(item.id, item.query || "", completed ? "completed" : "running");
        return;
      default:
        return;
    }
  }

  #completeTurn(context, turn) {
    if (context.settled) return;
    context.settled = true;
    clearTimeout(context.forceCancelTimer);
    context.forceCancelTimer = null;
    this.#closeReasoning(context);
    this.#clearInteractionsForContext(context, "cancel");
    if (turn?.status === "failed") {
      context.reject(new Error(turn.error?.message || context.lastError || "Codex turn failed"));
      return;
    }
    context.emitter.emitDone();
    context.resolve();
  }

  async #handleServerRequest(connectionKey, connection, message) {
    const params = message.params || {};
    const context = this.#findContext(connectionKey, params);
    const supported = new Map([
      ["item/commandExecution/requestApproval", "command"],
      ["item/fileChange/requestApproval", "file-change"],
      ["item/permissions/requestApproval", "permissions"],
      ["item/tool/requestUserInput", "user-input"],
    ]);
    const kind = supported.get(message.method);
    if (!kind) {
      connection.respondError(message.id, -32601, `Unsupported Codex App Server request: ${message.method}`);
      context?.emitter.warning(
        `codex-unsupported-request:${++this.eventCounter}`,
        `Unsupported Codex request: ${message.method}`,
      );
      return;
    }
    if (!context) {
      connection.respond(message.id, this.#safeInteractionResponse(kind, params, "reject"));
      return;
    }

    const interactionId = `codex_interaction_${++this.interactionCounter}_${Date.now()}`;
    const timeoutMs = kind === "user-input" && Number(params.autoResolutionMs) > 0
      ? Number(params.autoResolutionMs)
      : INTERACTION_TIMEOUT_MS;
    // Hard ceiling from creation — review can cancel the idle timer but must
    // re-arm the absolute remainder (Catty/MCP pattern; never unbounded).
    const absoluteExpiresAt = Date.now() + timeoutMs;
    const armTimer = (ms) => {
      const pending = this.pendingInteractions.get(interactionId);
      if (!pending) return;
      if (pending.timer) {
        clearTimeout(pending.timer);
        pending.timer = null;
      }
      if (ms <= 0) {
        this.#resolveInteraction(
          interactionId,
          kind === "user-input" ? { answers: {} } : { decision: "reject" },
        );
        return;
      }
      pending.timer = setTimeout(() => {
        this.#resolveInteraction(
          interactionId,
          kind === "user-input" ? { answers: {} } : { decision: "reject" },
        );
      }, ms);
    };
    this.pendingInteractions.set(interactionId, {
      interactionId,
      connection,
      rpcId: message.id,
      kind,
      params,
      context,
      timer: null,
      absoluteExpiresAt,
      idleCancelled: false,
    });
    armTimer(timeoutMs);

    const payload = {
      interactionId,
      source: "codex-app-server",
      kind,
      requestId: context.requestId,
      chatSessionId: context.chatSessionId,
      itemId: params.itemId,
      toolName: kind === "command"
        ? "codex.command"
        : kind === "file-change"
          ? "codex.file_change"
          : kind === "permissions"
            ? "codex.permissions"
            : undefined,
      args: kind === "command"
        ? {
            command: params.command,
            cwd: params.cwd,
            reason: params.reason,
            commandActions: params.commandActions,
          }
        : kind === "file-change"
          ? { reason: params.reason, grantRoot: params.grantRoot, itemId: params.itemId }
          : kind === "permissions"
            ? { cwd: params.cwd, reason: params.reason, permissions: params.permissions }
            : undefined,
      availableDecisions: kind === "command" && Array.isArray(params.availableDecisions)
        ? params.availableDecisions
        : undefined,
      questions: kind === "user-input" ? params.questions || [] : undefined,
      autoResolutionMs: kind === "user-input" ? params.autoResolutionMs : undefined,
    };
    let delivered = false;
    try {
      delivered = typeof this.sendInteractionRequest === "function"
        && this.sendInteractionRequest(payload, context) !== false;
    } catch {
      delivered = false;
    }
    if (!delivered) {
      this.#resolveInteraction(interactionId, kind === "user-input" ? { answers: {} } : { decision: "reject" });
    }
  }

  #safeInteractionResponse(kind, params, decision) {
    if (kind === "user-input") return { answers: {} };
    if (kind === "permissions") {
      const granted = decision === "once" || decision === "session"
        ? normalizeGrantedPermissions(params.permissions)
        : {};
      return { permissions: granted, scope: decision === "session" ? "session" : "turn" };
    }
    const mapped = decision === "once"
      ? "accept"
      : decision === "session"
        ? "acceptForSession"
        : decision === "cancel"
          ? "cancel"
          : "decline";
    return { decision: mapped };
  }

  #resolveInteraction(interactionId, response) {
    const pending = this.pendingInteractions.get(interactionId);
    if (!pending) return false;
    this.pendingInteractions.delete(interactionId);
    clearTimeout(pending.timer);
    try {
      const result = pending.kind === "user-input"
        ? { answers: response?.answers || {} }
        : this.#safeInteractionResponse(pending.kind, pending.params, response?.decision || "reject");
      try { pending.connection.respond(pending.rpcId, result); } catch {}
    } finally {
      this.sendInteractionCleared?.({
        interactionIds: [interactionId],
        chatSessionId: pending.context.chatSessionId,
      }, pending.context);
    }
    return true;
  }

  respondInteraction(interactionId, response, sender) {
    const pending = this.pendingInteractions.get(interactionId);
    if (sender && pending?.context?.sender && pending.context.sender !== sender) return false;
    const safeResponse = pending?.kind === "user-input" && this.transformUserInputAnswers
      ? {
          ...response,
          answers: this.transformUserInputAnswers(response?.answers || {}, pending.context),
        }
      : response;
    return this.#resolveInteraction(interactionId, safeResponse);
  }

  /**
   * Drop the idle auto-reject timer after the user starts reviewing an approval card.
   * Re-arms the absolute creation deadline so a late approve cannot outlive the
   * original timeout window (matches Catty/MCP approval cancel semantics).
   */
  cancelInteractionTimeout(interactionId, sender) {
    const pending = this.pendingInteractions.get(interactionId);
    if (!pending || pending.idleCancelled) return false;
    if (sender && pending.context?.sender && pending.context.sender !== sender) return false;
    pending.idleCancelled = true;
    if (pending.timer) {
      clearTimeout(pending.timer);
      pending.timer = null;
    }
    const remainingMs = Math.max(0, (pending.absoluteExpiresAt ?? 0) - Date.now());
    if (remainingMs <= 0) {
      this.#resolveInteraction(
        interactionId,
        pending.kind === "user-input" ? { answers: {} } : { decision: "reject" },
      );
      return true;
    }
    pending.timer = setTimeout(() => {
      this.#resolveInteraction(
        interactionId,
        pending.kind === "user-input" ? { answers: {} } : { decision: "reject" },
      );
    }, remainingMs);
    return true;
  }

  #clearInteractionsForContext(context, decision) {
    for (const [interactionId, pending] of Array.from(this.pendingInteractions)) {
      if (pending.context === context) {
        this.#resolveInteraction(
          interactionId,
          pending.kind === "user-input" ? { answers: {} } : { decision },
        );
      }
    }
  }

  async cancelTurn(requestId) {
    const context = this.activeByRequest.get(requestId);
    if (!context) return false;
    context.cancelRequested = true;
    this.#clearInteractionsForContext(context, "cancel");
    await this.#interruptAndSchedule(context);
    return true;
  }

  async cleanupChatSession(chatSessionId) {
    const contexts = Array.from(this.activeByRequest.values())
      .filter((context) => context.chatSessionId === chatSessionId);
    await Promise.all(contexts.map((context) => this.cancelTurn(context.requestId)));
  }

  #handleConnectionFatal(connectionKey, error) {
    const connection = this.connections.get(connectionKey);
    if (connection) {
      this.connections.delete(connectionKey);
      this.#refreshPreferredConnectionKey();
    }
    const contexts = Array.from(this.activeByRequest.values())
      .filter((context) => context.connectionKey === connectionKey);
    for (const context of contexts) {
      if (context.settled) continue;
      context.settled = true;
      clearTimeout(context.forceCancelTimer);
      context.forceCancelTimer = null;
      this.#clearInteractionsForContext(context, "cancel");
      context.reject(error);
    }
  }

  #removeContext(context) {
    clearTimeout(context.forceCancelTimer);
    context.forceCancelTimer = null;
    if (context.abortListener && context.signal) {
      context.signal.removeEventListener("abort", context.abortListener);
      context.abortListener = null;
    }
    this.activeByRequest.delete(context.requestId);
    this.activeByThread.delete(this.#scopedKey(context.connectionKey, context.threadId));
    if (context.turnId) this.activeByTurn.delete(this.#scopedKey(context.connectionKey, context.turnId));
    this.#closeIdleConnections();
  }

  close() {
    for (const interactionId of Array.from(this.pendingInteractions.keys())) {
      this.#resolveInteraction(interactionId, { decision: "cancel", answers: {} });
    }
    for (const [, connection] of this.connections) connection.close();
    this.connections.clear();
    this.preferredConnectionKey = null;
    for (const context of this.activeByRequest.values()) {
      if (!context.settled) {
        context.settled = true;
        clearTimeout(context.forceCancelTimer);
        context.forceCancelTimer = null;
        context.reject(new Error("Codex App Server shut down"));
      }
    }
    this.activeByRequest.clear();
    this.activeByThread.clear();
    this.activeByTurn.clear();
  }
}

module.exports = {
  CodexAppServerRuntime,
  INTERACTION_TIMEOUT_MS,
  buildThreadConfig,
  buildTurnInput,
  getActiveTurnNotSteerableKind,
  mapAppServerModels,
  normalizeFileChanges,
  normalizeGrantedPermissions,
  resolveAppServerModelSelection,
  resolveCodexPermissionConfig,
  stringifyMcpContent,
};
