"use strict";

const { createHash } = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const catalog = require("./catalog.json");
const { getTempFilePath } = require("../bridges/tempDirBridge.cjs");
const { createDefinitionValidator, formatValidationErrors } = require("./contractValidator.cjs");
const validateManifest = createDefinitionValidator("PluginManifest");
const { assertCatalogManifest } = require("./catalogPolicy.cjs");
const { assertPluginJsonValue } = require("./jsonBoundary.cjs");
const MAX_CATALOG_BYTES = 2 * 1024 * 1024;
const CATALOG_FIELDS = new Set(["id", "version", "name", "description", "author", "repository", "commit", "license", "readme", "manifest", "artifact"]);

const DOWNLOAD_HOSTS = new Set(["github.com", "raw.githubusercontent.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"]);
function assertDownloadUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port || !DOWNLOAD_HOSTS.has(url.hostname)) {
    throw new Error("Catalog download URL is not an approved HTTPS GitHub source");
  }
  return url.href;
}
function pinnedReadmeUrl(entry) {
  if (typeof entry.readme !== "string" || /[\u0000-\u001f\u007f\\%?#]/u.test(entry.readme)
    || entry.readme.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("Invalid or unpinned README path");
  }
  const prefix = `/${entry.repository}/${entry.commit}/`;
  const url = new URL(`https://raw.githubusercontent.com${prefix}${entry.readme.split("/").map(encodeURIComponent).join("/")}`);
  if (!url.pathname.startsWith(prefix)) throw new Error("README URL escapes the pinned commit");
  return url.href;
}
function validateCatalog(entries) {
  assertPluginJsonValue(entries, { maxBytes: MAX_CATALOG_BYTES });
  if (!Array.isArray(entries) || entries.length > 1000) throw new Error("Invalid plugin catalog");
  const ids = new Set();
  for (const entry of entries) {
    if (!entry || Object.keys(entry).some((key) => !CATALOG_FIELDS.has(key)) || ["id", "version", "name", "description", "author", "repository", "commit", "license", "readme"].some((key) => typeof entry[key] !== "string" || entry[key].length > 4096) || !/^[a-z0-9][a-z0-9.-]+$/u.test(entry.id) || ids.has(entry.id)
      || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(entry.repository)
      || !/^[a-f0-9]{40}$/u.test(entry.commit)
      || !entry.license || !entry.author || !entry.name
      || typeof entry.readme !== "string" || !entry.readme.endsWith(".md")
      || entry.readme.split("/").some((p) => !p || p === "." || p === "..") || /[\\%?#\0]/u.test(entry.readme)) {
      throw new Error("Invalid or unpinned plugin catalog entry");
    }
    pinnedReadmeUrl(entry);
    if (!validateManifest(entry.manifest)) throw new Error(`Catalog manifest is invalid: ${formatValidationErrors(validateManifest.errors)}`);
    assertCatalogManifest(entry.manifest, entry);
    ids.add(entry.id);
    if (Object.hasOwn(entry, "artifact")) {
      if (!entry.artifact || typeof entry.artifact !== "object" || Array.isArray(entry.artifact)
        || Object.keys(entry.artifact).some((key) => key !== "url" && key !== "sha256")
        || typeof entry.artifact.url !== "string" || typeof entry.artifact.sha256 !== "string") {
        throw new Error("Invalid catalog artifact metadata");
      }
      assertDownloadUrl(entry.artifact.url);
      if (!/^[a-f0-9]{64}$/u.test(entry.artifact.sha256)) throw new Error("Catalog artifact requires SHA-256");
    }
  }
  return entries;
}
async function fetchBounded(url, limit, fetchImpl = fetch, maxRedirects = 4) {
  const signal = AbortSignal.timeout(30_000);
  for (let redirects = 0; redirects <= maxRedirects; redirects++) {
    const response = await fetchImpl(assertDownloadUrl(url), { redirect: "manual", signal, credentials: "omit", referrerPolicy: "no-referrer" });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      url = new URL(response.headers.get("location"), url).href;
      continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Catalog download failed (${response.status})`); }
    if (Number(response.headers.get("content-length")) > limit) {
      await response.body?.cancel(); throw new Error("Catalog download exceeds size limit");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Catalog download has no body");
    const chunks = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) throw new Error("Catalog download exceeds size limit");
        chunks.push(Buffer.from(value));
      }
      return Buffer.concat(chunks, size);
    } finally { await reader.cancel(); }
  }
  throw new Error("Too many catalog redirects");
}
class PluginCatalogService {
  constructor(options) {
    this.entries = structuredClone(validateCatalog(options.entries ?? catalog));
    this.fetch = options.fetch ?? fetch;
    this.getTempFilePath = options.getTempFilePath ?? getTempFilePath;
    this.manager = options.manager;
    this.installing = false;
  }
  list() { return structuredClone(this.entries); }
  get(id) {
    const entry = this.entries.find((item) => item.id === id);
    if (!entry) throw new Error("Plugin is not in the curated catalog");
    return entry;
  }
  async readme(id) {
    const entry = this.get(id);
    const url = pinnedReadmeUrl(entry);
    return (await fetchBounded(url, 256 * 1024, this.fetch, 0)).toString("utf8");
  }
  async install(id) {
    const entry = this.get(id);
    if (!entry.artifact) throw new Error("This source example has no published package; build and import locally");
    if (this.installing) throw new Error("A catalog installation is already in progress");
    this.installing = true;
    let directory;
    try {
      const bytes = await fetchBounded(entry.artifact.url, 32 * 1024 * 1024, this.fetch);
      if (createHash("sha256").update(bytes).digest("hex") !== entry.artifact.sha256) throw new Error("Catalog package SHA-256 mismatch");
      directory = await fs.mkdtemp(this.getTempFilePath("plugin-catalog-"));
      const archive = path.join(directory, "package.ncpkg");
      await fs.writeFile(archive, bytes, { mode: 0o600, flag: "wx" });
      return await this.manager.install(archive, { enable: false, catalog: entry });
    } finally {
      this.installing = false;
      if (directory) await fs.rm(directory, { recursive: true, force: true });
    }
  }
}
module.exports = { PluginCatalogService, assertDownloadUrl, fetchBounded, validateCatalog, pinnedReadmeUrl, MAX_CATALOG_BYTES };
