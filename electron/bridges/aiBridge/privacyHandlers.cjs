"use strict";

const privacyService = require("../../shared/aiPrivacyService.cjs");

function registerPrivacyHandlers({ ipcMain, validateSender, aiPrivacyService = privacyService }) {
  ipcMain.handle("netcatty:ai:privacy:status", (event) => {
    if (!validateSender(event)) return { ok: false, error: "Unauthorized" };
    try {
      return { ok: true, enabled: aiPrivacyService.isEnabled() };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });
  ipcMain.handle("netcatty:ai:privacy:transform", (event, request = {}) => {
    if (!validateSender(event)) return { ok: false, error: "Unauthorized" };
    try {
      if (request.operation !== "redact" && request.operation !== "restore") {
        throw new Error("Invalid AI privacy operation.");
      }
      return {
        ok: true,
        value: aiPrivacyService[request.operation](request.chatSessionId, request.value),
      };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });
  ipcMain.handle("netcatty:ai:privacy:clear", (event, chatSessionId) => {
    if (!validateSender(event)) return { ok: false, error: "Unauthorized" };
    aiPrivacyService.clearSession(chatSessionId);
    return { ok: true };
  });
}

module.exports = { registerPrivacyHandlers };
