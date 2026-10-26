"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { PluginLogger, PluginLogSink, redactLogValue } = require("./pluginLogger.cjs");
const { PluginLogService } = require("./pluginLogService.cjs");
const { PluginHostRpcRegistry } = require("./hostRpcRegistry.cjs");
const { PluginPermissionEngine } = require("./permissionEngine.cjs");
const { RPC_ERRORS } = require("./rpcRouter.cjs");

async function fixture(t, limits = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "netcatty-synthetic-plugin-logs-"));
  const paths = { root, logs: path.join(root, "logs") };
  let response = 0;
  const service = new PluginLogService({ paths, limits, resolveProvenance: () => ({ sourceId: "synthetic-source", sourceKind: "local", namespace: "test" }),
    electron: { shell: { openPath: async () => "" }, dialog: { showMessageBox: async () => ({ response }), showSaveDialog: async () => ({ filePath: path.join(root, "export.jsonl") }) } } });
  await service.ready;
  t.after(async () => { await service.close(); await fs.rm(root, { recursive: true, force: true }); });
  const identity = { pluginId: "com.example.synthetic", pluginVersion: "1.2.3", runtimeId: "host-runtime-1", runtimeKind: "browser" };
  const logger = service.createLogger(identity, { archiveSha256: "a".repeat(64) });
  const records = async () => {
    await service.sink.flush();
    const files = await fs.readdir(service.directory).catch(() => []);
    const lines = (await Promise.all(files.map((name) => fs.readFile(path.join(service.directory, name), "utf8")))).join("");
    return lines.trim() ? lines.trim().split("\n").map(JSON.parse) : [];
  };
  return { service, logger, identity, root, paths, records, confirm: () => { response = 1; } };
}

test("persistence defaults off and disabled logger does not coerce or inspect text", async (t) => {
  const f = await fixture(t);
  await f.logger.write("error", { toString() { throw Error("must not execute"); } });
  f.logger.audit({ operation: "storage.get", result: "ok" });
  assert.deepEqual(await f.records(), []);
  await assert.rejects(fs.stat(f.service.directory), { code: "ENOENT" });
  assert.equal(f.service.status().saveToDisk, false);
});

test("enabled host audit excludes bodies and binds host source, version, hash and runtime", async (t) => {
  const f = await fixture(t);
  await f.service.configure({ saveToDisk: true, verbose: false });
  await f.logger.write("info", "SYNTHETIC_SECRET_PROMPT");
  f.logger.audit({ operation: "network.request", authorization: "allowed", result: "ok", resources: ["https://user:password@example.test/private?api_key=SYNTHETIC_SECRET"],
    body: "SYNTHETIC_SECRET_BODY", error: "SYNTHETIC_SECRET_ERROR", inputBytes: 24, outputBytes: 64, durationMs: 3, pluginId: "spoof" });
  const records = await f.records();
  assert.equal(records.length, 1);
  assert.equal(records[0].pluginId, f.identity.pluginId);
  assert.equal(records[0].sourceId, "synthetic-source");
  assert.equal(records[0].archiveSha256, "a".repeat(64));
  assert.equal(records[0].runtimeId, "host-runtime-1");
  assert.equal(records[0].authorization, "allowed");
  assert.equal(records[0].inputBytes, 24);
  assert.match(records[0].targetIds[0], /^[a-f0-9]{64}$/u);
  assert.doesNotMatch(JSON.stringify(records), /SYNTHETIC_SECRET|example.test|password|spoof/);
});

