"use strict";

const { createHash } = require("node:crypto");
const { PluginCatalogService, fetchBounded, validateCatalog } = require("./catalogService.cjs");
const REGISTRY_URL = "https://raw.githubusercontent.com/binaricat/netcatty-plugins/main/catalog.json";
const MAX_CATALOG_BYTES = 2 * 1024 * 1024;
const tokenFor = (entry) => createHash("sha256").update(JSON.stringify(entry)).digest("hex");

class RegistryCatalogService extends PluginCatalogService {
  constructor(options) {
    super(options);
    this.source = "builtin";
    this.error = null;
    this.refreshing = null;
  }
  async refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      try {
        // No redirects: only this exact registry endpoint can replace the catalog.
        const bytes = await fetchBounded(REGISTRY_URL, MAX_CATALOG_BYTES, this.fetch, 0);
        const next = validateCatalog(JSON.parse(bytes.toString("utf8")));
        this.entries = next;
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
      entries: this.entries.map((entry) => ({ ...structuredClone(entry), selectionToken: tokenFor(entry) })),
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
