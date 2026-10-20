"use strict";

/**
 * Stream emitter: forwards translated SDK events to the renderer over the
 * SDK agent IPC channels consumed by sdkAgentAdapter.ts.
 *
 * Canonical event shapes consumed by sdkAgentAdapter.handleStreamEvent:
 *   { type: 'text-delta', textDelta }
 *   { type: 'reasoning-delta', delta }
 *   { type: 'reasoning-end' }
 *   { type: 'tool-call', toolName, args, toolCallId }
 *   { type: 'tool-result', toolCallId, output, toolName }
 *   { type: 'file-change', itemId, changes, status }
 *   { type: 'web-search', itemId, query, status }
 *   { type: 'plan-update', itemId, items, status }
 *   { type: 'warning', itemId, message }
 *   { type: 'usage', inputTokens, cachedInputTokens, outputTokens, reasoningTokens, totalTokens }
 *   { type: 'status', message }
 *   { type: 'session-id', sessionId }
 *   { type: 'error', error }
 */
function createStreamEmitter({ safeSend, sender, requestId, restoreValue }) {
  const pending = { "text-delta": "", "reasoning-delta": "" };
  const restore = typeof restoreValue === "function" ? restoreValue : (value) => value;
  const streamFields = { "text-delta": "textDelta", "reasoning-delta": "delta" };
  const displayFields = {
    "tool-call": ["args", "input"],
    "tool-result": ["output", "result"],
    "file-change": ["changes"],
    "web-search": ["query"],
    "plan-update": ["items"],
    warning: ["message"],
    status: ["message"],
    error: ["error"],
    hook: ["toolInput", "error", "reason", "message", "title", "compactSummary"],
  };
  const restoreQuestionSchema = (schema) => {
    if (Array.isArray(schema)) return schema.map(restoreQuestionSchema);
    if (!schema || typeof schema !== "object") return schema;
    return Object.fromEntries(Object.entries(schema).map(([key, value]) => [
      key,
      ["title", "description", "enum", "enumNames"].includes(key)
        ? restore(value)
        : restoreQuestionSchema(value),
    ]));
  };
  const sendEvent = (event) => {
    safeSend(sender, "netcatty:ai:sdk-agent:event", { requestId, event });
  };
  // Providers may split a pseudonym anywhere, including between "[" and "N".
  // Only the unfinished suffix is retained; ordinary text streams immediately.
  const restoreDelta = (type, delta, final = false) => {
    const text = pending[type] + String(delta || "");
    let end = text.length;
    if (!final) {
      const start = text.lastIndexOf("[");
      if (start >= 0) {
        const suffix = text.slice(start);
        if ("[NC_".startsWith(suffix)
          || (suffix.startsWith("[NC_") && !suffix.includes("]"))) {
          if (suffix.length > 128) throw new Error("AI privacy could not restore an incomplete response token.");
          end = start;
        }
      }
    }
    pending[type] = text.slice(end);
    return end ? String(restore(text.slice(0, end))) : "";
  };
  const flush = (type) => {
    if (!pending[type]) return;
    const text = restoreDelta(type, "", true);
    if (text) sendEvent({ type, [streamFields[type]]: text });
  };
  const emitEvent = (event) => {
    if (!restoreValue) return sendEvent(event);
    const field = streamFields[event.type];
    if (field) {
      const text = restoreDelta(event.type, event[field]);
      if (text) sendEvent({ ...event, [field]: text });
      return;
    }
    if (event.type === "reasoning-end") flush("reasoning-delta");
    const output = { ...event };
    for (const key of displayFields[event.type] || []) {
      if (output[key] !== undefined) output[key] = restore(output[key]);
    }
    if (event.type === "elicitation-create" && event.request) {
      output.request = { ...event.request };
      if (event.request.message !== undefined) output.request.message = restore(event.request.message);
      if (event.request.requestedSchema) {
        output.request.requestedSchema = restoreQuestionSchema(event.request.requestedSchema);
      }
    }
    sendEvent(output);
  };
  return {
    emitEvent,
    emitDone() {
      if (restoreValue) {
        flush("text-delta");
        flush("reasoning-delta");
      }
      safeSend(sender, "netcatty:ai:sdk-agent:done", { requestId });
    },
    emitError(error) {
      // Errors can follow an aborted partial token. Never emit that suffix, and
      // never let a failed restoration recursively prevent error delivery.
      pending["text-delta"] = "";
      pending["reasoning-delta"] = "";
      let restored;
      try { restored = restore(error); } catch {
        restored = "AI privacy could not restore the response. Start a new conversation.";
      }
      safeSend(sender, "netcatty:ai:sdk-agent:error", { requestId, error: restored });
    },
    text(textDelta) {
      if (textDelta) emitEvent({ type: "text-delta", textDelta });
    },
    reasoning(delta) {
      if (delta) emitEvent({ type: "reasoning-delta", delta });
    },
    reasoningEnd() {
      emitEvent({ type: "reasoning-end" });
    },
    toolCall(toolName, args, toolCallId) {
      emitEvent({ type: "tool-call", toolName: toolName || "unknown", args: args || {}, toolCallId });
    },
    toolResult(toolCallId, output, toolName) {
      emitEvent({ type: "tool-result", toolCallId: toolCallId || "", output, toolName });
    },
    fileChange(itemId, changes, status) {
      emitEvent({ type: "file-change", itemId: itemId || "", changes: changes || [], status });
    },
    webSearch(itemId, query, status) {
      emitEvent({ type: "web-search", itemId: itemId || "", query: query || "", status });
    },
    planUpdate(itemId, items, status) {
      emitEvent({ type: "plan-update", itemId: itemId || "", items: items || [], status });
    },
    warning(itemId, message) {
      if (message) emitEvent({ type: "warning", itemId: itemId || "", message });
    },
    usage(usage) {
      if (usage) emitEvent({ type: "usage", ...usage });
    },
    status(message) {
      if (message) emitEvent({ type: "status", message });
    },
    sessionId(sessionId) {
      if (sessionId) emitEvent({ type: "session-id", sessionId });
    },
  };
}

module.exports = { createStreamEmitter };
