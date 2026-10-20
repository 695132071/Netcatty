"use strict";
const { executeBoundedSshCommand } = require("../boundedSshExec.cjs");

// One bounded nvidia-smi query per poll. The awk summary stays
// "<avgUtil> <sumUsed|N/A> <sumTotal|N/A> <firstName>" and, when cards parse,
// appends " ;; index<TAB>name<TAB>util|N/A<TAB>used|N/A<TAB>total|N/A" records.
// Names are taken from the middle columns so a comma inside the product name
// does not shift utilization or memory. "|" cannot survive into the stats line.
const GPU_ASSIGNMENT = `gpustat=$(gpucsv=$(timeout -s KILL 2 nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits 2>/dev/null) && printf '%s\\n' "$gpucsv" | awk -F', *' 'NF >= 5 {idx=$1; util=$(NF-2); used=$(NF-1); total=$NF; gsub(/^[ \\t"]+|[ \\t"]+$/, "", idx); gsub(/^[ \\t"]+|[ \\t"]+$/, "", util); gsub(/^[ \\t"]+|[ \\t"]+$/, "", used); gsub(/^[ \\t"]+|[ \\t"]+$/, "", total); if (idx !~ /^[0-9]+$/) next; name=$2; for (i=3; i<=NF-3; i++) name=name ", " $i; gsub(/^[ \\t"]+|[ \\t"]+$/, "", name); gsub(/\\t/, " ", name); gsub(/\\|/, "/", name); gsub(/ ;; /, " ", name); g++; if (util ~ /^[0-9]+$/) {n++; u+=util} if (used ~ /^[0-9]+$/) {mu+=used; uc++} if (total ~ /^[0-9]+$/) {mt+=total; tc++} if (name0=="") name0=name; utilOut=(util ~ /^[0-9]+$/) ? util : "N/A"; usedOut=(used ~ /^[0-9]+$/) ? used : "N/A"; totalOut=(total ~ /^[0-9]+$/) ? total : "N/A"; rec=idx "\\t" name "\\t" utilOut "\\t" usedOut "\\t" totalOut; list=(list=="") ? rec : list " ;; " rec} END{if (n>0) {printf "%.0f %s %s %s", u/n, (uc==g ? sprintf("%.0f", mu) : "N/A"), (tc==g ? sprintf("%.0f", mt) : "N/A"), name0; if (list != "") printf " ;; %s", list}}' 2>/dev/null || echo "")`;
const EMPTY_GPU = {
  gpu: null,
  gpuName: null,
  gpuMemUsed: null,
  gpuMemTotal: null,
  gpus: [],
};
const GPU_LIST_MARK = " ;; ";
const states = new WeakMap();
function stateFor(conn) {
  let state = states.get(conn);
  if (!state) {
    state = {
      stats: EMPTY_GPU,
      nextAt: 0,
      pending: null,
      controller: null,
      updatedAt: 0,
      disabled: false,
    };
    states.set(conn, state);
  }
  return state;
}
function sameGpuList(left, right) {
  const a = left || [];
  const b = right || [];
  return a.length === b.length && a.every((gpu, index) => {
    const other = b[index];
    return gpu.index === other.index
      && gpu.name === other.name
      && gpu.utilization === other.utilization
      && gpu.memoryUsed === other.memoryUsed
      && gpu.memoryTotal === other.memoryTotal;
  });
}
function updateGpuStats(state, next) {
  const changed = Object.keys(EMPTY_GPU).some((key) => (
    key === "gpus" ? !sameGpuList(state.stats[key], next[key]) : state.stats[key] !== next[key]
  ));
  if (changed) {
    // Publication time is separate from CPU history and strictly advances even
    // when a fast GPU reply shares the CPU sample's millisecond.
    state.updatedAt = Math.max(Date.now() + 1, state.updatedAt + 1);
  }
  state.stats = next;
}
function monitorGpuUpdatedAt(conn) {
  return states.get(conn)?.updatedAt ?? 0;
}
function emptyGpuStats() {
  return { ...EMPTY_GPU, gpus: [] };
}
function parseGpuNumber(value) {
  if (value == null || !/^[0-9]+$/.test(String(value).trim())) return null;
  return parseInt(value, 10);
}
function parseGpuCard(record) {
  const fields = String(record || "").split("\t");
  if (fields.length < 5) return null;
  const index = parseGpuNumber(fields[0]);
  if (index == null) return null;
  const memoryTotal = parseGpuNumber(fields[fields.length - 1]);
  const memoryUsed = parseGpuNumber(fields[fields.length - 2]);
  const utilization = parseGpuNumber(fields[fields.length - 3]);
  return {
    index,
    name: fields.slice(1, fields.length - 3).join("\t").trim(),
    utilization: utilization == null ? null : Math.max(0, Math.min(100, utilization)),
    memoryUsed,
    memoryTotal,
  };
}
function parseGpuStats(output) {
  const payload = String(output || "")
    .split("|")
    .find((part) => part.startsWith("GPU:"))
    ?.slice(4)
    .trim() ?? "";
  if (!payload) return emptyGpuStats();
  const markAt = payload.indexOf(GPU_LIST_MARK);
  const summary = (markAt === -1 ? payload : payload.slice(0, markAt)).trim();
  const list = markAt === -1 ? "" : payload.slice(markAt + GPU_LIST_MARK.length);
  const raw = summary.split(/\s+/).filter(Boolean);
  const utilization = parseGpuNumber(raw[0]);
  if (utilization == null) return emptyGpuStats();
  const gpus = list
    ? list.split(GPU_LIST_MARK).map(parseGpuCard).filter(Boolean)
    : [];
  return {
    gpu: Math.max(0, Math.min(100, utilization)),
    gpuName: raw.slice(3).join(" ") || null,
    gpuMemUsed: parseGpuNumber(raw[1]),
    gpuMemTotal: parseGpuNumber(raw[2]),
    gpus,
  };
}
function withCachedMonitorGpu(conn, result) {
  const state = states.get(conn);
  return state && result?.success
    ? { ...result, stats: { ...result.stats, ...state.stats } }
    : result;
}
function cacheFullGpuStats(conn, stats) {
  const state = stateFor(conn);
  state.controller?.abort();
  updateGpuStats(
    state,
    Object.fromEntries(
      Object.keys(EMPTY_GPU).map((key) => [key, stats[key] ?? (key === "gpus" ? [] : null)]),
    ),
  );
  state.nextAt = Date.now() + 10000;
}
/** Optional GPU work never joins the CPU/memory sampler or its history clock. */
function startMonitorGpuProbe(conn, command, options = {}) {
  const state = stateFor(conn);
  if (state.disabled || state.pending || Date.now() < state.nextAt) return;
  const controller = new AbortController();
  state.controller = controller;
  state.nextAt = Date.now() + 30000;
  state.pending = Promise.resolve()
    .then(() =>
      executeBoundedSshCommand(conn, command, {
        ...options,
        signal: controller.signal,
        invalidateTransportOnAbort: false,
        invalidateOnOpenTimeout: false,
        openingTimeoutMs: 2500,
        runTimeoutMs: 2500,
        maxOutputBytes: 65536,
      }),
    )
    .then(({ stdout }) => {
      if (controller.signal.aborted) return;
      updateGpuStats(state, parseGpuStats(stdout));
      state.nextAt = Date.now() + (state.stats.gpu == null ? 30000 : 10000);
    })
    .catch((error) => {
      // A timed-out channel open cannot be withdrawn from ssh2's request FIFO.
      // Keep this optional probe from disconnecting SSH or piling up requests.
      if (error?.code === "SSH_EXEC_OPEN_TIMEOUT") state.disabled = true;
      if (!controller.signal.aborted) updateGpuStats(state, EMPTY_GPU);
    })
    .finally(() => {
      state.pending = null;
      if (state.controller === controller) state.controller = null;
    });
}
function cancelMonitorGpuProbe(conn) {
  states.get(conn)?.controller?.abort();
}
module.exports = {
  GPU_ASSIGNMENT,
  monitorGpuUpdatedAt,
  parseGpuStats,
  withCachedMonitorGpu,
  cacheFullGpuStats,
  startMonitorGpuProbe,
  cancelMonitorGpuProbe,
};
