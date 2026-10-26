"use strict";

const { randomUUID } = require("node:crypto");
const { PluginRpcError, RPC_ERRORS } = require("../rpcRouter.cjs");
const { assertPluginJsonValue } = require("../jsonBoundary.cjs");
const fail = (code, message) => new PluginRpcError(RPC_ERRORS[code], message);
const LIMITS = Object.freeze({ chats: 32, perRuntime: 2, turnMs: 60_000, chatMs: 300_000,
  inputBytes: 16_384, outputBytes: 32_768, outputTokens: 2_048, requestsPerMinute: 8,
  reservedTokensPerMinute: 65_536, contexts: 4, chunkBytes: 4_096, events: 8_192, rateOwners: 128 });

function boundedLimits(overrides) {
  return Object.freeze(Object.fromEntries(Object.entries(LIMITS).map(([key, max]) => {
    const value = overrides[key] ?? max;
    if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new TypeError(`Invalid ${key} limit`);
    return [key, value];
  })));
}

function abortable(promise, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

// In-memory, source-isolated handles. No AgentRuntime, tools, chat persistence,
// provider configuration, URLs, credentials or arbitrary system prompts cross it.
class ModelInvocationBroker {
  constructor({ resolveDataOwner, selectModel, contexts, clock = Date.now, limits = {} }) {
    if (typeof resolveDataOwner !== "function" || typeof selectModel !== "function") throw new TypeError("Host adapters required");
    this.resolveDataOwner = resolveDataOwner;
    this.selectModel = selectModel;
    this.contexts = contexts;
    this.clock = clock;
    this.limits = boundedLimits(limits);
    this.chats = new Map();
    this.turns = new Map();
    this.rates = new Map();
    this.closed = false;
    this.contextSubscription = contexts?.onDidInvalidate((handle) => {
      for (const turn of [...this.turns.values()]) {
        if (turn.references.some((reference) => reference.handle === handle)) {
          this.#end(turn, fail("cancelled", "Selected context was revoked"));
        }
      }
    });
  }

  async #binding(context) {
    await context.assertActive();
    const owner = await this.resolveDataOwner(context);
    await context.assertActive();
    if (!owner || (typeof owner !== "object" && typeof owner !== "string")) throw fail("permissionDenied", "Host data owner is unavailable");
    return { owner, runtimeId: context.runtimeId, pluginVersion: context.pluginVersion };
  }

  async #ownedChat(chat, context) {
    const binding = await this.#binding(context);
    if (this.closed || this.chats.get(chat.handle) !== chat
      || chat.owner !== binding.owner || chat.runtimeId !== binding.runtimeId || chat.pluginVersion !== binding.pluginVersion) {
      throw fail("permissionDenied", "Plugin chat is unavailable");
    }
  }

  async #check(chat, context) {
    await this.#ownedChat(chat, context);
    if (!await chat.model.isCurrent()) throw fail("permissionDenied", "Selected model changed");
    const currentOwner = await this.resolveDataOwner(context);
    await context.assertActive();
    if (currentOwner !== chat.owner || this.closed || this.chats.get(chat.handle) !== chat || chat.expiresAt <= this.clock()) {
      throw fail("permissionDenied", "Plugin chat is unavailable");
    }
  }

  #prune() {
    for (const chat of [...this.chats.values()]) if (chat.expiresAt <= this.clock()) this.#close(chat);
    for (const [owner, rate] of this.rates) if (rate.startedAt + 60_000 <= this.clock()) this.rates.delete(owner);
  }

  async open(context) {
    const binding = await this.#binding(context);
    // Host chooses from configured models. Plugin parameters cannot override it.
    const model = await this.selectModel(context);
    await context.assertActive();
    if (!model || typeof model.invoke !== "function" || typeof model.isCurrent !== "function"
      || typeof model.label !== "string" || model.label.length > 160 || !await model.isCurrent()) {
      throw fail("unavailable", "Choose a configured model in the host first");
    }
    await context.assertActive();
    this.#prune();
    if (this.closed || this.chats.size >= this.limits.chats
      || [...this.chats.values()].filter((chat) => chat.runtimeId === context.runtimeId).length >= this.limits.perRuntime) {
      throw fail("resourceExhausted", "Plugin chat limit reached");
    }
    const chat = { ...binding, handle: randomUUID(), model, expiresAt: this.clock() + this.limits.chatMs, turn: null };
    this.chats.set(chat.handle, chat);
    return { chatHandle: chat.handle, model: model.label, expiresAt: chat.expiresAt };
  }

  async start({ chatHandle, prompt, contexts = [] }, context) {
    assertPluginJsonValue({ chatHandle, prompt, contexts }, { maxBytes: this.limits.inputBytes + 2048 });
    if (typeof prompt !== "string" || !prompt.trim() || prompt.includes("\0") || !Array.isArray(contexts)
      || contexts.length > this.limits.contexts || Buffer.byteLength(prompt) > this.limits.inputBytes) {
      throw fail("invalidArgument", "Invalid model input");
    }
    const chat = this.chats.get(chatHandle);
    if (!chat) throw fail("permissionDenied", "Plugin chat is unavailable");
    await this.#check(chat, context);
    if (chat.turn) throw fail("resourceExhausted", "A turn is already active");
    const controller = new AbortController();
    const turn = { handle: randomUUID(), chat, controller, reading: false, bytes: 0, sequence: 0, iterator: null, references: structuredClone(contexts) };
    chat.turn = turn;
    this.turns.set(turn.handle, turn);
    const abort = () => this.#end(turn, fail("cancelled", "Model turn cancelled"));
    context.signal?.addEventListener("abort", abort, { once: true });
    turn.cleanup = () => context.signal?.removeEventListener("abort", abort);
    turn.timer = setTimeout(() => this.#end(turn, fail("deadlineExceeded", "Model turn timed out")), this.limits.turnMs);
    try {
      await this.#guard(turn, context);
      const selected = [];
      let bytes = Buffer.byteLength(prompt);
      for (const reference of contexts) {
        if (!reference || Object.keys(reference).some((key) => !["handle", "version"].includes(key))) throw fail("invalidArgument", "Invalid context reference");
        const result = await abortable(this.contexts.read(reference, { ...context, signal: controller.signal }), controller.signal);
        bytes += Buffer.byteLength(result.text);
        if (bytes > this.limits.inputBytes) throw fail("resourceExhausted", "Model input byte budget exceeded");
        selected.push(result.text);
      }
      await this.#guard(turn, context);
      this.#prune();
      const rate = this.rates.get(chat.owner) ?? { startedAt: this.clock(), count: 0, tokens: 0 };
      // Reserve conservatively using UTF-8 input bytes plus the output cap. Do
      // not refund unknown provider usage after cancellation or disconnect.
      const reserved = bytes + 1_024 + this.limits.outputTokens;
      if ((!this.rates.has(chat.owner) && this.rates.size >= this.limits.rateOwners) || rate.count >= this.limits.requestsPerMinute || rate.tokens + reserved > this.limits.reservedTokensPerMinute) {
        throw fail("resourceExhausted", "Model request/token budget reached");
      }
      rate.count++; rate.tokens += reserved; this.rates.set(chat.owner, rate);
      await this.#guard(turn, context);
      const iterator = await abortable(chat.model.invoke({ prompt, contexts: selected, signal: controller.signal,
        maxOutputTokens: this.limits.outputTokens, maxChunkBytes: this.limits.chunkBytes }), controller.signal);
      await this.#guard(turn, context);
      if (!iterator || typeof iterator.next !== "function") throw fail("internal", "Model adapter failed");
      turn.iterator = iterator;
      return { turnHandle: turn.handle, maxOutputTokens: this.limits.outputTokens, reservedTokens: reserved };
    } catch (error) {
      this.#end(turn, error);
      throw this.#safe(error);
    }
  }

  async #guard(turn, context) {
    turn.controller.signal.throwIfAborted();
    await abortable(this.#check(turn.chat, context), turn.controller.signal);
    for (const reference of turn.references) {
      await abortable(this.contexts.assertCurrent(reference, { ...context, signal: turn.controller.signal }), turn.controller.signal);
    }
    turn.controller.signal.throwIfAborted();
    if (this.turns.get(turn.handle) !== turn || turn.chat.turn !== turn) throw fail("cancelled", "Model turn ended");
  }

  #safe(error) {
    // SDK/provider errors may contain headers, URLs or echoed request content.
    return error instanceof PluginRpcError ? error : fail("unavailable", "Model invocation failed");
  }

  async read(turnHandle, context) {
    const turn = this.turns.get(turnHandle);
    if (!turn) throw fail("permissionDenied", "Model turn is unavailable");
    // Validate owner before mutating/aborting another caller's turn.
    await this.#ownedChat(turn.chat, context);
    if (turn.reading || !turn.iterator) throw fail("resourceExhausted", "A model read is already pending");
    turn.reading = true;
    const abort = () => this.#end(turn, fail("cancelled", "Model read cancelled"));
    context.signal?.addEventListener("abort", abort, { once: true });
    try {
      if (context.signal?.aborted) abort();
      await this.#guard(turn, context);
      if (turn.sequence >= this.limits.events) throw fail("resourceExhausted", "Model event budget exceeded");
      const next = await abortable(turn.iterator.next(), turn.controller.signal);
      await this.#guard(turn, context);
      if (next.done) {
        this.#end(turn);
        return { kind: "end", sequence: turn.sequence++ };
      }
      const event = next.value;
      if (event?.kind === "text" && typeof event.text === "string") {
        const bytes = Buffer.byteLength(event.text);
        if (bytes > this.limits.chunkBytes || turn.bytes + bytes > this.limits.outputBytes) {
          throw fail("resourceExhausted", "Model output byte budget exceeded");
        }
        turn.bytes += bytes;
        return { kind: "text", sequence: turn.sequence++, text: event.text };
      }
      if (event?.kind === "usage") {
        const usage = {};
        for (const key of ["inputTokens", "outputTokens", "totalTokens"]) {
          if (event[key] !== undefined) {
            if (!Number.isSafeInteger(event[key]) || event[key] < 0) throw fail("internal", "Invalid model usage");
            usage[key] = event[key];
          }
        }
        if ((usage.outputTokens ?? 0) > this.limits.outputTokens) throw fail("resourceExhausted", "Model output token budget exceeded");
        return { kind: "usage", sequence: turn.sequence++, ...usage };
      }
      // A model's tool request is data, never host authorization. This phase
      // exposes no execution path, and drops raw tool payloads/reasoning/errors.
      throw fail("permissionDenied", "Model tools and unsupported events are disabled");
    } catch (error) {
      this.#end(turn, error);
      throw this.#safe(error);
    } finally { turn.reading = false; context.signal?.removeEventListener("abort", abort); }
  }

  async stop(turnHandle, context) {
    const turn = this.turns.get(turnHandle);
    if (!turn) return false;
    await this.#ownedChat(turn.chat, context);
    this.#end(turn, fail("cancelled", "Model turn cancelled"));
    return true;
  }

  #end(turn, reason = fail("cancelled", "Model turn ended")) {
    if (this.turns.get(turn.handle) !== turn) return;
    this.turns.delete(turn.handle);
    if (turn.chat.turn === turn) turn.chat.turn = null;
    clearTimeout(turn.timer); turn.cleanup?.(); turn.controller.abort(reason);
    // Never wait for a provider which ignores cancellation. Its late next()
    // result is observed by abortable() and cannot re-enter the output path.
    try { Promise.resolve(turn.iterator?.return?.()).catch(() => {}); } catch {}
    turn.iterator = null;
  }

  #close(chat) {
    if (chat.turn) this.#end(chat.turn);
    this.chats.delete(chat.handle);
  }
  async close(chatHandle, context) {
    const chat = this.chats.get(chatHandle);
    if (!chat) return false;
    await this.#ownedChat(chat, context); this.#close(chat); return true;
  }
  releaseRuntime(runtimeId) {
    for (const chat of [...this.chats.values()]) if (chat.runtimeId === runtimeId) this.#close(chat);
    this.contexts?.releaseRuntime(runtimeId);
  }
  releaseOwner(owner) {
    for (const chat of [...this.chats.values()]) if (chat.owner === owner) this.#close(chat);
    this.contexts?.releaseOwner(owner);
  }
  shutdown() { this.closed = true; for (const chat of [...this.chats.values()]) this.#close(chat); this.rates.clear(); this.contextSubscription?.dispose(); }
}

module.exports = { ModelInvocationBroker, MODEL_INVOCATION_LIMITS: LIMITS };
