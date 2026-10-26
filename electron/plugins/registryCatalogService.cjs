"use strict";

const { createHash } = require("node:crypto");
const { PluginCatalogService, fetchBounded, validateCatalog, MAX_CATALOG_BYTES, DISTRIBUTION_ORIGIN } = require("./catalogService.cjs");
const REGISTRY_URL = `${DISTRIBUTION_ORIGIN}/catalog.json`;
const tokenFor = (entry) => createHash("sha256").update(JSON.stringify(entry)).digest("hex");

function prepareSnapshot(value) {
  const entries = structuredClone(validateCatalog(value));
  const publicEntries = structuredClone(entries).map((entry) => ({ ...entry, selectionToken: tokenFor(entry) }));
  return { entries, publicEntries };
}

class RegistryCatalogService extends PluginCatalogService {
  constructor(options) {
    super(options);
    this.publicEntries = prepareSnapshot(this.entries).publicEntries;
    this.source = "builtin";
    this.error = null;
    this.refreshing = null;
  }
  async refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      try {
        // No redirects: only this exact registry endpoint can replace the catalog.
        const bytes = await fetchBounded(REGISTRY_URL, MAX_CATALOG_BYTES, this.fetch);
        const next = prepareSnapshot(JSON.parse(bytes.toString("utf8")));
        // Publish only after full validation, clones and every token succeeded.
        this.entries = next.entries;
        this.publicEntries = next.publicEntries;
        this.source = "registry";
        this.error = null;
        return true;
      } catch (error) {
        if (this.source === "registry") this.source = "cached";
        this.error = String(error.message ?? error).slice(0, 1024);
        return false;
      }
    })();
    try { return await this.refreshing; } finally { this.refreshing = null; }
  }
  async list() {
    await this.refresh();
    return {
      entries: structuredClone(this.publicEntries),
      source: this.source,
      error: this.error,
    };
  }
  selected(id, token) {
    const entry = this.get(id);
    if (typeof token !== "string" || token !== tokenFor(entry)) {
      throw new Error("Catalog entry changed. Refresh and review this version before continuing.");
    }
    return entry;
  }
  async readme(id, token) {
    this.selected(id, token);
    // Base method captures the pinned entry synchronously before its first await.
    return super.readme(id);
  }
  async install(id, token) {
    this.selected(id, token);
    if (!await this.refresh()) throw new Error("Registry refresh failed. Cached catalogs are browse-only; retry when online.");
    this.selected(id, token);
    return super.install(id);
  }
}
module.exports = { RegistryCatalogService, REGISTRY_URL, MAX_CATALOG_BYTES };
