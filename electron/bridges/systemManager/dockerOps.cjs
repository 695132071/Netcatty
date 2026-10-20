/* eslint-disable no-undef */

function shQuote(str) {
  return `'${String(str).replace(/'/g, `'\"'\"'`)}'`;
}

function sanitizeDockerId(id) {
  return String(id || "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 64);
}

function sanitizeContainerName(name) {
  const trimmed = String(name || "").trim().slice(0, 128);
  if (!trimmed) return null;
  return trimmed.replace(/[^a-zA-Z0-9_.-]/g, "") || null;
}

function sanitizeImageRef(ref) {
  const trimmed = String(ref || "").trim().slice(0, 256);
  return trimmed || null;
}

function isSuccessfulCommandResult(result) {
  return result?.success && (result.code === 0 || result.code === null || result.code === undefined);
}

function dockerCommandError(result, fallback) {
  return (result?.stderr || result?.error || "").trim() || fallback;
}

function getSessionSudoPassword(session) {
  return typeof session?.systemManagerSudoPassword === "string" && session.systemManagerSudoPassword.length > 0
    ? session.systemManagerSudoPassword
    : null;
}

const {
  buildRuntimeCommand,
  isNerdctlUnreachableError,
  isRuntimeSocketPermissionError,
  normalizeContainerRuntime,
  runtimeBinary,
} = require("../../../domain/systemManager/containerRuntime.shared.cjs");

function userFacingRuntimeFailure(runtime, result, fallback) {
  const raw = dockerCommandError(result, fallback);
  if (runtime === "nerdctl" && isNerdctlUnreachableError(raw)) {
    console.error(`[netcatty] nerdctl: ${raw}`);
    return { success: false, errorCode: "nerdctlUnreachable" };
  }
  return {
    success: false,
    error: raw,
    stderr: result?.stderr,
  };
}

function failurePayload(result) {
  const payload = { success: false };
  if (typeof result?.error === "string" && result.error) payload.error = result.error;
  if (typeof result?.errorCode === "string" && result.errorCode) payload.errorCode = result.errorCode;
  if (!payload.error && !payload.errorCode) payload.error = "command failed";
  return payload;
}

function parseJsonRecords(stdout) {
  const raw = String(stdout || "").trim();
  if (!raw) return [];
  if (raw.startsWith("[") || raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.filter((row) => row && typeof row === "object");
      if (parsed && typeof parsed === "object") return [parsed];
    } catch {
      // Fall through to JSON lines when the CLI emits one object per line.
    }
  }
  const rows = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim().replace(/,$/, "");
    if (!trimmed || trimmed === "[" || trimmed === "]") continue;
    try {
      const row = JSON.parse(trimmed);
      if (Array.isArray(row)) rows.push(...row.filter((item) => item && typeof item === "object"));
      else if (row && typeof row === "object") rows.push(row);
    } catch {
      // skip malformed line
    }
  }
  return rows;
}

function portInRange(value) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

function formatHostBind(ip, hostLabel) {
  const bind = ip || "0.0.0.0";
  const host = bind.includes(":") && !bind.startsWith("[") ? `[${bind}]` : bind;
  return `${host}:${hostLabel}`;
}

function formatPortMapping(mapping) {
  if (!mapping || typeof mapping !== "object") return [];
  const containerPort = portInRange(mapping.container_port ?? mapping.containerPort ?? mapping.ContainerPort ?? mapping.PrivatePort);
  if (containerPort === null) return [];
  const hostPort = portInRange(mapping.host_port ?? mapping.hostPort ?? mapping.HostPort ?? mapping.PublicPort);
  const requestedRange = Number(mapping.range ?? mapping.Range);
  const range = Number.isInteger(requestedRange) && requestedRange > 1 ? requestedRange : 1;
  if (containerPort + range - 1 > 65535) return [];
  if (hostPort !== null && hostPort + range - 1 > 65535) return [];
  const hostIp = String(mapping.host_ip ?? mapping.hostIP ?? mapping.HostIP ?? mapping.HostIp ?? mapping.IP ?? "").trim();
  const protocols = String(mapping.protocol ?? mapping.Protocol ?? mapping.Type ?? "tcp")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const protocolList = protocols.length > 0 ? protocols : ["tcp"];
  const containerLabel = range > 1 ? `${containerPort}-${containerPort + range - 1}` : String(containerPort);
  const hostLabel = hostPort === null
    ? ""
    : (range > 1 ? `${hostPort}-${hostPort + range - 1}` : String(hostPort));
  return protocolList.map((protocol) => {
    const keys = [];
    for (let offset = 0; offset < range; offset += 1) keys.push(`${containerPort + offset}/${protocol}`);
    const label = hostLabel
      ? `${formatHostBind(hostIp, hostLabel)}->${containerLabel}/${protocol}`
      : `${containerLabel}/${protocol}`;
    return { label, keys };
  });
}

