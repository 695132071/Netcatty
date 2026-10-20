"use strict";

const CONTAINER_RUNTIMES = ["docker", "podman", "nerdctl"];
const SOURCE_ORDER = ["docker", "podman", "nerdctl", "kubernetes"];

const CLEAR_STARTUP_OUTPUT = "printf '\\033[H\\033[2J\\033[3J';";
const NETCATTY_POPUP_HISTORY_MARKER = "__NC_POPUP__";

function popupHistoryPrefix(shell) {
  if (shell === "powershell") return `$__nc_popup='${NETCATTY_POPUP_HISTORY_MARKER}'; `;
  if (shell === "cmd") return `set "${NETCATTY_POPUP_HISTORY_MARKER}=1"& `;
  return "";
}

function shQuote(str) {
  return `'${String(str).replace(/'/g, "'\"'\"'")}'`;
}

function normalizeContainerRuntime(runtime) {
  return CONTAINER_RUNTIMES.includes(runtime) ? runtime : "docker";
}

function isContainerSource(value) {
  return SOURCE_ORDER.includes(value);
}

function runtimeBinary(runtime) {
  return normalizeContainerRuntime(runtime);
}

function buildRuntimeCommand(runtime, args) {
  return `${runtimeBinary(runtime)} ${String(args || "")}`.trim();
}

function parseRuntimeProbe(stdout) {
  const text = stdout || "";
  const hasFlag = (name) => new RegExp(`(?:^|\\r?\\n)${name}=1(?:\\r?\\n|$)`).test(text);
  return {
    docker: hasFlag("__NC_DOCKER__"),
    podman: hasFlag("__NC_PODMAN__"),
    nerdctl: hasFlag("__NC_NERDCTL__"),
    kubernetes: hasFlag("__NC_KUBECTL__"),
  };
}

function sourcesFromCapabilities(capabilities) {
  if (!capabilities) return [];
  const present = {
    docker: capabilities.hasDocker === true || capabilities.docker === true,
    podman: capabilities.hasPodman === true || capabilities.podman === true,
    nerdctl: capabilities.hasNerdctl === true || capabilities.nerdctl === true,
    kubernetes: capabilities.hasKubectl === true || capabilities.kubernetes === true,
  };
  return SOURCE_ORDER.filter((id) => present[id]);
}

function pickContainerSource(detected, current, remembered) {
  const available = SOURCE_ORDER.filter((id) => Array.isArray(detected) && detected.includes(id));
  if (current && available.includes(current)) return current;
  if (remembered && available.includes(remembered)) return remembered;
  return available[0] || null;
}

function rememberedContainerSource(preference, detected) {
  const source = preference?.source;
  if (!isContainerSource(source)) return null;
  const available = Array.isArray(detected) ? detected : [];
  if (source === "kubernetes" && !available.includes("kubernetes") && CONTAINER_RUNTIMES.includes(preference?.engine)) {
    return preference.engine;
  }
  return source;
}

function reconcileContainerSource(detected, current, preference) {
  const available = SOURCE_ORDER.filter((id) => Array.isArray(detected) && detected.includes(id));
  const preferred = rememberedContainerSource(preference, available);
  if (preferred && available.includes(preferred)) return preferred;
  return pickContainerSource(available, current, preferred);
}

function isAutomaticRuntimeFallback(preference, source, detected) {
  if (!preference?.source || !isContainerSource(source) || preference.source === source) return false;
  const available = Array.isArray(detected) ? detected : [];
  if (available.includes(preference.source)) return false;
  const automatic = pickContainerSource(
    available,
    null,
    rememberedContainerSource(preference, available),
  );
  return source === automatic;
}

function firstContainerRuntime(detected) {
  return CONTAINER_RUNTIMES.find((id) => Array.isArray(detected) && detected.includes(id)) || null;
}

function socketNeedles(runtime) {
  if (runtime === "podman") {
    return ["podman.sock", "/run/podman", "podman daemon"];
  }
  if (runtime === "nerdctl") {
    return ["containerd.sock", "/run/containerd"];
  }
  return ["docker daemon", "docker.sock", "/var/run/docker.sock", "connect to the docker daemon"];
}

function isRuntimeSocketPermissionError(runtime, result) {
  const text = `${result?.stderr || ""}\n${result?.stdout || ""}\n${result?.error || ""}`.toLowerCase();
  if (!text.includes("permission denied")) return false;
  return socketNeedles(normalizeContainerRuntime(runtime)).some((needle) => text.includes(needle));
}

