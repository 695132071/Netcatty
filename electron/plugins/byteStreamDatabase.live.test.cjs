"use strict";

// Creates only an isolated disposable fixture. Never accepts a user host,
// existing database, database URL, or real credentials from the environment.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { execFileSync } = require("node:child_process");
const { randomUUID, randomBytes } = require("node:crypto");
const { pathToFileURL } = require("node:url");
const path = require("node:path");
const { PluginByteStreamBroker } = require("./byteStreamBroker.cjs");
const FIXTURE_IMAGE = "mariadb:11.4@sha256:250e1609e93c0e6aecf64bfbab2d84d5e89d2481540fe77447ff6c855c3b1873";

function docker(args, input) {
  return execFileSync("docker", args, { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 60_000 }).trim();
}

test("minimal browser protocol queries a disposable MariaDB through the real byte broker", {
  skip: process.env.NETCATTY_BYTE_STREAM_DATABASE_TEST !== "1",
  timeout: 120_000,
}, async (t) => {
  const suffix = randomUUID().slice(0, 8);
  const network = `netcatty-stream-test-${suffix}`;
  const container = `netcatty-stream-test-${suffix}`;
  const sessionPassword = randomBytes(24).toString("hex");
  docker(["network", "create", "--internal", network]);
  let created = false;
  t.after(() => {
    if (created) docker(["rm", "--force", container]);
    docker(["network", "rm", network]);
  });
  docker(["run", "--detach", "--rm", "--name", container, "--network", network,
    "--env", "MARIADB_ALLOW_EMPTY_ROOT_PASSWORD=1", FIXTURE_IMAGE]);
  created = true;
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try { docker(["exec", container, "mariadb-admin", "--host=127.0.0.1", "ping", "--silent"]); ready = true; break; }
    catch { await new Promise((resolve) => setTimeout(resolve, 500)); }
  }
  assert.equal(ready, true, "isolated MariaDB fixture starts");
  docker(["exec", "--interactive", container, "mariadb", "--protocol=socket", "--user=root"], `
CREATE DATABASE plugin_demo;
CREATE TABLE plugin_demo.example_result (value VARCHAR(64));
INSERT INTO plugin_demo.example_result VALUES ('synthetic stream result');
CREATE USER 'plugin_demo'@'%' IDENTIFIED BY '${sessionPassword}';
GRANT SELECT ON plugin_demo.example_result TO 'plugin_demo'@'%';
`);
  assert.equal(docker(["port", container]), "", "the isolated fixture publishes no host ports");
  const address = docker(["inspect", "--format", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", container]);
  assert.match(address, /^172\.[0-9]+\.[0-9]+\.[0-9]+$/u);
  const endpoint = `tcp://${address}:3306`;
  const broker = new PluginByteStreamBroker({
    permissionEngine: {
      authorize: async (_context, request) => assert.deepEqual(request.resources, [endpoint]),
      onDidRevoke: () => ({ dispose() {} }),
    },
  });
  t.after(() => broker.shutdown());
  const context = { pluginId: "com.netcatty.database-minimal", runtimeId: `fixture-${suffix}`, assertActive: async () => {} };
  const { handleId } = await broker.connect(endpoint, context);
  const { queryExample, READ_QUERY } = await import(pathToFileURL(path.resolve(
    __dirname, "../../examples/plugins/database-minimal/protocol.mjs",
  )).href);
  assert.equal(READ_QUERY, "SELECT value FROM plugin_demo.example_result LIMIT 1");
  const result = await queryExample({
    read: () => broker.read(handleId, context),
    write: (bytes) => broker.write(handleId, bytes, context),
    close: () => { if (broker.connections.has(handleId)) broker.close(handleId, context); },
  }, "plugin_demo", sessionPassword);
  assert.deepEqual(result, { columns: ["value"], rows: [["synthetic stream result"]] });
  assert.equal(broker.connections.size, 0);
  // Server-side grants, not a SQL-prefix check, enforce the read-only fixture.
  // MYSQL_PWD exists only inside this disposable test exec and is never logged.
  assert.throws(() => execFileSync("docker", ["exec", "--interactive", container, "sh", "-c",
    'read -r MYSQL_PWD; export MYSQL_PWD; exec mariadb --host=127.0.0.1 --user=plugin_demo --execute="INSERT INTO plugin_demo.example_result VALUES (1)"'],
  { input: `${sessionPassword}\n`, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }),
  (error) => error.status === 1 && /INSERT command denied/u.test(String(error.stderr)));
});
