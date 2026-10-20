"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");

test("stdio External MCP preserves a read/write round trip without exposing original values", async () => {
  const calls = [];
  const files = new Map([["/first", "address=192.0.2.10\npassword=synthetic-only-secret"], ["/second", "198.51.100.7"]]);
  const sockets = new Set();
  const bridge = net.createServer(socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", chunk => {
      buffer += chunk;
      while (buffer.includes("\n")) {
        const end = buffer.indexOf("\n");
        const { id, method, params } = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        calls.push({ method, params });
        let result = { ok: true };
        if (method === "netcatty/sftp/read") result.content = files.get(params.path);
        if (method === "netcatty/sftp/write") files.set(params.path, params.content);
        if (method === "netcatty/getContext") result.hosts = [{ hostname: "private.example", address: "192.0.2.10" }];
        if (method === "netcatty/exec") result = { ok: true, stdout: params.command, exitCode: 0 };
        if (method.includes("readAttachment")) result = { ok: true, base64Data: "YmluYXJ5", mediaType: "image/png" };
        socket.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
      }
    });
  });
  await new Promise(resolve => bridge.listen(0, "127.0.0.1", resolve));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-mcp-privacy-"));
  const discovery = path.join(tmp, "discovery.json");
  fs.writeFileSync(discovery, JSON.stringify({ port: bridge.address().port, token: "synthetic-test-auth", redaction: { enabled: true } }));
  const client = new Client({ name: "privacy-test", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(__dirname, "netcatty-external-mcp-server.cjs")],
    env: { ...process.env, NETCATTY_EXTERNAL_MCP_DISCOVERY_FILE: discovery },
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    const read = async file => JSON.parse((await client.callTool({ name: "sftp_read_file", arguments: { sessionId: "s", path: file } })).content[0].text).content;
    const first = await read("/first");
    const second = await read("/second");
    assert.doesNotMatch(first, /192\.0\.2\.10|synthetic-only-secret/);
    assert.doesNotMatch(second, /198\.51\.100\.7/);
    assert.notEqual(first, second);
    assert.equal(await read("/first"), first);
    const write = await client.callTool({ name: "sftp_write_file", arguments: { sessionId: "s", path: "/copy", content: first } });
    assert.notEqual(write.isError, true);
    assert.equal(files.get("/copy"), files.get("/first"));
    const resource = await client.readResource({ uri: "netcatty://context" });
    assert.doesNotMatch(JSON.stringify(resource), /192\.0\.2\.10|private\.example/);
    const exec = await client.callTool({ name: "terminal_execute", arguments: { sessionId: "s", command: `echo ${second}` } });
    assert.equal(calls.findLast(call => call.method === "netcatty/exec").params.command, "echo 198.51.100.7");
    assert.doesNotMatch(JSON.stringify(exec), /198\.51\.100\.7/);
    const before = calls.length;
    const invalid = await client.callTool({ name: "terminal_execute", arguments: { sessionId: "s", command: "echo [NC_000000000000_IP_1]" } });
    assert.equal(invalid.isError, true);
    assert.equal(calls.length, before);
  } finally {
    await client.close();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => bridge.close(resolve));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
