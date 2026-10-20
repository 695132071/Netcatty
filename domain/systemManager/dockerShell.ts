import {
  buildContainerExecShellCommand,
  buildContainerLogsCommand,
} from "./containerRuntime.ts";

/** Sanitize Docker container/image IDs — must match electron/bridges/systemManager/dockerOps.cjs */
export function sanitizeDockerContainerId(id: string): string {
  return String(id || "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 64);
}

/** Interactive shell into a container — prefer bash, fall back to sh. */
export function buildDockerExecShellCommand(containerId: string): string {
  return buildContainerExecShellCommand("docker", containerId);
}

export function buildDockerLogsCommand(containerId: string): string {
  return buildContainerLogsCommand("docker", containerId);
}