function socketCasePatterns(runtime) {
  if (runtime === "podman") {
    return [
      "*permission\\ denied*podman.sock*",
      "*podman.sock*permission\\ denied*",
      "*permission\\ denied*/run/podman*",
      "*/run/podman*permission\\ denied*",
      "*permission\\ denied*podman\\ daemon*",
      "*podman\\ daemon*permission\\ denied*",
    ];
  }
  if (runtime === "nerdctl") {
    return [
      "*permission\\ denied*containerd.sock*",
      "*containerd.sock*permission\\ denied*",
      "*permission\\ denied*/run/containerd*",
      "*/run/containerd*permission\\ denied*",
    ];
  }
  return [
    "*permission\\ denied*docker\\ daemon*",
    "*docker\\ daemon*permission\\ denied*",
    "*permission\\ denied*docker.sock*",
    "*docker.sock*permission\\ denied*",
    "*permission\\ denied*/var/run/docker.sock*",
    "*/var/run/docker.sock*permission\\ denied*",
    "*permission\\ denied*connect\\ to\\ the\\ docker\\ daemon*",
    "*connect\\ to\\ the\\ docker\\ daemon*permission\\ denied*",
  ];
}

function sanitizeContainerId(id) {
  return String(id || "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 64);
}

function containerInteractiveArgs(containerId, shell) {
  if (shell === "cmd") {
    return `exec -it ${containerId} sh -c "command -v bash >/dev/null 2>&1 && exec bash || exec sh"`;
  }
  return `exec -it ${containerId} sh -c 'command -v bash >/dev/null 2>&1 && exec bash || exec sh'`;
}

function buildContainerCommandWithSudoFallback(runtime, containerId, cliArgs, shell) {
  const popupShell = normalizePopupShell(shell);
  const bin = runtimeBinary(runtime);
  const plainCommand = `${bin} ${cliArgs}`;
  if (popupShell === "powershell") {
    return `${popupHistoryPrefix(popupShell)}${bin} inspect ${containerId} >$null; if ($LASTEXITCODE -eq 0) { ${plainCommand} } else { exit $LASTEXITCODE }`;
  }
  if (popupShell === "cmd") {
    return `${popupHistoryPrefix(popupShell)}${bin} inspect ${containerId} >nul && ${plainCommand}`;
  }
  const sudoCommand = `sudo ${plainCommand}`;
  const script = [
    CLEAR_STARTUP_OUTPUT,
    `_nc_rt_err=$(${bin} inspect ${containerId} 2>&1 >/dev/null);`,
    "_nc_rt_status=$?;",
    `if [ "$_nc_rt_status" -eq 0 ]; then exec ${plainCommand}; fi;`,
    "_nc_rt_lc=$(printf '%s' \"$_nc_rt_err\" | tr '[:upper:]' '[:lower:]');",
    "case \"$_nc_rt_lc\" in",
    `${socketCasePatterns(normalizeContainerRuntime(runtime)).join("|")}) exec ${sudoCommand} ;;`,
    "*) printf '%s\\n' \"$_nc_rt_err\" >&2; exit \"$_nc_rt_status\" ;;",
    "esac",
  ].join(" ");
  return `sh -c ${shQuote(script)}`;
}

function buildContainerExecShellCommand(runtime, containerId, shell) {
  const safeId = sanitizeContainerId(containerId);
  if (!safeId) return 'echo "Invalid container id"';
  return buildContainerCommandWithSudoFallback(
    runtime,
    safeId,
    containerInteractiveArgs(safeId, normalizePopupShell(shell)),
    shell,
  );
}

function buildContainerLogsCommand(runtime, containerId, shell) {
  const safeId = sanitizeContainerId(containerId);
  if (!safeId) return 'echo "Invalid container id"';
  return buildContainerCommandWithSudoFallback(runtime, safeId, `logs -f --tail 200 ${safeId}`, shell);
}

function hasControlChar(text) {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function isSafeShellArg(value, shell) {
  const text = String(value ?? "");
  if (!text || text.length > 512) return false;
  if (hasControlChar(text)) return false;
  // Interactive cmd.exe expands %VAR% inside double quotes, and %% is not a
  // reliable escape there. With /V:ON it also expands !VAR! inside quotes.
  // Reject those arguments instead of targeting a substituted context.
  if (shell === "cmd" && (text.includes("%") || text.includes("!"))) return false;
  return true;
}

function normalizePopupShell(shell) {
  return shell === "powershell" || shell === "cmd" ? shell : "posix";
}

function quoteShellArg(shell, value) {
  const text = String(value);
  if (shell === "cmd") return `"${text.replace(/"/g, '""')}"`;
  if (shell === "powershell") return `'${text.replace(/'/g, "''")}'`;
  return shQuote(text);
}

function kubectlPrefix(context, namespace, shell = "posix") {
  const popupShell = normalizePopupShell(shell);
  if (!isSafeShellArg(context, popupShell)) return null;
  const parts = ["kubectl", "--context", quoteShellArg(popupShell, context)];
  if (namespace != null && namespace !== "") {
    if (!isSafeShellArg(namespace, popupShell)) return null;
    parts.push("-n", quoteShellArg(popupShell, namespace));
  }
  return parts.join(" ");
}

function optionalContainerArg(container, shell = "posix") {
  if (container == null || container === "") return "";
  if (!isSafeShellArg(container, normalizePopupShell(shell))) return null;
  return ` -c ${quoteShellArg(normalizePopupShell(shell), container)}`;
}

function isKubectlForbiddenError(message) {
  return /\bforbidden\b/i.test(String(message || ""));
}

function isKubectlUnreachableError(message) {
  const text = String(message || "");
  if (!text.trim() || isKubectlForbiddenError(text)) return false;
  return /couldn'?t get current server api group list|could not get current server api group list|unable to connect to the server|connection refused|dial tcp|i\/o timeout|no such host|network is unreachable|context deadline exceeded|tls handshake timeout/i.test(text);
}

function isNerdctlUnreachableError(message) {
  const text = String(message || "").toLowerCase();
  if (!text.trim()) return false;
  if (text.includes("rootless containerd") || text.includes("xdg_runtime_dir")) return true;
  if (text.includes("cannot connect to the docker daemon")) return true;
  if (!text.includes("containerd")) return false;
  return /not running|connection refused|no such file|cannot connect|failed to connect|unavailable/.test(text);
}

const POD_STATUS_MESSAGE_KEYS = {
  Running: "systemManager.k8s.status.Running",
  Pending: "systemManager.k8s.status.Pending",
  Completed: "systemManager.k8s.status.Completed",
  Succeeded: "systemManager.k8s.status.Succeeded",
  Failed: "systemManager.k8s.status.Failed",
  Unknown: "systemManager.k8s.status.Unknown",
  CrashLoopBackOff: "systemManager.k8s.status.CrashLoopBackOff",
  ContainerCreating: "systemManager.k8s.status.ContainerCreating",
  Evicted: "systemManager.k8s.status.Evicted",
  Terminating: "systemManager.k8s.status.Terminating",
  ImagePullBackOff: "systemManager.k8s.status.ImagePullBackOff",
  ErrImagePull: "systemManager.k8s.status.ErrImagePull",
  Error: "systemManager.k8s.status.Error",
  OOMKilled: "systemManager.k8s.status.OOMKilled",
};

function podStatusMessageKey(status) {
  return POD_STATUS_MESSAGE_KEYS[String(status || "")] || null;
}

function runtimeFailureMessage(errorCode, context) {
  if (errorCode === "nerdctlUnreachable") {
    return { key: "systemManager.errors.nerdctlUnreachable" };
  }
  if (errorCode === "clusterUnreachable") {
    const name = typeof context === "string" ? context.trim() : "";
    if (name) {
      return {
        key: "systemManager.errors.clusterUnreachable",
        values: { context: name },
      };
    }
    return { key: "systemManager.errors.clusterUnreachableGeneric" };
  }
  return null;
}

function wrapClearAndExec(command) {
  return `sh -c ${shQuote(`${CLEAR_STARTUP_OUTPUT} exec ${command}`)}`;
}

function buildKubectlContextsCommand() {
  return "kubectl config view -o json";
}

function buildKubectlNamespacesCommand(context, shell) {
  const popupShell = normalizePopupShell(shell);
  if (!isSafeShellArg(context, popupShell)) return null;
  return `kubectl --context ${quoteShellArg(popupShell, context)} get namespaces -o json`;
}

function buildKubectlPodsCommand(context, namespace, shell) {
  const prefix = kubectlPrefix(context, namespace, shell);
  if (!prefix) return null;
  return `${prefix} get pods -o json`;
}

function buildKubectlDeletePodCommand(context, namespace, pod, shell) {
  const popupShell = normalizePopupShell(shell);
  const prefix = kubectlPrefix(context, namespace, popupShell);
  if (!prefix || !isSafeShellArg(pod, popupShell)) return null;
  return `${prefix} delete pod ${quoteShellArg(popupShell, pod)} --wait=false`;
}

function containerShellArg(shell) {
  if (shell === "cmd") {
    return 'sh -c "command -v bash >/dev/null 2>&1 && exec bash || exec sh"';
  }
  return "sh -c 'command -v bash >/dev/null 2>&1 && exec bash || exec sh'";
}

function finishKubectlPopup(shell, command) {
  return shell === "posix" ? wrapClearAndExec(command) : `${popupHistoryPrefix(shell)}${command}`;
}

function buildKubectlExecShellCommand(context, namespace, pod, container, shell) {
  const popupShell = normalizePopupShell(shell);
  const prefix = kubectlPrefix(context, namespace, popupShell);
  if (!prefix) return 'echo "Invalid context"';
  if (!isSafeShellArg(pod, popupShell)) return 'echo "Invalid pod name"';
  const containerArg = optionalContainerArg(container, popupShell);
  if (containerArg == null) return 'echo "Invalid container name"';
  const command = `${prefix} exec -it ${quoteShellArg(popupShell, pod)}${containerArg} -- ${containerShellArg(popupShell)}`;
  return finishKubectlPopup(popupShell, command);
}

function buildKubectlLogsCommand(context, namespace, pod, container, shell) {
  const popupShell = normalizePopupShell(shell);
  const prefix = kubectlPrefix(context, namespace, popupShell);
  if (!prefix) return 'echo "Invalid context"';
  if (!isSafeShellArg(pod, popupShell)) return 'echo "Invalid pod name"';
  const containerArg = optionalContainerArg(container, popupShell);
  if (containerArg == null) return 'echo "Invalid container name"';
  const command = `${prefix} logs -f --tail 200 ${quoteShellArg(popupShell, pod)}${containerArg}`;
  return finishKubectlPopup(popupShell, command);
}

function buildKubectlDescribeCommand(context, namespace, pod, shell) {
  const popupShell = normalizePopupShell(shell);
  const prefix = kubectlPrefix(context, namespace, popupShell);
  if (!prefix) return 'echo "Invalid context"';
  if (!isSafeShellArg(pod, popupShell)) return 'echo "Invalid pod name"';
  const command = `${prefix} describe pod ${quoteShellArg(popupShell, pod)}`;
  return finishKubectlPopup(popupShell, command);
}

function parseJsonValue(text) {
  const raw = String(text || "");
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch !== "{" && ch !== "[") continue;
    try {
      return JSON.parse(raw.slice(i));
    } catch {
      // A bracketed banner such as [WARN] is not the JSON document.
    }
  }
  throw new Error("Invalid JSON");
}

