"use strict";

/**
 * CodeBuddy V2 Session Manager — @experimental
 *
 * Manages persistent multi-turn sessions using the SDK's unstable_v2 Session
 * API (createSession / resumeSession). Falls back to the legacy query() path
 * when the V2 API is unavailable.
 *
 * Benefits over query()-per-turn:
 * - CLI process stays warm across turns (faster subsequent responses)
 * - True multi-turn context without replaying history
 * - Supports steer (mid-turn追加消息) via session.send()
 */

const {
  buildCodebuddyQueryOptions,
  buildCodebuddyPromptInput,
  buildCodebuddyHooks,
  buildCodebuddyElicitation,
  translateCodebuddyMessage,
  inspectCodebuddyMessageContent,
  codebuddyResultFallbackText,
  classifyCodebuddySpawnError,
} = require("./codebuddyDriver.cjs");

/**
 * Compute a stable fingerprint from option-affecting fields so we can detect
 * when the user changes model, env, permission mode, tools, etc. between turns.
 * Only JSON-serializable fields are included; function-valued fields (hooks,
 * canUseTool, elicitation) are excluded since they are rebuilt every turn.
 */
function computeOptionsFingerprint(sessionOptions) {
  const relevant = {
    cwd: sessionOptions.cwd,
    model: sessionOptions.model,
    env: sessionOptions.env,
    pathToCodebuddyCode: sessionOptions.pathToCodebuddyCode,
    mcpServers: sessionOptions.mcpServers,
    permissionMode: sessionOptions.permissionMode,
    extraArgs: sessionOptions.extraArgs,
    systemPrompt: sessionOptions.systemPrompt,
    tools: sessionOptions.tools,
    disallowedTools: sessionOptions.disallowedTools,
    settingSources: sessionOptions.settingSources,
    maxTurns: sessionOptions.maxTurns,
    agents: sessionOptions.agents,
    thinking: sessionOptions.thinking,
    effort: sessionOptions.effort,
    persistSession: sessionOptions.persistSession,
    hasHooks: Boolean(sessionOptions.hooks),
    hasCanUseTool: typeof sessionOptions.canUseTool === "function",
    hasElicitation: Boolean(sessionOptions.elicitation),
  };
  try {
    return JSON.stringify(relevant);
  } catch {
    return null;
  }
}

function createSessionCallbackState(sessionOptions) {
  const state = {
    elicitation: sessionOptions.elicitation,
    elicitationDelegate: null,
  };
  if (state.elicitation) {
    state.elicitationDelegate = {
      create(request, options) {
        const handler = state.elicitation;
        return handler?.create
          ? handler.create(request, options)
          : Promise.resolve({ action: "cancel" });
      },
      complete(notification) {
        return state.elicitation?.complete?.(notification);
      },
    };
  }
  return state;
}

function refreshSessionCallbacks(entry, sessionOptions) {
  if (sessionOptions.hooks) {
    if (typeof entry.session.setHooks !== "function") return false;
    entry.session.setHooks(sessionOptions.hooks);
  }
  if (typeof sessionOptions.canUseTool === "function") {
    if (typeof entry.session.setCanUseTool !== "function") return false;
    entry.session.setCanUseTool(sessionOptions.canUseTool);
  }
  if (sessionOptions.elicitation) {
    if (!entry.callbackState?.elicitationDelegate) return false;
    entry.callbackState.elicitation = sessionOptions.elicitation;
  }
  return true;
}

class CodebuddySessionManager {
  constructor({ loadSdk } = {}) {
    /** @type {Map<string, {
     *   session: object,
     *   fingerprint: string|null,
     *   callbackState?: ReturnType<typeof createSessionCallbackState>,
     * }>} */
    this.sessions = new Map();
    /** @type {Map<string, { resolve: Function, reject: Function }>} */
    this.elicitationPending = new Map();
    this.loadSdk = loadSdk || (() => import("@tencent-ai/agent-sdk"));
  }