function formatExposedPorts(exposed, published) {
  if (!exposed || typeof exposed !== "object" || Array.isArray(exposed)) return [];
  const entries = [];
  for (const [key, value] of Object.entries(exposed)) {
    const slash = key.indexOf("/");
    if (slash > 0) {
      const port = portInRange(key.slice(0, slash));
      const protocol = key.slice(slash + 1).trim() || "tcp";
      if (port !== null) entries.push({ port, protocol });
      continue;
    }
    const port = portInRange(key);
    if (port === null) continue;
    const protocols = Array.isArray(value) && value.length > 0 ? value : ["tcp"];
    for (const protocol of protocols) {
      const name = String(protocol || "tcp").trim();
      if (name) entries.push({ port, protocol: name });
    }
  }
  entries.sort((left, right) => left.port - right.port || left.protocol.localeCompare(right.protocol));
  const labels = [];
  for (const entry of entries) {
    const label = `${entry.port}/${entry.protocol}`;
    if (published.has(label) || labels.includes(label)) continue;
    labels.push(label);
  }
  return labels;
}

function formatContainerPorts(row) {
  const ports = row.Ports ?? row.ports;
  if (typeof ports === "string") return ports;
  const labels = [];
  const published = new Set();
  if (Array.isArray(ports)) {
    for (const mapping of ports) {
      for (const formatted of formatPortMapping(mapping)) {
        if (labels.includes(formatted.label)) continue;
        labels.push(formatted.label);
        for (const key of formatted.keys) published.add(key);
      }
    }
  }
  labels.push(...formatExposedPorts(row.ExposedPorts ?? row.exposedPorts, published));
  return labels.join(", ");
}