test("verbose diagnostics are opt-in, bounded and cannot impersonate host records", async (t) => {
  const f = await fixture(t);
  await f.service.configure({ saveToDisk: true, verbose: true });
  await f.logger.write("bad", "message\u001b\n", { sourceId: "spoof", recordType: "host-audit", apiKey: "SYNTHETIC_SECRET", prompt: "SYNTHETIC_SECRET", Notes: "SYNTHETIC_SECRET", SQL: "SYNTHETIC_SECRET", results: "SYNTHETIC_SECRET", terminalContent: "SYNTHETIC_SECRET", credentialPayload: "SYNTHETIC_SECRET" });
  const records = await f.records();
  assert.equal(records[0].sourceId, "synthetic-source");
  assert.equal(records[0].recordType, "plugin-diagnostic");
  assert.equal(records[0].trust, "plugin-authored-unverified");
  assert.equal(records[0].diagnostic.fields.sourceId, "spoof");
  assert.doesNotMatch(JSON.stringify(records), /SYNTHETIC_SECRET|\\u001b/);
  const cyclic = {}; cyclic.self = cyclic;
  await f.logger.write("error", { toString() { throw Error("coercion"); } }, cyclic);
  await f.logger.write("info", "proxy", new Proxy({}, { ownKeys() { throw Error("proxy"); } }));
  const getter = {};
  Object.defineProperty(getter, "value", { enumerable: true, get() { throw Error("accessor"); } });
  assert.equal(redactLogValue(getter).value, "[UNAVAILABLE]");
  assert.equal((await f.records()).length, 3);
  const restored = new PluginLogService({ paths: f.paths });
  await restored.ready;
  assert.equal(restored.status().saveToDisk, true);
  assert.equal(restored.status().verbose, false);
  await restored.close();
});

test("shared disk cap, queue cap, retention and drop accounting", async (t) => {
  const f = await fixture(t, { maxBytes: 800, maxFiles: 2, maxPendingBytes: 1600 });
  await f.service.configure({ saveToDisk: true, verbose: true });
  for (let i = 0; i < 10; i++) {
    f.logger.audit({ operation: "storage.get", result: "ok" });
    await f.service.sink.flush();
  }
  let files = await fs.readdir(f.service.directory);
  assert.ok(files.length <= 2);
  for (const name of files) assert.ok((await fs.stat(path.join(f.service.directory, name))).size <= 800);
  for (let i = 0; i < 1000; i++) f.logger.audit({ operation: "storage.get", result: "ok" });
  assert.ok(f.service.sink.pendingBytes <= 1600);
  assert.ok(f.service.status().droppedRecords > 0);
  await f.service.sink.flush();
  f.logger.audit({ operation: "storage.get", result: "ok" });
  assert.ok((await f.records()).some((record) => record.droppedRecords > 0));
  files = await fs.readdir(f.service.directory);
  for (const name of files) await fs.utimes(path.join(f.service.directory, name), new Date(0), new Date(0));
  await f.service.sink.prune();
  assert.deepEqual(await fs.readdir(f.service.directory), []);
});

test("disable, revoke, clear confirmation and shutdown stop future diagnostic writes", async (t) => {
  const f = await fixture(t);
  await f.service.configure({ saveToDisk: true, verbose: true });
  await f.logger.write("info", "before revoke");
  await f.service.sink.flush();
  f.logger.close();
  await f.logger.write("info", "after revoke");
  assert.equal((await f.records()).length, 1);
  await f.service.clear();
  assert.equal((await f.records()).length, 1);
  f.confirm(); await f.service.clear();
  assert.equal((await f.records()).length, 0);
  const active = f.service.createLogger(f.identity, {});
  await f.service.configure({ saveToDisk: false, verbose: false });
  await active.write("info", "disabled");
  assert.equal((await f.records()).length, 0);
  await f.service.configure({ saveToDisk: true, verbose: true });
  await active.write("info", "before shutdown");
  await f.service.close();
  await active.write("info", "after shutdown");
  assert.equal((await f.records()).length, 1);
});

test("export is local and does not alter retained files", async (t) => {
  const f = await fixture(t);
  await f.service.configure({ saveToDisk: true, verbose: false });
  f.logger.audit({ operation: "filesystem.stat", result: "ok", authorization: "allowed" });
  await f.service.exportLogs();
  const exported = await fs.readFile(path.join(f.root, "export.jsonl"), "utf8");
  assert.equal(JSON.parse(exported).operation, "filesystem.stat");
  assert.equal((await f.records()).length, 1);
});