  /**
   * Get an existing session or create/resume one.
   * If the session exists but its option-affecting fields have changed,
   * the stale session is closed and a fresh one is created.
   * @param {object} args
   * @param {string} args.sessionKey  unique key (chatSessionId + backend + binPath)
   * @param {object} args.sessionOptions  SDK SessionOptions
   * @param {string} [args.resumeSessionId]  resume an existing session by ID
   * @returns {Promise<object|null>} session instance or null if V2 unavailable
   */
  async getOrCreateSession({ sessionKey, sessionOptions, resumeSessionId }) {
    const fingerprint = computeOptionsFingerprint(sessionOptions);
    const existing = this.sessions.get(sessionKey);
    if (existing) {
      // Reuse only when serialized options still match, but always refresh
      // turn-scoped callbacks so events target the current request emitter.
      if (fingerprint !== null && existing.fingerprint === fingerprint) {
        try {
          if (refreshSessionCallbacks(existing, sessionOptions)) {
            return existing.session;
          }
        } catch {
          // Recreate below if the installed SDK cannot refresh callbacks.
        }
      }
      // Options changed — close the stale session and create a fresh one.
      try { existing.session.close(); } catch { /* best effort */ }
      this.sessions.delete(sessionKey);
    }

    let sdk;
    try {
      sdk = await this.loadSdk();
    } catch {
      return null;
    }

    const createSession = sdk.unstable_v2_createSession;
    const resumeSession = sdk.unstable_v2_resumeSession;
    if (!createSession || !resumeSession) return null;

    let session;
    try {
      const callbackState = createSessionCallbackState(sessionOptions);
      const sdkSessionOptions = callbackState.elicitationDelegate
        ? { ...sessionOptions, elicitation: callbackState.elicitationDelegate }
        : sessionOptions;
      if (resumeSessionId) {
        session = resumeSession(resumeSessionId, sdkSessionOptions);
      } else {
        session = createSession(sdkSessionOptions);
      }
      // Do not connect before the first send. In resume mode, send() marks the
      // initialization as having a prompt so the SDK does not replay historical
      // messages into the new turn's stream.
      this.sessions.set(sessionKey, { session, fingerprint, callbackState });
      return session;
    } catch {
      // A factory failure can still leave a partially constructed session.
      try { session?.close(); } catch { /* best effort */ }
      // V2 session creation failed — caller should fall back to query().
      return null;
    }
  }

  /**
   * Run a turn using the V2 Session API.
   * Returns { sessionId, usedV2: true } on success, or null to signal fallback.
   */
  async runTurn({
    sessionKey, prompt, attachments, options, emitter,
    sessionOptions, resumeSessionId,
  }) {
    const signal = options.abortController?.signal;
    if (signal?.aborted) {
      emitter.emitDone();
      return { sessionId: null, usedV2: true };
    }

    const session = await this.getOrCreateSession({
      sessionKey, sessionOptions, resumeSessionId,
    });
    if (!session) {
      if (signal?.aborted) {
        emitter.emitDone();
        return { sessionId: null, usedV2: true };
      }
      return null; // signal caller to use query() fallback
    }

    const promptInput = buildCodebuddyPromptInput(prompt, attachments);
    let sessionId = session.sessionId || null;
    let hasContent = false;
    let hasAssistantText = false;
    let hasStreamedText = false;
    let hasStreamedReasoning = false;
    let hasTerminalError = false;
    let resultFallbackText = "";
    let emittedSessionId = null;
    let removeAbortListener = null;

    try {
      // Register before sending so cancellation during connection or send
      // cannot start a prompt without also interrupting the SDK session.
      const interruptSession = () => {
        if (typeof session.interrupt === "function") {
          void Promise.resolve(session.interrupt()).catch((err) => {
            console.debug("[CodeBuddy SDK] session interrupt failed:", err?.message || err);
          });
        }
      };
      if (signal) {
        signal.addEventListener("abort", interruptSession, { once: true });
        removeAbortListener = () => signal.removeEventListener("abort", interruptSession);
        if (signal.aborted) {
          interruptSession();
          emitter.emitDone();
          return { sessionId, usedV2: true };
        }
      }

      try {
        // Send before the initial connection so resumed sessions suppress
        // historical replay and stream only the response to this prompt.
        if (typeof promptInput === "string") {
          await session.send(promptInput);
        } else {
          // Async iterable of UserMessage — send first message.
          for await (const msg of promptInput) {
            await session.send(msg);
          }
        }
      } catch {
        // Initial transport setup happens inside send(). Release any acquired
        // session lock/process before the caller falls back to legacy query().
        this.closeSession(sessionKey);
        if (signal?.aborted) {
          emitter.emitDone();
          return { sessionId, usedV2: true };
        }
        return null;
      }

      if (signal?.aborted) {
        emitter.emitDone();
        return { sessionId, usedV2: true };
      }
      if (sessionId) {
        emitter.sessionId(sessionId);
        emittedSessionId = sessionId;
      }

      // Stream responses.
      for await (const message of session.stream()) {
        if (options.abortController?.signal?.aborted) {
          try { await session.interrupt(); } catch (err) {
            // Best effort — surface for diagnostics without failing the turn.
            console.debug("[CodeBuddy SDK] session interrupt failed:", err?.message || err);
          }
          break;
        }
        if (message?.session_id && message.session_id !== sessionId) {
          sessionId = message.session_id;
        }
        if (sessionId && sessionId !== emittedSessionId) {
          emitter.sessionId(sessionId);
          emittedSessionId = sessionId;
        }
        const contentState = inspectCodebuddyMessageContent(message);
        if (contentState.hasContent) hasContent = true;
        if (contentState.hasText) hasAssistantText = true;
        resultFallbackText ||= codebuddyResultFallbackText(message);
        const translation = translateCodebuddyMessage(
          message,
          emitter,
          {
            skipAssistantText: hasStreamedText,
            skipAssistantReasoning: hasStreamedReasoning,
            skipSessionId: true,
          },
        );
        if (translation?.terminalError) hasTerminalError = true;
        if (contentState.streamedText) hasStreamedText = true;
        if (contentState.streamedReasoning) hasStreamedReasoning = true;
      }

      if (hasTerminalError) {
        return { sessionId, usedV2: true };
      }
      if (!hasAssistantText && resultFallbackText) {
        emitter.text(resultFallbackText);
        hasContent = true;
      }
      if (!hasContent && !options.abortController?.signal?.aborted) {
        emitter.emitError(
          "CodeBuddy returned an empty response. Run `codebuddy` in a terminal to log in, " +
          "or set CODEBUDDY_API_KEY / CODEBUDDY_AUTH_TOKEN.",
        );
        return { sessionId, usedV2: true };
      }
      emitter.emitDone();
      return { sessionId, usedV2: true };
    } catch (error) {
      if (signal?.aborted) {
        emitter.emitDone();
        return { sessionId, usedV2: true };
      }
      // A stream failure means the transport is no longer safe to reuse. Close
      // it now so the next turn can create/resume a fresh V2 session.
      this.closeSession(sessionKey);
      const classified = classifyCodebuddySpawnError(error);
      if (classified.isSpawnEnoent) {
        emitter.emitError(
          "CodeBuddy CLI not found or not runnable. " +
          "Install codebuddy and ensure it's on PATH, or set CODEBUDDY_CODE_PATH.",
        );
      } else {
        emitter.emitError(classified.message || "CodeBuddy turn failed");
      }
      return { sessionId, usedV2: true };
    } finally {
      removeAbortListener?.();
    }
  }

