"use strict";

function assertCatalogManifest(manifest, expected) {
  if (manifest.id !== expected.id || manifest.version !== expected.version) {
    throw new Error("Catalog package identity/version mismatch");
  }
  if (!manifest.main?.browser || manifest.main.node || manifest.companionExecutables?.length
    || manifest.contributes?.providers?.some((p) => p.kind === "terminal.interceptor.input" || p.kind === "terminal.interceptor.output")) {
    throw new Error("Public catalog packages must use the browser runtime only");
  }
  const permissions = [...(manifest.permissions?.required ?? []), ...(manifest.permissions?.optional ?? [])];
  if (permissions.some((p) => ["runtime.advanced", "companion.execute", "terminal.intercept.input", "terminal.intercept.output"].includes(typeof p === "string" ? p : p.permission))) {
    throw new Error("Public catalog packages cannot request advanced runtime permissions");
  }
  if (!manifest.license || manifest.license !== expected.license) throw new Error("Catalog package license mismatch");
}

module.exports = { assertCatalogManifest };
