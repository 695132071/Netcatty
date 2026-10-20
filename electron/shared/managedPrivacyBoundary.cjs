"use strict";

/** Managed MCP and Skills CLI share their chat's prompt mapping in the main process. */
function createManagedPrivacyBoundary(dispatch, privacyService) {
  return async (method, params) => {
    const chatSessionId = params?.chatSessionId;
    if (!chatSessionId) {
      if (privacyService.isEnabled()) {
        throw new Error("AI privacy requires a managed chat session.");
      }
      return dispatch(method, params, { beforeExecute: () => {
        if (privacyService.isEnabled()) throw new Error("AI privacy requires a managed chat session.");
      } });
    }
    const enabled = privacyService.checkSession(chatSessionId);
    const restored = enabled ? privacyService.restore(chatSessionId, params) : params;
    let result;
    try {
      result = await dispatch(method, restored, {
        beforeExecute: () => privacyService.checkSession(chatSessionId),
      });
    } catch (error) {
      privacyService.checkSession(chatSessionId);
      if (!enabled) throw error;
      throw new Error(privacyService.redact(chatSessionId, String(error?.message || "Netcatty tool failed.")));
    }
    privacyService.checkSession(chatSessionId);
    if (enabled && method === "netcatty/readAttachment" && typeof result?.text === "string") {
      const { base64Data: _encoded, ...textPayload } = result;
      result = textPayload;
    }
    return enabled ? privacyService.redact(chatSessionId, result) : result;
  };
}

module.exports = { createManagedPrivacyBoundary };
