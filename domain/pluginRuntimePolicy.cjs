"use strict";

// Shared by host placement, release admission, and the installed-package UI.
// A Node entrypoint does not change default placement, but is not admitted to
// the normal browser-only product path.
function describePluginRuntime(manifest) {
  const providers = manifest?.contributes?.providers ?? [];
  const permissions = [...(manifest?.permissions?.required ?? []), ...(manifest?.permissions?.optional ?? [])];
  const permissionIds = permissions.map((entry) => typeof entry === "string" ? entry : entry.permission);
  const hasCompanions = Boolean(manifest?.companionExecutables?.length);
  const hasInterceptors = providers.some((provider) => (
    provider.kind === "terminal.interceptor.input" || provider.kind === "terminal.interceptor.output"
  ));
  const declaresAdvanced = permissionIds.some((permission) => [
    "runtime.advanced", "companion.execute", "terminal.intercept.input", "terminal.intercept.output",
  ].includes(permission));
  const hasBrowser = Boolean(manifest?.main?.browser);
  const hasNode = Boolean(manifest?.main?.node);
  const defaultRuntimeKind = hasBrowser && !hasCompanions && !hasInterceptors ? "browser" : "utility";
  return {
    defaultRuntimeKind,
    hasNode,
    declaresAdvanced,
    browserOnly: hasBrowser && !hasNode && !hasCompanions && !hasInterceptors && !declaresAdvanced,
  };
}

function assertBrowserOnlyPlugin(manifest) {
  if (!describePluginRuntime(manifest).browserOnly) {
    const error = new Error("This package requires advanced developer mode; normal plugin management accepts browser-only packages");
    error.code = "PLUGIN_UNSUPPORTED_RUNTIME";
    throw error;
  }
}

module.exports = { describePluginRuntime, assertBrowserOnlyPlugin };