test("RPC audit includes denied, malformed and public operations without error messages or bodies", async (t) => {
  const f = await fixture(t);
  await f.service.configure({ saveToDisk: true, verbose: false });
  const registry = new PluginHostRpcRegistry();
  const engine = new PluginPermissionEngine({ database: { listPermissionGrants: () => [] } });
  t.after(() => engine.shutdown());
  registry.use(engine.createMiddleware());
  registry.registerRequest("synthetic.public", (params) => ({ data: params.data }), { metadata: { public: true } });
  registry.registerRequest("synthetic.denied", () => { throw Error("not reached"); });
  registry.registerRequest("synthetic.invalid", () => null, { validateParams() { throw new Error("SYNTHETIC_SECRET_ERROR"); } });
  const routes = registry.createRoutes({ ...f.identity, logger: f.logger });
  await routes.requestHandlers["synthetic.public"]({ data: "SYNTHETIC_SECRET_BODY" }, {});
  await assert.rejects(routes.requestHandlers["synthetic.denied"]({}, {}), { code: RPC_ERRORS.permissionDenied });
  await assert.rejects(routes.requestHandlers["synthetic.invalid"]({}, {}));
  const records = await f.records();
  assert.deepEqual(records.map((r) => r.authorization), ["not-required", "denied", "not-reached"]);
  assert.equal(records[0].inputBytes, 21);
  assert.doesNotMatch(JSON.stringify(records), /SYNTHETIC_SECRET/);
});

test("I/O failure is counted and never fails plugin execution", async (t) => {
  const f = await fixture(t);
  await f.service.configure({ saveToDisk: true, verbose: true });
  await fs.writeFile(f.service.sink.file(0), "");
  await fs.rm(f.service.sink.file(0));
  await fs.symlink(path.join(f.root, "outside"), f.service.sink.file(0));
  await f.logger.write("info", "synthetic");
  await f.service.sink.flush();
  assert.equal(f.service.status().writeErrors, 1);
  assert.equal(f.service.status().droppedRecords, 1);
});

test("invalid sink limits fail early", () => {
  assert.throws(() => new PluginLogSink({ directory: "/unused", maxFiles: -1 }));
  const logger = new PluginLogger();
  assert.doesNotThrow(() => logger.write("info", "disabled"));
});

test("unknown provenance stays unknown and a disabled restart prunes expired files", async (t) => {
  const f = await fixture(t);
  f.service.resolveProvenance = () => null;
  const logger = f.service.createLogger({ ...f.identity, sourceId: "manifest-official-claim" }, { sourceId: "manifest-official-claim", archiveSha256: "c".repeat(64) });
  await f.service.configure({ saveToDisk: true, verbose: false });
  logger.audit({ operation: "storage.get", result: "ok" });
  const records = await f.records();
  assert.equal(records[0].sourceId, null);
  assert.equal(records[0].namespace, null);
  assert.doesNotMatch(JSON.stringify(records), /manifest-official-claim/);
  await f.service.configure({ saveToDisk: false, verbose: false });
  await fs.utimes(f.service.sink.file(0), new Date(0), new Date(0));
  const restored = new PluginLogService({ paths: f.paths });
  await restored.ready;
  assert.equal(restored.status().saveToDisk, false);
  assert.deepEqual(await fs.readdir(restored.directory), []);
  await restored.close();
});

test("noisy and malformed plugin diagnostics remain bounded with visible drops", async (t) => {
  const f = await fixture(t, { maxPendingBytes: 4096 });
  await f.service.configure({ saveToDisk: true, verbose: true });
  const wide = {};
  for (let index = 0; index < 100; index++) wide[`key-${index}`] = Array(100).fill("synthetic ".repeat(100));
  await f.logger.write(Symbol("invalid"), { toString() { throw Error("must not coerce"); } }, wide);
  for (let index = 0; index < 1000; index++) void f.logger.write("info", "synthetic noise", { pluginId: "spoof", index });
  assert.ok(f.service.sink.pendingBytes <= 4096);
  assert.ok(f.service.status().droppedRecords > 0);
  for (const record of await f.records()) {
    assert.equal(record.pluginId, f.identity.pluginId);
    assert.ok(Buffer.byteLength(JSON.stringify(record)) < 16384);
  }
});

test("source resolver URLs and userinfo are not persisted as source identity", async (t) => {
  const f = await fixture(t);
  f.service.resolveProvenance = () => ({ sourceId: "https://user:SYNTHETIC_SECRET@example.test/source?key=SYNTHETIC_SECRET", sourceKind: "local", namespace: "user@SYNTHETIC_SECRET" });
  const logger = f.service.createLogger(f.identity, {});
  await f.service.configure({ saveToDisk: true, verbose: false });
  logger.audit({ operation: "storage.get", result: "ok" });
  const records = await f.records();
  assert.equal(records[0].sourceId, null);
  assert.equal(records[0].namespace, null);
  assert.doesNotMatch(JSON.stringify(records), /SYNTHETIC_SECRET/);
});
