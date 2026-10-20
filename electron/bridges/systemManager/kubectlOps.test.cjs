"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createKubectlOpsApi } = require("./kubectlOps.cjs");

test("background kubectl quotes for the executor, not the interactive cmd shell", async () => {
  const commands = [];
  const api = createKubectlOpsApi({
    execOnSession: async (_event, _sessionId, command) => {
      commands.push(command);
      return { success: true, stdout: '{"items":[]}', stderr: "", code: 0 };
    },
    isLocalSession: () => true,
    process: { platform: "win32" },
  });

  const result = await api.run(null, {
    sessionId: "local-cmd",
    op: "namespaces",
    context: "prod-$east",
    shell: "cmd",
  });

  assert.equal(result.success, true);
  assert.match(commands[0], /--context 'prod-\$east'/);
  assert.doesNotMatch(commands[0], /"/);

  await api.run(null, {
    sessionId: "local-cmd",
    op: "delete",
    context: "prod-$east",
    namespace: "kube-system",
    pod: "coredns-$east",
    shell: "cmd",
  });
  assert.match(commands[1], /--context 'prod-\$east'/);
  assert.match(commands[1], /-n 'kube-system'/);
  assert.match(commands[1], /delete pod 'coredns-\$east'/);
  assert.doesNotMatch(commands[1], /"/);
});

test("background kubectl on a remote session stays POSIX even when the payload asks for cmd", async () => {
  let command = "";
  const api = createKubectlOpsApi({
    execOnSession: async (_event, _sessionId, next) => {
      command = next;
      return { success: true, stdout: '{"items":[]}', stderr: "", code: 0 };
    },
    isLocalSession: () => false,
    process: { platform: "win32" },
  });

  await api.run(null, {
    sessionId: "ssh",
    op: "pods",
    context: "o'brien",
    namespace: "default",
    shell: "cmd",
  });

  assert.match(command, /--context 'o'"'"'brien'/);
  assert.doesNotMatch(command, /--context "o'brien"/);
});

test("pods replace unreachable API discovery spam with a stable code", async () => {
  const logged = [];
  const original = console.error;
  console.error = (...args) => {
    logged.push(args.map(String).join(" "));
  };
  try {
    const api = createKubectlOpsApi({
      execOnSession: async () => ({
        success: true,
        stdout: "",
        stderr: [
          'memcache.go:381] "Couldn\'t get current server API group list"',
          'Get "https://127.0.0.1:6443/api?timeout=32s": dial tcp 127.0.0.1:6443: connect: connection refused',
        ].join("\n"),
        code: 1,
      }),
      isLocalSession: () => false,
      process: { platform: "linux" },
    });

    const result = await api.run(null, {
      sessionId: "s1",
      op: "pods",
      context: "broken-cluster",
      namespace: "default",
    });
    const blob = JSON.stringify(result);

    assert.equal(result.success, false);
    assert.equal(result.errorCode, "clusterUnreachable");
    assert.equal(result.error, undefined);
    assert.equal(blob.includes("memcache"), false);
    assert.equal(blob.includes("connection refused"), false);
    assert.match(logged.join("\n"), /connection refused/);
  } finally {
    console.error = original;
  }
});

test("namespaces keep Forbidden text for the namespace fallback", async () => {
  const api = createKubectlOpsApi({
    execOnSession: async () => ({
      success: true,
      stdout: "",
      stderr: 'Error from server (Forbidden): namespaces is forbidden: User "view" cannot list resource "namespaces"',
      code: 1,
    }),
    isLocalSession: () => false,
    process: { platform: "linux" },
  });

  const result = await api.run(null, {
    sessionId: "s1",
    op: "namespaces",
    context: "prod",
  });

  assert.equal(result.success, false);
  assert.equal(result.errorCode, undefined);
  assert.match(result.error, /\bForbidden\b/);
});
