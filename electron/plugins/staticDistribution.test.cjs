"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { createHash } = require("node:crypto");
const { assertDownloadUrl, fetchBounded, validateCatalog } = require("./catalogService.cjs");
const { RegistryCatalogService, REGISTRY_URL } = require("./registryCatalogService.cjs");
const builtin = require("./catalog.json");
const digest = (value) => createHash("sha256").update(value).digest("hex");

test("normal catalog and detail requests use only the official static origin, including failure", async () => {
  const markdown = "# Synthetic snapshot\n![ignored remote image](https://avatars.githubusercontent.com/u/1)";
  const entry = { ...builtin[0], readmeAsset: { url: `https://plugins.netcatty.app/readmes/${digest(markdown)}.md`, sha256: digest(markdown) } };
  let offline = false;
  const requests = [];
  const service = new RegistryCatalogService({ fetch: async (url, options) => {
    requests.push(url);
    assert.equal(new URL(url).origin, "https://plugins.netcatty.app");
    assert.equal(options.credentials, "omit");
    assert.equal(options.redirect, "manual");
    if (offline) throw new Error("synthetic network unavailable");
    if (url === REGISTRY_URL) return new Response(JSON.stringify([entry]));
    assert.equal(url, entry.readmeAsset.url);
    return new Response(markdown);
  } });
  const selected = (await service.list()).entries[0];
  assert.equal(await service.readme(selected.id, selected.selectionToken), markdown);
  offline = true;
  assert.equal((await service.list()).source, "cached");
  await assert.rejects(service.readme(selected.id, selected.selectionToken), /network unavailable/);
  await assert.rejects(service.install(selected.id, selected.selectionToken), /browse-only/);
  assert.deepEqual(requests, [REGISTRY_URL, entry.readmeAsset.url, REGISTRY_URL, entry.readmeAsset.url, REGISTRY_URL]);
});

test("GitHub, tracking and noncanonical asset URLs are rejected before any upstream request", async () => {
  const urls = [
    "https://api.github.com/repos/a/b", "https://raw.githubusercontent.com/a/b/main/README.md",
    "https://avatars.githubusercontent.com/u/1", "https://github.com/a/b/releases/download/v1/a.ncpkg",
    "https://release-assets.githubusercontent.com/a", "https://objects.githubusercontent.com/a",
    "https://plugins.netcatty.app.attacker.invalid/a", "https://plugins.netcatty.app@attacker.invalid/a",
    "http://plugins.netcatty.app/a", "https://plugins.netcatty.app/a?track=1", "https://plugins.netcatty.app/a#fragment",
    "https://plugins.netcatty.app/a/../b", "https://plugins.netcatty.app/%2e%2e/b", "https://plugins.netcatty.app/\ta",
  ];
  for (const url of urls) {
    assert.throws(() => assertDownloadUrl(url));
    for (const field of ["artifact", "readmeAsset"]) {
      assert.throws(() => validateCatalog([{ ...builtin[0], [field]: { url, sha256: "a".repeat(64) } }]));
    }
    await assert.rejects(fetchBounded(url, 1024, () => assert.fail("invalid source must not be requested")));
  }
});

test("official static responses never redirect to GitHub or another official path", async () => {
  for (const location of ["https://github.com/a", "https://raw.githubusercontent.com/a/b/main/catalog.json", "https://plugins.netcatty.app/another.json"]) {
    const requests = [];
    await assert.rejects(fetchBounded(REGISTRY_URL, 1024, async (url) => {
      requests.push(url); return new Response(null, { status: 302, headers: { location } });
    }), /redirects/);
    assert.deepEqual(requests, [REGISTRY_URL]);
  }
});

test("a catalog containing GitHub assets cannot replace the last known good static snapshot", async () => {
  let value = builtin;
  const service = new RegistryCatalogService({ fetch: async (url) => {
    assert.equal(url, REGISTRY_URL); return new Response(JSON.stringify(value));
  } });
  const good = await service.list();
  for (const field of ["artifact", "readmeAsset"]) {
    value = [{ ...builtin[0], [field]: { url: "https://raw.githubusercontent.com/a/b/main/file", sha256: "a".repeat(64) } }];
    const rejected = await service.list();
    assert.equal(rejected.source, "cached");
    assert.deepEqual(rejected.entries, good.entries);
    assert.match(rejected.error, /approved HTTPS/);
  }
});
