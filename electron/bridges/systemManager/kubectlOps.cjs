"use strict";

const {
  buildKubectlContextsCommand,
  buildKubectlDeletePodCommand,
  buildKubectlNamespacesCommand,
  buildKubectlPodsCommand,
  isKubectlUnreachableError,
  parseKubeconfigContexts,
  parseKubectlPodList,
  parseNamespaceList,
} = require("../../../domain/systemManager/containerRuntime.shared.cjs");

function isSuccessfulCommandResult(result) {
  return result?.success && (result.code === 0 || result.code === null || result.code === undefined);
}

function commandError(result, fallback) {
  return (result?.stderr || result?.error || "").trim() || fallback;
}

function failureResult(result, fallback) {
  const raw = commandError(result, fallback);
  if (isKubectlUnreachableError(raw)) {
    console.error(`[netcatty] kubectl: ${raw}`);
    return { success: false, errorCode: "clusterUnreachable" };
  }
  return { success: false, error: raw };
}

function backgroundShell(sessionId, isLocalSession, nodeProcess) {
  if (
    typeof isLocalSession === "function"
    && isLocalSession(sessionId)
    && nodeProcess.platform === "win32"
  ) {
    return "powershell";
  }
  return "posix";
}

function createKubectlOpsApi({ execOnSession, isLocalSession, process: nodeProcess = process }) {
  async function run(event, payload) {
    const sessionId = payload?.sessionId;
    const op = payload?.op;
    if (!sessionId || !op) return { success: false, error: "Missing params" };

    if (op === "contexts") {
      const result = await execOnSession(event, sessionId, buildKubectlContextsCommand(), 10000);
      if (!isSuccessfulCommandResult(result)) {
        return failureResult(result, "kubectl exited");
      }
      try {
        const parsed = parseKubeconfigContexts(result.stdout);
        return { success: true, contexts: parsed.contexts, current: parsed.current };
      } catch {
        return { success: false, error: "Failed to parse Kubernetes contexts" };
      }
    }

    const shell = backgroundShell(sessionId, isLocalSession, nodeProcess);

    if (op === "namespaces") {
      const command = buildKubectlNamespacesCommand(payload.context, shell);
      if (!command) return { success: false, error: "Invalid context" };
      const result = await execOnSession(event, sessionId, command, 12000);
      if (!isSuccessfulCommandResult(result)) {
        return failureResult(result, "kubectl exited");
      }
      try {
        return { success: true, namespaces: parseNamespaceList(result.stdout) };
      } catch {
        return { success: false, error: "Failed to parse Kubernetes namespaces" };
      }
    }

    if (op === "pods") {
      const command = buildKubectlPodsCommand(payload.context, payload.namespace, shell);
      if (!command) return { success: false, error: "Invalid context or namespace" };
      const result = await execOnSession(event, sessionId, command, 15000);
      if (!isSuccessfulCommandResult(result)) {
        return failureResult(result, "kubectl exited");
      }
      try {
        return { success: true, pods: parseKubectlPodList(result.stdout) };
      } catch {
        return { success: false, error: "Failed to parse Kubernetes pods" };
      }
    }

    if (op === "delete") {
      const command = buildKubectlDeletePodCommand(payload.context, payload.namespace, payload.pod, shell);
      if (!command) return { success: false, error: "Invalid pod" };
      const result = await execOnSession(event, sessionId, command, 20000);
      if (!isSuccessfulCommandResult(result)) {
        return failureResult(result, "kubectl delete failed");
      }
      return { success: true };
    }

    return { success: false, error: `Invalid kubectl op: ${op}` };
  }

  return { run };
}

module.exports = { createKubectlOpsApi };
