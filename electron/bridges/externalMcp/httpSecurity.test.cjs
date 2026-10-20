"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  DEFAULT_EXTERNAL_MCP_HTTP_PORT,
  buildClientUrl,
  normalizeHttpPort,
  normalizeListenAddress,
  readBearerToken,
  resolveEffectiveListenAddress,
  tokensEqual,
  validateRequestHeaders,
} = require("./httpSecurity.cjs");

describe("external MCP HTTP security", () => {
  it("keeps an unlikely fixed default port and rejects privileged or empty ports", () => {
    assert.equal(DEFAULT_EXTERNAL_MCP_HTTP_PORT, 47391);
    assert.equal(normalizeHttpPort(47391).port, 47391);
    assert.equal(normalizeHttpPort("8080").port, 8080);
    assert.equal(normalizeHttpPort(80).ok, false);
    assert.equal(normalizeHttpPort(0).ok, false);
    assert.equal(normalizeHttpPort("").ok, false);
    assert.equal(normalizeHttpPort(65536).errorCode, "invalid_port");
  });

  it("binds loopback unless the custom address option is explicit", () => {
    assert.equal(resolveEffectiveListenAddress({
      allowCustomBind: false,
      listenAddress: "0.0.0.0",
    }), "127.0.0.1");
    assert.equal(resolveEffectiveListenAddress({
      allowCustomBind: true,
      listenAddress: "0.0.0.0",
    }), "0.0.0.0");
    assert.equal(resolveEffectiveListenAddress({
      allowCustomBind: true,
      listenAddress: "172.22.0.1",
    }), "172.22.0.1");
    assert.equal(normalizeListenAddress("windows-host").ok, false);
    assert.throws(
      () => resolveEffectiveListenAddress({ allowCustomBind: true, listenAddress: "localhost" }),
      (error) => error.code === "INVALID_ADDRESS",
    );
  });

  it("does not advertise loopback for a wildcard bind", () => {
    assert.equal(buildClientUrl("0.0.0.0", 47391), null);
    assert.equal(buildClientUrl("::", 47391, "127.0.0.1"), "http://127.0.0.1:47391/mcp");
    assert.equal(buildClientUrl("0.0.0.0", 47391, "172.22.0.1"), "http://172.22.0.1:47391/mcp");
    assert.equal(buildClientUrl("0.0.0.0", 47391, "0.0.0.0"), null);
    assert.equal(buildClientUrl("172.22.0.1", 47391), "http://172.22.0.1:47391/mcp");
  });

  it("accepts only an exact bearer token", () => {
    assert.equal(readBearerToken("Bearer secret-token"), "secret-token");
    assert.equal(readBearerToken("bearer secret-token"), "secret-token");
    assert.equal(readBearerToken("Basic secret-token"), "");
    assert.equal(readBearerToken("Bearer"), "");
    assert.equal(tokensEqual("secret-token", "secret-token"), true);
    assert.equal(tokensEqual("wrong", "secret-token"), false);
    assert.equal(tokensEqual("", "secret-token"), false);
    assert.equal(tokensEqual("secret-token", ""), false);
  });

  it("rejects DNS-rebinding host and origin values", () => {
    const base = { listenAddress: "127.0.0.1", port: 47391 };
    assert.equal(validateRequestHeaders({
      ...base,
      hostHeader: "127.0.0.1:47391",
      originHeader: undefined,
    }).ok, true);
    assert.equal(validateRequestHeaders({
      ...base,
      hostHeader: "localhost:47391",
      originHeader: "http://localhost:6274",
    }).ok, true);
    assert.equal(validateRequestHeaders({
      ...base,
      hostHeader: "evil.example:47391",
      originHeader: undefined,
    }).status, 421);
    assert.equal(validateRequestHeaders({
      ...base,
      hostHeader: "127.0.0.1:47391",
      originHeader: "https://evil.example",
    }).status, 403);
    assert.equal(validateRequestHeaders({
      ...base,
      hostHeader: "127.0.0.1:80",
      originHeader: undefined,
    }).status, 421);
    assert.equal(validateRequestHeaders({
      ...base,
      hostHeader: "",
      originHeader: undefined,
    }).status, 421);

    assert.equal(validateRequestHeaders({
      listenAddress: "0.0.0.0",
      port: 47391,
      hostHeader: "172.22.0.1:47391",
      originHeader: undefined,
    }).ok, true);
    assert.equal(validateRequestHeaders({
      listenAddress: "0.0.0.0",
      port: 47391,
      hostHeader: "evil.example:47391",
      originHeader: undefined,
    }).status, 421);
    assert.equal(validateRequestHeaders({
      listenAddress: "172.22.0.1",
      port: 47391,
      hostHeader: "172.22.0.1:47391",
      originHeader: "http://172.22.0.1:6274",
    }).ok, true);
    assert.equal(validateRequestHeaders({
      listenAddress: "172.22.0.1",
      port: 47391,
      hostHeader: "8.8.8.8:47391",
      originHeader: undefined,
    }).status, 421);
    assert.equal(validateRequestHeaders({
      listenAddress: "::1",
      port: 47391,
      hostHeader: "[::1]:47391",
      originHeader: "http://[::1]:6274",
    }).ok, true);
    assert.equal(validateRequestHeaders({
      listenAddress: "::",
      port: 47391,
      hostHeader: "[2001:db8::1]:47391",
      originHeader: "http://[2001:db8::1]:6274",
    }).ok, true);
  });
});
