"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PluginDatabase } = require("./database.cjs");
const { thirdPartySource, LOCAL_SOURCE } = require("./sourceIdentity.cjs");
const { PluginSyncSidecarService } = require("./pluginSyncSidecarService.cjs");
const { settingsSidecarKey } = require("./pluginSyncSidecarHelpers.cjs");
const id = "example.plugin";
const first = thirdPartySource("First", "https://first.example.com");
const second = thirdPartySource("Second", "https://second.example.com");
function install(db, source) {
  db.installVersion({ pluginId: id, version: "1.0.0", manifest: {}, archiveSha256: "a".repeat(64), packageRelativePath: "example.plugin/1.0.0", source });
}
test("same ID cannot change source during install, uninstall or database restart without explicit private reset", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-source-isolation-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "db.sqlite");
  let db = new PluginDatabase(file);
  install(db, first);
  db.setValue(id, "key", "old KV");
  assert.deepEqual(db.listKeys(id), ["key"]);
  db.setSetting(id, "greeting", "application", "application", "old setting");
  db.setViewState(id, "view", "self", { private: true });
  db.upsertPermissionGrant({ pluginId: id, permission: "views", resource: "self", resourceKind: "exact", declarationHash: "same-code" });
  db.upsertSecret({ pluginId: id, key: "secret", secretRef: "old-ref", ciphertext: Buffer.from("ciphertext") });
  db.setSyncSidecar(id, "account_baseline", "account", "old baseline");
  assert.equal(db.getSecretByRef(id, "old-ref").pluginId, id);
  assert.equal(db.listPermissionGrants(id)[0].pluginId, id);
  assert.throws(() => install(db, second), /source differs/);
  assert.throws(() => db.clearUninstalledSourceData(id, first.id), /Uninstall/);
  db.removePlugin(id);
  db.close();
  db = new PluginDatabase(file);
  t.after(() => db.close());
  assert.throws(() => install(db, second), /source differs/);
  assert.throws(() => install(db, LOCAL_SOURCE), /source differs/);
  assert.throws(() => db.clearUninstalledSourceData(id, second.id), /changed/);
  db.clearUninstalledSourceData(id, first.id);
  install(db, second);
  assert.equal(db.getActivePlugin(id).source.id, second.id);
  assert.equal(db.getValue(id, "key"), undefined);
  assert.equal(db.getSetting(id, "greeting", "application", "application"), undefined);
  assert.equal(db.getViewState(id, "view", "self"), undefined);
  assert.deepEqual(db.listPermissionGrants(id), []);
  assert.equal(db.getSecretByRef(id, "old-ref"), null);
  assert.equal(db.getSyncSidecar(id, "account_baseline", "account"), undefined);
});

test("old-source cloud settings remain orphaned and cannot hydrate a new source", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-source-sync-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const db = new PluginDatabase(path.join(root, "db.sqlite"));
  t.after(() => db.close());
  install(db, first);
  const oldOwner = db.privateOwner(id);
  db.removePlugin(id);
  db.clearUninstalledSourceData(id, first.id);
  install(db, second);
  const calls = [];
  const service = new PluginSyncSidecarService({ database: db, contributionService: {
    snapshot: () => ({ plugins: [{ id, settings: [{ id: "greeting", scope: "application", sync: true }] }] }),
    updateSetting: (...args) => calls.push(args),
  } });
  const entry = { pluginId: oldOwner, kind: "settings", key: settingsSidecarKey("greeting", "application", "application"), value: "old remote data", updatedAt: 1000 };
  await service.applyFromSync({ version: 1, entries: [entry] });
  await service.hydrateInstalledPluginSettings(id);
  assert.deepEqual(calls, []);
  assert.equal(db.getSetting(id, "greeting", "application", "application"), undefined);
  await service.applyFromSync({ version: 1, entries: [{ ...entry, pluginId: db.privateOwner(id), value: "new source" }] });
  assert.equal(calls[0][0], id);
  assert.equal(db.getSetting(id, "greeting", "application", "application"), "new source");
});
