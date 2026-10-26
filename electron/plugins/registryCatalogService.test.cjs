"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { RegistryCatalogService, REGISTRY_URL, MAX_CATALOG_BYTES } = require("./registryCatalogService.cjs");
const builtin = require("./catalog.json");

test("registry uses a fixed bounded anonymous endpoint and retains only validated snapshots", async () => {
  let response = () => new Response(JSON.stringify([builtin[0]]));
  const service = new RegistryCatalogService({ fetch: async (url, options) => {
    assert.equal(url, REGISTRY_URL);
    assert.equal(options.credentials, "omit"); assert.equal(options.redirect, "manual");
    assert.equal(options.referrerPolicy, "no-referrer"); assert.ok(options.signal);
    return response();
  } });
  const online = await service.list();
  assert.equal(online.source, "registry"); assert.equal(online.entries.length, 1);
  assert.match(online.entries[0].selectionToken, /^[a-f0-9]{64}$/);
  for (const invalid of ["{", '{}', JSON.stringify([{ ...builtin[0], author: {} }]), JSON.stringify([{ ...builtin[0], commit: "main" }])]) {
    response = () => new Response(invalid);
    const cached = await service.list();
    assert.equal(cached.source, "cached"); assert.ok(cached.error);
    assert.deepEqual(cached.entries, online.entries);
  }
  response = () => new Response("[]", { headers: { "content-length": String(MAX_CATALOG_BYTES + 1) } });
  assert.match((await service.list()).error, /size limit/);
  response = () => new Response(null, { status: 302, headers: { location: "https://raw.githubusercontent.com/other/repo/main/catalog.json" } });
  assert.match((await service.list()).error, /redirects/);
  response = () => new Response("[]");
  const empty = await service.list();
  assert.equal(empty.error, null); assert.deepEqual(empty.entries, []);
});

test("offline first launch returns bundled source examples and never mutates installed plugins", async () => {
  const service = new RegistryCatalogService({ fetch: async () => { throw new Error("offline"); }, manager: {
    install() { assert.fail("offline must not install"); },
  } });
  const snapshot = await service.list();
  assert.equal(snapshot.source, "builtin"); assert.equal(snapshot.entries.length, 2);
  assert.match(snapshot.error, /offline/);
  await assert.rejects(service.install(snapshot.entries[0].id, snapshot.entries[0].selectionToken), /browse-only/);
});

test("selection binds manifest, README, version and artifact; refresh changes or withdrawal cannot silently install", async () => {
  let entries = structuredClone(builtin);
  let requests = 0;
  const service = new RegistryCatalogService({ fetch: async (url) => {
    requests++;
    if (url === REGISTRY_URL) return new Response(JSON.stringify(entries));
    return new Response("# Pinned README");
  }, manager: { install() { assert.fail("changed selection must not install"); } } });
  const selected = (await service.list()).entries[0];
  assert.equal(await service.readme(selected.id, selected.selectionToken), "# Pinned README");
  await assert.rejects(service.readme(selected.id, "bad"), /changed/);
  const before = requests;
  await assert.rejects(service.install(selected.id), /changed/);
  assert.equal(requests, before);
  entries[0].description += " updated";
  await assert.rejects(service.install(selected.id, selected.selectionToken), /changed/);
  await assert.rejects(service.readme(selected.id, selected.selectionToken), /changed/);
  entries = [];
  const next = (await service.list()).entries;
  assert.deepEqual(next, []);
  await assert.rejects(service.install(selected.id, selected.selectionToken), /curated catalog/);
});

test("concurrent list refreshes share one request", async () => {
  let finish; let calls = 0;
  const service = new RegistryCatalogService({ fetch: async () => { calls++; return new Promise((resolve) => { finish = resolve; }); } });
  const first = service.list(); const second = service.list();
  finish(new Response(JSON.stringify(builtin)));
  assert.deepEqual(await first, await second); assert.equal(calls, 1);
});

test("fresh unchanged selection installs only its pinned bytes and stays disabled", async (context) => {
  const fs = require("node:fs/promises"); const os = require("node:os"); const path = require("node:path");
  const { createHash } = require("node:crypto");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "registry-test-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from("synthetic validated-by-manager archive");
  const entry = { ...structuredClone(builtin[0]), artifact: { url: "https://github.com/example/plugin/releases/download/v1/plugin.ncpkg", sha256: createHash("sha256").update(bytes).digest("hex") } };
  const requests = []; let installs = 0;
  const service = new RegistryCatalogService({
    getTempFilePath: (name) => path.join(root, name),
    fetch: async (url) => { requests.push(url); return new Response(url === REGISTRY_URL ? JSON.stringify([entry]) : bytes); },
    manager: { async install(archive, options) {
      installs++; assert.deepEqual(await fs.readFile(archive), bytes); assert.equal(options.enable, false);
      assert.deepEqual(options.catalog, entry); return { id: entry.id };
    } },
  });
  const selected = (await service.list()).entries[0];
  await service.install(selected.id, selected.selectionToken);
  assert.deepEqual(requests, [REGISTRY_URL, REGISTRY_URL, entry.artifact.url]);
  assert.equal(installs, 1); assert.deepEqual(await fs.readdir(root), []);
});
