"use strict";

const { createHash } = require("node:crypto");
const { PluginCatalogService, validateCatalog, MAX_CATALOG_BYTES } = require("./catalogService.cjs");
const { REGISTRY_URL, fetchDistribution, fetchVerified, tuple } = require("./distributionSnapshot.cjs");
const tokenFor = (entry) => createHash("sha256").update(JSON.stringify(entry)).digest("hex");

function prepareSnapshot(value, resources = new Map()) {
  const entries = structuredClone(validateCatalog(value));
  const publicEntries = structuredClone(entries).map((entry) => ({ ...entry, selectionToken: tokenFor([entry, resources.get(tuple(entry)) ?? null]) }));
  return { entries, publicEntries, resources: structuredClone(resources) };
}

class RegistryCatalogService extends PluginCatalogService {
  constructor(options) {
    super(options);
    this.publicEntries = prepareSnapshot(this.entries).publicEntries;
    this.resources = new Map();
    this.source = "builtin";
    this.error = null;
    this.refreshing = null;
  }
  async refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      try {
        // No redirects: only this exact registry endpoint can replace the catalog.
        const distribution = await fetchDistribution(this.fetch);
        const next = prepareSnapshot(distribution.entries, distribution.resources);
        // Publish only after full validation, clones and every token succeeded.
        this.entries = next.entries;
        this.publicEntries = next.publicEntries;
        this.resources = next.resources;
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
    if (typeof token !== "string" || token !== this.publicEntries.find((item) => item.id === id)?.selectionToken) {
      throw new Error("Catalog entry changed. Refresh and review this version before continuing.");
    }
    return entry;
  }
  async readme(id, token) {
    const entry = this.selected(id, token);
    const resource = this.resources.get(tuple(entry))?.readme;
    if (!resource) throw new Error("No published README snapshot is available. Refresh the catalog or open its source link.");
    return (await fetchVerified(resource, this.fetch)).toString("utf8");
  }
  async install(id, token) {
    this.selected(id, token);
    if (!await this.refresh()) throw new Error("Registry refresh failed. Cached catalogs are browse-only; retry when online.");
    this.selected(id, token);
    return super.install(id);
  }
}
module.exports = { RegistryCatalogService, REGISTRY_URL, MAX_CATALOG_BYTES };