function parseDockerContainers(stdout) {
  return parseJsonRecords(stdout).map((row) => ({
    id: row.ID || row.Id || "",
    name: String(Array.isArray(row.Names) ? (row.Names[0] || "") : (row.Names || row.Name || "")).replace(/^\//, ""),
    image: row.Image || "",
    status: row.Status || row.State || "",
    state: row.State || "",
    ports: formatContainerPorts(row),
    createdAt: row.CreatedAt || row.Created || "",
  })).filter((container) => container.id || container.name);
}

function parsePercent(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return parseFloat(String(value || "0").replace("%", "")) || 0;
}

function sumNetworkBytes(network) {
  if (!network || typeof network !== "object" || Array.isArray(network)) return null;
  let rx = 0;
  let tx = 0;
  let saw = false;
  for (const stats of Object.values(network)) {
    if (!stats || typeof stats !== "object") continue;
    const rxBytes = stats.RxBytes ?? stats.rx_bytes;
    const txBytes = stats.TxBytes ?? stats.tx_bytes;
    if (typeof rxBytes === "number" && Number.isFinite(rxBytes)) {
      rx += rxBytes;
      saw = true;
    }
    if (typeof txBytes === "number" && Number.isFinite(txBytes)) {
      tx += txBytes;
      saw = true;
    }
  }
  return saw ? { rx, tx } : null;
}

function parseDockerStats(stdout) {
  return parseJsonRecords(stdout).map((row) => {
    const memUsage = typeof row.MemUsage === "number" && typeof row.MemLimit === "number"
      ? `${formatImageSize(row.MemUsage)} / ${formatImageSize(row.MemLimit)}`
      : String(row.MemUsage || row.mem_usage || "");
    const networkTotals = sumNetworkBytes(row.Network || row.network);
    const netIO = row.NetIO || row.net_io || row.netio
      || (networkTotals
        ? `${formatImageSize(networkTotals.rx)} / ${formatImageSize(networkTotals.tx)}`
        : (typeof row.NetInput === "number" && typeof row.NetOutput === "number"
          ? `${formatImageSize(row.NetInput)} / ${formatImageSize(row.NetOutput)}`
          : ""));
    const blockIO = row.BlockIO || row.block_io
      || (typeof row.BlockInput === "number" && typeof row.BlockOutput === "number"
        ? `${formatImageSize(row.BlockInput)} / ${formatImageSize(row.BlockOutput)}`
        : "");
    return {
      id: String(row.ID || row.Id || row.id || row.ContainerID || row.Container || ""),
      name: String(row.Name || row.name || ""),
      cpuPercent: parsePercent(row.CPUPerc ?? row.cpu_percent ?? row.CPU),
      memUsage,
      memPercent: parsePercent(row.MemPerc ?? row.mem_percent),
      netIO: String(netIO),
      blockIO: String(blockIO),
      pids: Number(row.PIDs || row.Pids || row.pids || 0) || 0,
    };
  }).filter((stat) => stat.id || stat.name);
}

function splitImageName(name) {
  const text = String(name || "");
  const slash = text.lastIndexOf("/");
  const colon = text.lastIndexOf(":");
  if (colon > slash) {
    return { repository: text.slice(0, colon), tag: text.slice(colon + 1) };
  }
  return { repository: text, tag: "" };
}

function imageAliases(row) {
  if (row.Repository || row.Tag) {
    return [{ repository: String(row.Repository || ""), tag: String(row.Tag || "") }];
  }
  const names = Array.isArray(row.Names) && row.Names.length > 0
    ? row.Names
    : (Array.isArray(row.RepoTags) ? row.RepoTags : []);
  const aliases = names.filter(Boolean).map((name) => splitImageName(name));
  return aliases.length > 0 ? aliases : [{ repository: "", tag: "" }];
}

function formatImageSize(size) {
  if (typeof size !== "number" || !Number.isFinite(size)) return String(size || "");
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = size;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 || value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded}${units[unit]}`;
}

function formatImageCreated(row) {
  if (row.CreatedAt) return String(row.CreatedAt);
  if (row.CreatedSince) return String(row.CreatedSince);
  if (typeof row.Created === "number" && Number.isFinite(row.Created)) {
    const ms = row.Created > 1e12 ? row.Created : row.Created * 1000;
    return new Date(ms).toISOString();
  }
  if (typeof row.Created === "string") return row.Created;
  return "";
}

function parseDockerImages(stdout) {
  const images = [];
  for (const row of parseJsonRecords(stdout)) {
    const id = String(row.ID || row.Id || "");
    const size = formatImageSize(row.Size);
    const createdAt = formatImageCreated(row);
    const digest = String(row.Digest || (Array.isArray(row.RepoDigests) ? (row.RepoDigests[0] || "") : ""));
    for (const alias of imageAliases(row)) {
      const { repository, tag } = alias;
      const name = repository && tag ? `${repository}:${tag}` : repository || tag || id;
      if (!id && !name) continue;
      images.push({ id, repository, tag, size, createdAt, digest, name });
    }
  }
  return images;
}

function summarizeImageInspect(info) {
  if (!info) return null;
  return {
    id: info.Id,
    repoTags: info.RepoTags,
    repoDigests: info.RepoDigests,
    created: info.Created,
    size: info.Size,
    architecture: info.Architecture,
    os: info.Os,
    config: {
      env: info.Config?.Env,
      cmd: info.Config?.Cmd,
      entrypoint: info.Config?.Entrypoint,
      workingDir: info.Config?.WorkingDir,
      exposedPorts: info.Config?.ExposedPorts,
      labels: info.Config?.Labels,
    },
    rootfs: info.RootFS,
    history: Array.isArray(info.History) ? info.History.slice(0, 5) : undefined,
  };
}

function summarizeContainerInspect(info) {
  if (!info) return null;
  return {
    id: info.Id,
    name: info.Name,
    image: info.Config?.Image,
    state: info.State,
    network: info.NetworkSettings,
    mounts: info.Mounts,
    env: info.Config?.Env,
    labels: info.Config?.Labels,
    created: info.Created,
    path: info.Path,
    args: info.Args,
    restartPolicy: info.HostConfig?.RestartPolicy,
  };
}

function createDockerOpsApi({ execOnSession, getSession }) {
  async function runDocker(event, sessionId, args, timeoutMs = 15000, runtime) {
    const safeRuntime = normalizeContainerRuntime(runtime);
    const bin = runtimeBinary(safeRuntime);
    const cmd = buildRuntimeCommand(safeRuntime, args);
    const result = await execOnSession(event, sessionId, cmd, timeoutMs);
    if (isSuccessfulCommandResult(result)) return result;

    if (isRuntimeSocketPermissionError(safeRuntime, result)) {
      const sudoPassword = getSessionSudoPassword(getSession?.(sessionId));
      let lastSudoResult = null;

      const nopasswdResult = await execOnSession(
        event,
        sessionId,
        `sudo ${cmd}`,
        timeoutMs,
      );
      if (isSuccessfulCommandResult(nopasswdResult)) return nopasswdResult;
      lastSudoResult = nopasswdResult;

      if (sudoPassword) {
        const sudoResult = await execOnSession(
          event,
          sessionId,
          `sudo -S -p '' ${cmd}`,
          timeoutMs,
          { stdin: `${sudoPassword}\n` },
        );
        if (isSuccessfulCommandResult(sudoResult)) return sudoResult;
        lastSudoResult = sudoResult;
      }

      return userFacingRuntimeFailure(
        safeRuntime,
        lastSudoResult,
        `sudo ${bin} exited with code ${lastSudoResult?.code}`,
      );
    }

    if (!result.success) {
      if (safeRuntime === "nerdctl" && isNerdctlUnreachableError(dockerCommandError(result, ""))) {
        return userFacingRuntimeFailure(safeRuntime, result, `${bin} failed`);
      }
      return result;
    }
    if (result.code !== 0 && result.code !== null && result.code !== undefined) {
      return userFacingRuntimeFailure(safeRuntime, result, `${bin} exited with code ${result.code}`);
    }
    return result;
  }

  async function listContainers(event, sessionId, runtime) {
    const result = await runDocker(event, sessionId, "ps -a --format '{{json .}}'", 12000, runtime);
    if (!result.success) return failurePayload(result);
    return { success: true, containers: parseDockerContainers(result.stdout) };
  }

  async function listImages(event, sessionId, runtime) {
    const result = await runDocker(event, sessionId, "images --format '{{json .}}'", 12000, runtime);
    if (!result.success) return failurePayload(result);
    return { success: true, images: parseDockerImages(result.stdout) };
  }

  async function getStats(event, payload) {
    const sessionId = payload?.sessionId;
    if (!sessionId) return { success: false, error: "Missing sessionId" };
    const ids = Array.isArray(payload?.ids) ? payload.ids.filter(Boolean) : [];
    const idArg = ids.map((id) => sanitizeDockerId(id)).filter(Boolean).join(" ");
    const result = await runDocker(
      event,
      sessionId,
      `stats --no-stream --format '{{json .}}' ${idArg}`.trim(),
      15000,
      payload?.runtime,
    );
    if (!result.success) return failurePayload(result);
    return { success: true, stats: parseDockerStats(result.stdout) };
  }

  async function inspectContainer(event, payload) {
    const { sessionId, containerId } = payload || {};
    if (!sessionId || !containerId) return { success: false, error: "Missing params" };
    const safeId = sanitizeDockerId(containerId);
    const result = await runDocker(event, sessionId, `inspect ${safeId}`, 10000, payload?.runtime);
    if (!result.success) return failurePayload(result);
    try {
      const parsed = JSON.parse(result.stdout || "[]");
      const info = Array.isArray(parsed) ? parsed[0] : parsed;
      return { success: true, inspect: summarizeContainerInspect(info) };
    } catch {
      return { success: false, error: "Failed to parse inspect output" };
    }
  }

  async function inspectImage(event, payload) {
    const { sessionId, imageId } = payload || {};
    if (!sessionId || !imageId) return { success: false, error: "Missing params" };
    const safeId = sanitizeDockerId(imageId);
    const result = await runDocker(event, sessionId, `image inspect ${safeId}`, 10000, payload?.runtime);
    if (!result.success) return failurePayload(result);
    try {
      const parsed = JSON.parse(result.stdout || "[]");
      const info = Array.isArray(parsed) ? parsed[0] : parsed;
      return { success: true, inspect: summarizeImageInspect(info) };
    } catch {
      return { success: false, error: "Failed to parse image inspect output" };
    }
  }

  async function containerAction(event, payload) {
    const { sessionId, containerId, action, newName } = payload || {};
    if (!sessionId || !containerId || !action) return { success: false, error: "Missing params" };
    const safeId = sanitizeDockerId(containerId);

    const runtime = payload?.runtime;
    switch (action) {
      case "start":
        return runDocker(event, sessionId, `start ${safeId}`, 15000, runtime);
      case "stop":
        return runDocker(event, sessionId, `stop ${safeId}`, 15000, runtime);
      case "restart":
        return runDocker(event, sessionId, `restart ${safeId}`, 15000, runtime);
      case "rm":
        return runDocker(event, sessionId, `rm -f ${safeId}`, 15000, runtime);
      case "pause":
        return runDocker(event, sessionId, `pause ${safeId}`, 15000, runtime);
      case "unpause":
        return runDocker(event, sessionId, `unpause ${safeId}`, 15000, runtime);
      case "kill":
        return runDocker(event, sessionId, `kill ${safeId}`, 15000, runtime);
      case "rename": {
        const next = sanitizeContainerName(newName);
        if (!next) return { success: false, error: "Invalid container name" };
        return runDocker(event, sessionId, `rename ${safeId} ${shQuote(next)}`, 15000, runtime);
      }
      default:
        return { success: false, error: `Invalid container action: ${action}` };
    }
  }

  async function imageAction(event, payload) {
    const { sessionId, action, imageRef, imageId, force, all, repository, tag } = payload || {};
    if (!sessionId || !action) return { success: false, error: "Missing params" };

    const runtime = payload?.runtime;
    switch (action) {
      case "pull": {
        const ref = sanitizeImageRef(imageRef);
        if (!ref) return { success: false, error: "Missing image reference" };
        return runDocker(event, sessionId, `pull ${shQuote(ref)}`, 600000, runtime);
      }
      case "rm": {
        const repo = String(repository || "").trim();
        const tagName = String(tag || "").trim();
        const tagged = repo && tagName && repo !== "<none>" && tagName !== "<none>";
        if (tagged) {
          const ref = sanitizeImageRef(`${repo}:${tagName}`);
          if (!ref) return { success: false, error: "Invalid image reference" };
          return runDocker(event, sessionId, `rmi ${shQuote(ref)}`, 15000, runtime);
        }
        const safeId = sanitizeDockerId(imageId);
        if (!safeId) return { success: false, error: "Missing image id" };
        const forceFlag = force ? " -f" : "";
        return runDocker(event, sessionId, `rmi${forceFlag} ${safeId}`, 15000, runtime);
      }
      case "prune": {
        const allFlag = all ? " -a" : "";
        return runDocker(event, sessionId, `image prune${allFlag} -f`, 120000, runtime);
      }
      case "tag": {
        const safeId = sanitizeDockerId(imageId);
        const repo = sanitizeImageRef(repository);
        const tagName = String(tag || "").trim().slice(0, 128) || "latest";
        if (!safeId || !repo) return { success: false, error: "Missing params" };
        return runDocker(
          event,
          sessionId,
          `tag ${safeId} ${shQuote(`${repo}:${tagName}`)}`,
          15000,
          runtime,
        );
      }
      default:
        return { success: false, error: `Invalid image action: ${action}` };
    }
  }

  return {
    listContainers,
    listImages,
    getStats,
    inspectContainer,
    inspectImage,
    containerAction,
    imageAction,
    parseDockerContainers,
    parseDockerStats,
    parseDockerImages,
  };
}

module.exports = {
  createDockerOpsApi,
  parseDockerContainers,
  parseDockerStats,
  parseDockerImages,
};
