"use strict";

function createSessionService(ctx = {}) {
  const { invokeSessionAgent, validateClose, beforeClose, afterClose, onClosed } = ctx;

  async function close(params = {}, options = {}) {
    if (!params.sessionId || typeof params.sessionId !== "string") {
      return { ok: false, error: "sessionId is required." };
    }
    if (!options.skipValidation && typeof validateClose === "function") {
      const validation = validateClose(params);
      if (validation && validation.ok === false) return validation;
    }
    if (typeof invokeSessionAgent !== "function") {
      return { ok: false, error: "Session close bridge is unavailable." };
    }

    let result;
    let closed = false;
    try {
      await beforeClose?.(params);
      options.beforeExecute?.();
      result = await invokeSessionAgent("session.close", { sessionId: params.sessionId });
      if (result?.ok !== false) {
        await onClosed?.(params.sessionId);
        closed = true;
      }
      return result;
    } finally {
      await afterClose?.(params, {
        closed,
        notFound: /\bwas not found\b/i.test(result?.error || ""),
        result,
      });
    }
  }

  return {
    close: (params = {}, executionContext = {}) => close(params, {
      beforeExecute: executionContext.beforeExecute,
    }),
    closeTracked: (params = {}) => close(params, { skipValidation: true }),
  };
}

module.exports = { createSessionService };
