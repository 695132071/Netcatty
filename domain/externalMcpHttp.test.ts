import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import {
  DEFAULT_EXTERNAL_MCP_HTTP_PORT,
  buildClaudeHttpAddCommand,
  buildCodexHttpEnvLine,
  buildCodexHttpToml,
  buildExternalMcpHttpUrl,
  buildGenericHttpMcpJson,
} from "./externalMcpHttp.ts";

const require = createRequire(import.meta.url);
const security = require("../electron/bridges/externalMcp/httpSecurity.cjs");

test("HTTP client URL stays on loopback unless a specific listen address is set", () => {
  assert.equal(DEFAULT_EXTERNAL_MCP_HTTP_PORT, security.DEFAULT_EXTERNAL_MCP_HTTP_PORT);
  assert.equal(
    buildExternalMcpHttpUrl("127.0.0.1", 47391),
    "http://127.0.0.1:47391/mcp",
  );
  assert.equal(buildExternalMcpHttpUrl("0.0.0.0", 47391), "");
  assert.equal(
    buildExternalMcpHttpUrl("0.0.0.0", 47391, "172.22.0.1"),
    "http://172.22.0.1:47391/mcp",
  );
  assert.equal(
    buildExternalMcpHttpUrl("172.22.0.1", 47391),
    "http://172.22.0.1:47391/mcp",
  );
});

test("HTTP snippets use Codex env bearer form, Claude http transport, and generic JSON", () => {
  const url = "http://127.0.0.1:47391/mcp";
  const token = "abc123";
  const toml = buildCodexHttpToml(url);
  assert.match(toml, /\[mcp_servers\.netcatty-http\]/);
  assert.match(toml, /url = "http:\/\/127\.0\.0\.1:47391\/mcp"/);
  assert.match(toml, /bearer_token_env_var = "NETCATTY_MCP_BEARER_TOKEN"/);
  assert.equal(buildCodexHttpEnvLine(token), "export NETCATTY_MCP_BEARER_TOKEN='abc123'");
  assert.equal(
    buildCodexHttpEnvLine("a'b"),
    "export NETCATTY_MCP_BEARER_TOKEN='a'\\''b'",
  );
  assert.equal(
    buildClaudeHttpAddCommand(url, token),
    "claude mcp add --transport http netcatty-http 'http://127.0.0.1:47391/mcp' --header 'Authorization: Bearer abc123'",
  );
  const generic = JSON.parse(buildGenericHttpMcpJson(url, token));
  assert.equal(generic.mcpServers["netcatty-http"].type, "http");
  assert.equal(generic.mcpServers["netcatty-http"].url, url);
  assert.equal(generic.mcpServers["netcatty-http"].headers.Authorization, "Bearer abc123");
});
