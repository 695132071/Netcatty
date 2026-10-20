"use strict";

const {
  createRedactionSession,
  normalizeRedactionConfig,
} = require("../mcp/externalMcpRedaction.cjs");

const CONFIG_ERROR = "Invalid AI privacy configuration";
const LOADING_ERROR = "AI privacy settings are still loading; try again";
const SESSION_ERROR = "AI privacy session is unavailable or its settings changed; start a new chat";
const SESSION_ID_ERROR = "AI privacy requires a valid chat session";
const LIMIT_ERROR = "AI privacy session limit reached; close a chat and try again";
const VALUE_ERROR = "AI privacy could not safely process this value";
const TOKEN_ERROR = "Unknown AI privacy token; start a new chat";
const VALUE_LIMIT_ERROR = "AI privacy session limit reached; start a new chat";

/**
 * Main-process privacy state. Only the validated policy may be persisted by a
 * caller; alias maps and retired chat identities never leave this closure.
 *
 * checkSession pins the policy even while privacy is disabled. A policy change
 * retires all pinned chats, so switching privacy off cannot leak an old turn.
 * Adapters pass semantic content, not complete SDK/RPC envelopes. Root object
 * keys are control fields and stay intact; nested user-data keys are redacted.
 */
function createAiPrivacyService({ maxSessions = 64, initialized = true } = {}) {
  if (!Number.isSafeInteger(maxSessions) || maxSessions < 1 || maxSessions > 4096
    || typeof initialized !== "boolean") {
    throw new Error(CONFIG_ERROR);
  }
  let config = normalizeRedactionConfig();
  let fingerprint = JSON.stringify(config);
  let invalidConfiguration = false;
  let configurationInitialized = initialized;
  let policyRevision = 0;
  // Only enabled chats allocate secret-bearing maps. Disabled and retired
  // identities retain no content and must not impose a limit on ordinary use.
  const sessions = new Map();
  const disabledSessions = new Set();
  const disabledSession = Object.freeze({ redactor: null });
  const closedSessions = new Set();

  function validateId(chatSessionId) {
    if (typeof chatSessionId !== "string" || !chatSessionId.trim()
      || chatSessionId.length > 512 || chatSessionId.includes("\0")) {
      throw new Error(SESSION_ID_ERROR);
    }
  }

  function retire(chatSessionId) {
    sessions.delete(chatSessionId);
    disabledSessions.delete(chatSessionId);
    // Keep only the ID, never its alias map. Do not evict a retired identity:
    // a late callback must not recreate it, even after a configuration change.
    closedSessions.add(chatSessionId);
  }

  function retireAll() {
    for (const chatSessionId of sessions.keys()) retire(chatSessionId);
    for (const chatSessionId of disabledSessions) retire(chatSessionId);
  }

  function invalidateConfiguration() {
    policyRevision += 1;
    invalidConfiguration = true;
    retireAll();
  }

  function requireValidConfig() {
    if (invalidConfiguration) throw new Error(CONFIG_ERROR);
    if (!configurationInitialized) throw new Error(LOADING_ERROR);
  }

  function configure(input) {
    let next;
    try {
      next = normalizeRedactionConfig(input);
    } catch {
      invalidateConfiguration();
      throw new Error(CONFIG_ERROR);
    }
    const nextFingerprint = JSON.stringify(next);
    if (nextFingerprint !== fingerprint) {
      policyRevision += 1;
      retireAll();
    }
    config = next;
    fingerprint = nextFingerprint;
    invalidConfiguration = false;
    configurationInitialized = true;
    return getConfig();
  }

  // External clients own their maps elsewhere, but delayed effects still need
  // to honor a policy change in main, including a change away and back.
  function createPolicyGuard() {
    requireValidConfig();
    const revision = policyRevision;
    return () => {
      requireValidConfig();
      if (revision !== policyRevision) throw new Error(SESSION_ERROR);
    };
  }

  function getConfig() {
    requireValidConfig();
    return { ...config, cidrs: [...config.cidrs], patterns: [...config.patterns] };
  }

  function isEnabled() {
    requireValidConfig();
    return config.enabled;
  }

  function hasSession(chatSessionId) {
    return configurationInitialized && !invalidConfiguration && !!sessions.get(chatSessionId)?.redactor;
  }

  function getSession(chatSessionId, create = true) {
    requireValidConfig();
    validateId(chatSessionId);
    if (closedSessions.has(chatSessionId)) throw new Error(SESSION_ERROR);
    if (!config.enabled) {
      if (!create && !disabledSessions.has(chatSessionId)) throw new Error(SESSION_ERROR);
      disabledSessions.add(chatSessionId);
      return disabledSession;
    }
    const existing = sessions.get(chatSessionId);
    if (existing) return existing;
    if (!create) throw new Error(SESSION_ERROR);
    if (sessions.size >= maxSessions) throw new Error(LIMIT_ERROR);
    const entry = { redactor: createRedactionSession(config) };
    sessions.set(chatSessionId, entry);
    return entry;
  }

  function checkSession(chatSessionId) {
    return !!getSession(chatSessionId).redactor;
  }

  function transform(operation, chatSessionId, value) {
    const { redactor } = getSession(chatSessionId, operation === "redact");
    if (!redactor) return value;
    try {
      if (operation === "restore") return redactor.restore(value);
      // Also validate aliases in preserved root keys. Do not use this restored
      // value for redaction: whole-string numeric/boolean aliases must keep
      // their token and type when they cross another model boundary.
      redactor.restore(value);
      return redactor.redact(value, { preserveRootKeys: true, acceptExistingTokens: true });
    } catch (error) {
      if (error?.message === "Unknown External MCP redaction token; reconnect the client") {
        throw new Error(TOKEN_ERROR);
      }
      if (error?.message === "External MCP redaction session limit reached; reconnect the client") {
        throw new Error(VALUE_LIMIT_ERROR);
      }
      throw new Error(VALUE_ERROR);
    }
  }

  function clearSession(chatSessionId) {
    validateId(chatSessionId);
    // Tombstone even an unseen ID: a deleted chat may have an in-flight first
    // model call which must not create its initial map after cleanup.
    retire(chatSessionId);
  }

  return Object.freeze({
    configure,
    getConfig,
    createPolicyGuard,
    invalidateConfiguration,
    isEnabled,
    hasSession,
    checkSession,
    redact: (chatSessionId, value) => transform("redact", chatSessionId, value),
    restore: (chatSessionId, value) => transform("restore", chatSessionId, value),
    clearSession,
  });
}

// The persisted policy arrives asynchronously from the renderer. Never treat
// "not loaded yet" as a disabled policy and allow an unprotected first turn.
const aiPrivacyService = createAiPrivacyService({ initialized: false });

module.exports = { ...aiPrivacyService, aiPrivacyService, createAiPrivacyService };
