import { runtimeFailureMessage } from "@/domain/systemManager/containerRuntime.shared.cjs";

export type {
  ContainerRuntimeId,
  ContainerSourceId,
  KubeContextInfo,
  KubectlPodInfo,
  RuntimeProbeFlags,
} from "@/domain/systemManager/containerRuntime.shared.cjs";

export {
  NETCATTY_POPUP_HISTORY_MARKER,
  buildContainerExecShellCommand,
  buildContainerLogsCommand,
  buildKubectlDescribeCommand,
  buildKubectlExecShellCommand,
  buildKubectlLogsCommand,
  firstContainerRuntime,
  isContainerSource,
  isKubectlForbiddenError,
  isAutomaticRuntimeFallback,
  pickContainerSource,
  podStatusMessageKey,
  reconcileContainerSource,
  rememberedContainerSource,
  sourcesFromCapabilities,
} from "@/domain/systemManager/containerRuntime.shared.cjs";

export function describeRuntimeFailure(
  result: { error?: string; errorCode?: string } | null | undefined,
  translate: (key: string, values?: Record<string, string>) => string,
  fallback: string,
  context?: string | null,
): string {
  const mapped = runtimeFailureMessage(result?.errorCode, context);
  if (mapped) return translate(mapped.key, mapped.values);
  return result?.error || fallback;
}
