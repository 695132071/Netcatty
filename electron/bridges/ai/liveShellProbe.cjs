"use strict";

const { buildBashHistoryCleanup, bashHistoryScratchNames } = require("./ptyExecHelpers.cjs");

// Both fish and POSIX shells accept this command. Inspect the parent of a
// short-lived sh in the interactive PTY, rather than the SSH login shell.
function buildLiveShellProbe(marker) {
  const script = 'if test -r "/proc/$PPID/comm"; then IFS= read -r name < "/proc/$PPID/comm"; else name=$(ps -p "$PPID" -o comm= 2>/dev/null); fi; '
    + `printf "\\n${marker}_P:%s\\n" "$name"`;
  // Keep the initial probe short before the active shell is known. Quoted
  // multiline cleanup input can leave a configured zsh editor waiting for
  // continuation input, so defer that Bash-only work until after the reply.
  return ` true ${marker}; printf '\\n%s\\n' '${marker}_I'\n : '${marker}'; command sh -c '${script}' 2>/dev/null; printf '%s' '${marker}_Q'\n`;
}

// This is sent after the short probe, except for zsh/fish replies. Keep the
// existing guarded cleanup and bounded physical lines for Bash's history and
// canonical-input behavior, including renamed Bash executables.
function buildLiveShellProbeCleanup(marker) {
  // command eval bypasses an eval customization; plain eval is the fallback
  // when command itself is shadowed. Never invoke a shadowed builtin after the
  // command path already succeeded. Both eval bodies remain Bash-guarded.
  const cleanup = buildBashHistoryCleanup(marker, true);
  const { dispatcher } = bashHistoryScratchNames(marker);
  const clear = `[ -z "\${${dispatcher}-}" ]||$${dispatcher} unset ${dispatcher}`;
  const fallback = `[ "\${${dispatcher}-}" = command ]||{ ${cleanup}; };${clear}`;
  return ` : '${marker}'; \\command eval '${cleanup}' 2>/dev/null || true; \\\n: '${marker}'; \\eval '${fallback}' 2>/dev/null || true; \\\n: '${marker}'; \\command eval '${clear}' 2>/dev/null || true\n`;
}

// Interactive bash prints PS2 (`> ` by default) on backslash continuations.
// Strip that prefix (and other common prompt leftovers) so `_Q` / `_P:`
// sentinels still parse when the probe is not a single physical line.
function normalizeLiveShellProbeLine(line) {
  return String(line).replace(/^[>#$%\s]+/, "");
}

function parseLiveShellProbe(output, marker) {
  const lines = String(output).replace(/\r/g, "\n").split("\n");
  if (!lines.some((line) => normalizeLiveShellProbeLine(line).startsWith(`${marker}_Q`))) return null;
  for (const line of lines) {
    const normalized = normalizeLiveShellProbeLine(line);
    if (!normalized.startsWith(`${marker}_P:`)) continue;
    const name = normalized.slice(marker.length + 3).trim().split("/").pop().replace(/^-/, "");
    return {
      shellName: name,
      kind: name === "fish" ? "fish"
        : /^(?:ba|da|z|k|a)?sh$/.test(name) ? "posix" : null,
    };
  }
  return { kind: null, shellName: "" };
}

module.exports = { buildLiveShellProbe, buildLiveShellProbeCleanup, parseLiveShellProbe, normalizeLiveShellProbeLine };