  /**
   * Report mid-turn steer as unsupported for the current V2 Session API.
   */
  async steer() {
    // SDK 0.3.258 Session.send() starts a new turn by resetting the shared
    // message iterator and discarding pending messages. Calling it while
    // runTurn() owns session.stream() can strand that active consumer.
    // Keep this disabled until the SDK exposes a dedicated mid-turn steer API.
    return { status: "unsupported" };
  }

  /**
   * Set model at runtime without rebuilding the session.
   */
  async setModel(sessionKey, model) {
    const entry = this.sessions.get(sessionKey);
    if (!entry) return false;
    try {
      await entry.session.setModel(model);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Close a specific session.
   */
  closeSession(sessionKey) {
    const entry = this.sessions.get(sessionKey);
    if (entry) {
      try { entry.session.close(); } catch { /* best effort */ }
      this.sessions.delete(sessionKey);
    }
  }

  /**
   * Close all sessions for a given chat session prefix.
   * Also cancels pending elicitations scoped to the chat so main-process
   * promises cannot leak when the renderer never responds (chat closed).
   */
  closeForChat(chatSessionId) {
    const prefix = `${String(chatSessionId || "")}\u0000`;
    for (const key of this.sessions.keys()) {
      if (key.startsWith(prefix)) {
        this.closeSession(key);
      }
    }
    this.cancelElicitationsForChat(chatSessionId);
  }

  /**
   * Close all sessions (app shutdown).
   */
  closeAll() {
    for (const key of [...this.sessions.keys()]) {
      this.closeSession(key);
    }
    for (const [elicitationId, pending] of [...this.elicitationPending]) {
      this.elicitationPending.delete(elicitationId);
      try { pending.resolve({ action: "cancel" }); } catch { /* best effort */ }
    }
  }

  /**
   * Cancel pending elicitations belonging to a chat session, resolving each
   * as { action: "cancel" } so waiting create() promises settle.
   */
  cancelElicitationsForChat(chatSessionId) {
    const target = String(chatSessionId || "");
    for (const [elicitationId, pending] of [...this.elicitationPending]) {
      if (String(pending?.chatSessionId || "") !== target) continue;
      this.elicitationPending.delete(elicitationId);
      try { pending.resolve({ action: "cancel" }); } catch { /* best effort */ }
    }
  }

  /**
   * Resolve a pending elicitation response from the renderer.
   */
  resolveElicitation(elicitationId, response) {
    const pending = this.elicitationPending.get(elicitationId);
    if (pending) {
      this.elicitationPending.delete(elicitationId);
      pending.resolve(response);
      return true;
    }
    return false;
  }
}

// Singleton instance shared across the app lifecycle.
const codebuddySessionManager = new CodebuddySessionManager();

module.exports = { CodebuddySessionManager, codebuddySessionManager, computeOptionsFingerprint };
