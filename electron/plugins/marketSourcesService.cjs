"use strict";
const { PluginSourceRegistry } = require("./sourceRegistry.cjs");
const { RegistryCatalogService } = require("./registryCatalogService.cjs");
const { createSourceFetch } = require("./sourceFetch.cjs");

class MarketSourcesService {
  constructor(options) {
    this.options = options;
    this.manager = options.manager;
    this.registry = new PluginSourceRegistry(options.database);
    this.catalogs = new Map();
  }
  #catalog(sourceId = "official") {
    const source = this.registry.get(sourceId);
    let catalog = this.catalogs.get(source.id);
    if (!catalog) {
      catalog = new RegistryCatalogService({ ...this.options, source,
        fetch: source.id === "official" ? this.options.fetch : (this.options.createSourceFetch ?? createSourceFetch)(source.origin),
        sourceGuard: () => this.registry.get(source.id),
      });
      this.catalogs.set(source.id, catalog);
    }
    return catalog;
  }
  list(sourceId) { return this.#catalog(sourceId).list(); }
  readme(id, token, sourceId) { return this.#catalog(sourceId).readme(id, token); }
  install(id, token, sourceId = "official", acceptedSourceId) {
    if (sourceId !== "official" && acceptedSourceId !== sourceId) throw new Error("Review and confirm this third-party source before installing");
    return this.#catalog(sourceId).install(id, token);
  }
  listSources() { return this.registry.list(); }
  addSource(payload) { return this.manager.changeMarketSource(() => this.registry.add(payload?.name, payload?.address)); }
  updateSource(payload) { return this.manager.changeMarketSource(() => this.registry.update(payload?.id, payload?.name, payload?.enabled)); }
  async removeSource(payload) {
    if (typeof payload?.disablePlugins !== "boolean") throw new Error("Choose whether to disable installed plugins");
    await this.manager.changeMarketSource(() => {
      this.registry.remove(payload.id);
      this.catalogs.delete(payload.id);
    }, payload.disablePlugins ? payload.id : undefined);
  }
}
module.exports = { MarketSourcesService };
