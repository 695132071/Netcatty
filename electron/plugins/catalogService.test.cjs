"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { createHash } = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { PluginCatalogService, validateCatalog, fetchBounded } = require("./catalogService.cjs");
const { assertCatalogManifest } = require("./catalogPolicy.cjs");
const entries = require("./catalog.json");

test("curated catalog uses pinned public first-party source and rejects advanced manifests", () => {
  assert.equal(validateCatalog(entries).length, 1);
  for (const main of [{ node: "index.js" }, { browser: "index.js", node: "node.js" }]) {
    const entry = structuredClone(entries[0]); entry.manifest.main = main;
    assert.throws(() => validateCatalog([entry]), /browser-only packages/);
  }
  const entry = structuredClone(entries[0]);
  entry.manifest.permissions.optional.push("runtime.advanced");
  assert.throws(() => assertCatalogManifest(entry.manifest, entry), /advanced developer mode/);
  for (const readme of ["../README.md", "a/%2e%2e/README.md", "a\\README.md"]) {
    assert.throws(() => validateCatalog([{ ...entries[0], readme }]), /unpinned/);
  }
  assert.throws(() => validateCatalog([{ ...entries[0], commit: "main" }]), /unpinned/);
});

test("README retrieval is bounded and pinned, never follows a redirect to latest", async () => {
  const requested = [];
  const service = new PluginCatalogService({ entries, fetch: async (url) => {
    requested.push(url); return new Response("# First-party example");
  } });
  assert.equal(await service.readme(entries[0].id), "# First-party example");
  assert.equal(requested[0], `https://raw.githubusercontent.com/${entries[0].repository}/${entries[0].commit}/${entries[0].readme}`);
  service.fetch = async () => new Response(null, { status: 302, headers: { location: "https://raw.githubusercontent.com/a/b/main/README.md" } });
  await assert.rejects(service.readme(entries[0].id), /redirects/);
  await assert.rejects(fetchBounded("https://raw.githubusercontent.com/a/b/c", 3, async () => new Response("1234")), /size limit/);
  await assert.rejects(fetchBounded("https://127.0.0.1/a", 10), /approved HTTPS/);
  await assert.rejects(fetchBounded("https://github.com/a", 10, async () => new Response(null, { status: 302, headers: { location: "http://localhost/secret" } })), /approved HTTPS/);
});

test("catalog install verifies the digest, shares manager installation, and never auto-enables", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "netcatty-catalog-test-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from("synthetic bytes: package validation belongs to PackageStore");
  const entry = { ...structuredClone(entries[0]), artifact: { url: "https://github.com/example/repo/releases/download/v1/plugin.ncpkg", sha256: createHash("sha256").update(bytes).digest("hex") } };
  let installs = 0;
  const service = new PluginCatalogService({ entries: [entry], paths: { dev: root }, fetch: async () => new Response(bytes), manager: {
    async install(archive, options) {
      installs++;
      assert.deepEqual(await fs.readFile(archive), bytes);
      assert.equal(options.enable, false);
      assert.equal(options.catalog.artifact.sha256, entry.artifact.sha256);
      return { id: entry.id };
    },
  } });
  await service.install(entry.id);
  assert.equal(installs, 1);
  assert.deepEqual(await fs.readdir(root), []);
  service.fetch = async () => new Response("changed");
  await assert.rejects(service.install(entry.id), /SHA-256 mismatch/);
  assert.equal(installs, 1);
  await assert.rejects(service.install("unknown"), /curated catalog/);
});

test("catalog rejects unknown permissions instead of presenting an unimplemented grant", () => {
  const entry = structuredClone(entries[0]);
  entry.manifest.permissions.optional.push("future.unknown");
  assert.throws(() => validateCatalog([entry]), /manifest is invalid/);
});