function parseKubeconfigContexts(jsonText) {
  const parsed = parseJsonValue(jsonText);
  const current = typeof parsed["current-context"] === "string" ? parsed["current-context"] : "";
  const contexts = [];
  const list = Array.isArray(parsed.contexts) ? parsed.contexts : [];
  for (const entry of list) {
    const name = typeof entry?.name === "string" ? entry.name : "";
    if (!name) continue;
    const rawNamespace = entry?.context?.namespace;
    const namespace = typeof rawNamespace === "string" && rawNamespace ? rawNamespace : "default";
    contexts.push({
      name,
      namespace,
      current: name === current,
    });
  }
  return { contexts, current };
}

function parseNamespaceList(jsonText) {
  const parsed = parseJsonValue(jsonText);
  const items = Array.isArray(parsed.items) ? parsed.items : [];
  const names = [];
  for (const item of items) {
    const name = item?.metadata?.name;
    if (typeof name === "string" && name) names.push(name);
  }
  return names;
}

function formatPodAge(iso, now = Date.now()) {
  const timestamp = Date.parse(String(iso || ""));
  if (!Number.isFinite(timestamp)) return "";
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function podDisplayStatus(pod) {
  if (typeof pod?.metadata?.deletionTimestamp === "string" && pod.metadata.deletionTimestamp) {
    return "Terminating";
  }
  const statuses = [
    ...(Array.isArray(pod?.status?.initContainerStatuses) ? pod.status.initContainerStatuses : []),
    ...(Array.isArray(pod?.status?.containerStatuses) ? pod.status.containerStatuses : []),
  ];
  for (const status of statuses) {
    const reason = status?.state?.waiting?.reason;
    if (reason) return String(reason);
  }
  const podReason = typeof pod?.status?.reason === "string" ? pod.status.reason.trim() : "";
  if (podReason) return podReason;
  for (const status of statuses) {
    const reason = status?.state?.terminated?.reason;
    if (reason && reason !== "Completed") return String(reason);
  }
  const phase = String(pod?.status?.phase || "Unknown");
  if (phase === "Succeeded") return "Completed";
  return phase;
}

function podContainerNames(pod) {
  const names = [];
  const specs = [
    ...(Array.isArray(pod?.spec?.containers) ? pod.spec.containers : []),
    ...(Array.isArray(pod?.spec?.initContainers) ? pod.spec.initContainers : []),
    ...(Array.isArray(pod?.spec?.ephemeralContainers) ? pod.spec.ephemeralContainers : []),
  ];
  for (const container of specs) {
    const name = container?.name;
    if (typeof name === "string" && name && !names.includes(name)) names.push(name);
  }
  return names;
}

function podShellContainerNames(pod) {
  const running = new Set();
  const statuses = [
    ...(Array.isArray(pod?.status?.containerStatuses) ? pod.status.containerStatuses : []),
    ...(Array.isArray(pod?.status?.initContainerStatuses) ? pod.status.initContainerStatuses : []),
    ...(Array.isArray(pod?.status?.ephemeralContainerStatuses) ? pod.status.ephemeralContainerStatuses : []),
  ];
  for (const status of statuses) {
    if (status?.state?.running && typeof status.name === "string" && status.name) {
      running.add(status.name);
    }
  }
  const ordered = podContainerNames(pod).filter((name) => running.has(name));
  for (const name of running) {
    if (!ordered.includes(name)) ordered.push(name);
  }
  return ordered;
}

function podRestartCount(pod) {
  const statuses = [
    ...(Array.isArray(pod?.status?.containerStatuses) ? pod.status.containerStatuses : []),
    ...(Array.isArray(pod?.status?.initContainerStatuses) ? pod.status.initContainerStatuses : []),
  ];
  let restarts = 0;
  for (const status of statuses) {
    const count = Number(status?.restartCount || 0);
    if (Number.isFinite(count)) restarts += count;
  }
  return restarts;
}

function parseKubectlPodList(jsonText, now = Date.now()) {
  const parsed = parseJsonValue(jsonText);
  const items = Array.isArray(parsed.items) ? parsed.items : [];
  const pods = [];
  for (const pod of items) {
    const name = typeof pod?.metadata?.name === "string" ? pod.metadata.name : "";
    if (!name) continue;
    pods.push({
      name,
      namespace: typeof pod?.metadata?.namespace === "string" ? pod.metadata.namespace : "",
      status: podDisplayStatus(pod),
      restarts: podRestartCount(pod),
      age: formatPodAge(pod?.metadata?.creationTimestamp, now),
      containers: podContainerNames(pod),
      shellContainers: podShellContainerNames(pod),
    });
  }
  return pods;
}

module.exports = {
  NETCATTY_POPUP_HISTORY_MARKER,
  CONTAINER_RUNTIMES,
  SOURCE_ORDER,
  normalizeContainerRuntime,
  isContainerSource,
  runtimeBinary,
  buildRuntimeCommand,
  parseRuntimeProbe,
  sourcesFromCapabilities,
  pickContainerSource,
  rememberedContainerSource,
  reconcileContainerSource,
  isAutomaticRuntimeFallback,
  firstContainerRuntime,
  isRuntimeSocketPermissionError,
  sanitizeContainerId,
  buildContainerExecShellCommand,
  buildContainerLogsCommand,
  buildKubectlContextsCommand,
  buildKubectlNamespacesCommand,
  buildKubectlPodsCommand,
  buildKubectlDeletePodCommand,
  buildKubectlExecShellCommand,
  buildKubectlLogsCommand,
  buildKubectlDescribeCommand,
  isKubectlForbiddenError,
  isKubectlUnreachableError,
  isNerdctlUnreachableError,
  podStatusMessageKey,
  runtimeFailureMessage,
  parseKubeconfigContexts,
  parseNamespaceList,
  parseKubectlPodList,
  formatPodAge,
};
