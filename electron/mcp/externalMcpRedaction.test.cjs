"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createRedactionSession, normalizeRedactionConfig } = require("./externalMcpRedaction.cjs");

const TOKEN = /^\[NC_[a-f0-9]{12}_(?:IP|HOST|SECRET)_\d+\]$/;
const enabledSession = (config = {}) => createRedactionSession({ enabled: true, ...config });

test("policy defaults are disabled, strict, copied, and errors never include the input", () => {
  assert.deepEqual(normalizeRedactionConfig(), {
    enabled: false, redactPrivateIps: false, cidrs: [], patterns: [],
  });
  const input = { enabled: true, patterns: ["synthetic-[0-9]+"], cidrs: ["10.0.0.0/8", "fc00::/7"] };
  const config = normalizeRedactionConfig(input);
  input.patterns.push("changed");
  assert.deepEqual(config.patterns, ["synthetic-[0-9]+"]);
  for (const invalid of [
    null, [], true, "sensitive-invalid-config", { enabled: "true" },
    { redactPrivateIps: 1 }, { surprise: "sensitive-invalid-config" },
    { cidrs: "10.0.0.0/8" }, { cidrs: ["1.2.3.4/33"] },
    { cidrs: ["::1/129"] }, { cidrs: ["::1%eth0/64"] }, { cidrs: ["10.0.0.0/08"] },
    { cidrs: ["not-an-address/8"] }, { patterns: [""] }, { patterns: [1] },
    { patterns: ["(?=unsupported)"] }, { patterns: ["(secret)\\1"] },
    { patterns: ["("] }, { patterns: ["a*"] }, { patterns: ["^"] },
    { patterns: Array(101).fill("value") },
  ]) {
    assert.throws(() => normalizeRedactionConfig(invalid),
      { message: "Invalid External MCP redaction configuration" });
  }
});

test("disabled policy leaves inputs and reserved text alone", () => {
  const session = createRedactionSession();
  const value = { password: "synthetic-password", content: "[NC_other_SECRET_1] 8.8.8.8" };
  assert.equal(session.redact(value), value);
  assert.equal(session.restore(value), value);
});

test("optional undefined RPC object members are omitted and array slots normalize to null", () => {
  const session = enabledSession();
  const params = { chatSessionId: "external", filePath: "/synthetic.txt", filename: undefined };
  assert.deepEqual(session.restore(params), { chatSessionId: "external", filePath: "/synthetic.txt" });
  assert.equal(Object.hasOwn(params, "filename"), true);
  const result = {
    filePath: "/synthetic.txt", filename: undefined, base64Data: undefined,
    mimeType: "text/plain", content: "8.8.8.8", optional: [undefined, , "text"],
  };
  const masked = session.redact(result);
  assert.equal(Object.hasOwn(masked, "filename"), false);
  assert.equal(Object.hasOwn(masked, "base64Data"), false);
  assert.match(masked.content, TOKEN);
  assert.deepEqual(masked.optional, [null, null, "text"]);
  assert.deepEqual(session.restore(masked), JSON.parse(JSON.stringify(result)));
  assert.equal(Object.hasOwn(result, "filename"), true);
  assert.equal(result.optional[0], undefined);
});

test("recursive transforms include object keys, preserve JSON types, and do not mutate sources", () => {
  const session = enabledSession();
  const source = {
    "8.8.8.8": [{ host: "build.example.test", password: "synthetic-pass" }, null, 42, false],
    empty: "", password: "", apiKey: null, tokenCount: 123,
  };
  const snapshot = structuredClone(source);
  const redacted = session.redact(source);
  assert.notEqual(redacted, source);
  assert.equal(Object.keys(redacted).some((key) => key === "8.8.8.8"), false);
  assert.equal(JSON.stringify(redacted).includes("synthetic-pass"), false);
  assert.equal(redacted.tokenCount, 123);
  assert.equal(redacted.empty, "");
  assert.equal(redacted.password, "");
  assert.equal(redacted.apiKey, null);
  assert.deepEqual(source, snapshot);
  assert.deepEqual(session.restore(redacted), source);
  assert.deepEqual(source, snapshot);
});

test("RPC root keys can be preserved without exempting nested user keys or secret field values", () => {
  const session = enabledSession();
  const source = {
    stdout: "password=stdout\nimportant output", stderr: "", exitCode: 0,
    password: "synthetic-root-secret", details: { stdout: "nested user key", "8.8.8.8": "address key" },
  };
  const result = session.redact(source, { preserveRootKeys: true });
  assert.deepEqual(Object.keys(result), Object.keys(source));
  assert.match(result.stdout, /^password=\[NC_[^\]]+\]\nimportant output$/);
  assert.match(result.password, TOKEN);
  assert.equal(Object.hasOwn(result.details, "stdout"), false);
  assert.equal(Object.hasOwn(result.details, "8.8.8.8"), false);
  assert.deepEqual(session.restore(result), source);
  assert.equal(Object.hasOwn(session.redact(source), "stdout"), false);
  assert.equal(source.stdout, "password=stdout\nimportant output");
});

test("same-session values are stable; separate sessions have different token namespaces", () => {
  const one = enabledSession();
  const two = enabledSession();
  const a = one.redact("8.8.8.8");
  assert.match(a, TOKEN);
  assert.equal(one.redact("8.8.8.8"), a);
  assert.notEqual(two.redact("8.8.8.8"), a);
  assert.throws(() => two.restore(a), /Unknown External MCP redaction token/);
  assert.deepEqual(Object.keys(one).sort(), ["redact", "restore"]);
});

test("public IPv4 and IPv6 are hidden, including bracketed addresses and IPv4-mapped IPv6", () => {
  const session = enabledSession();
  for (const address of [
    "8.8.8.8", "203.0.113.14", "2001:4860:4860::8888", "2001:DB8::AbCd",
    "::ffff:8.8.8.8", "::ffff:808:808",
  ]) {
    const masked = session.redact(address);
    assert.match(masked, TOKEN, address);
    assert.match(masked, /_IP_/);
    assert.equal(session.restore(masked), address);
  }
  const url = "https://[2001:db8::1234]:443/path";
  const masked = session.redact(url);
  assert.match(masked, /^https:\/\/\[\[NC_[^\]]+_IP_\d+\]\]:443\/path$/);
  assert.equal(session.restore(masked), url);
  assert.equal(session.redact("invalid 999.999.999.999 and 1.2.3.4.5"), "invalid 999.999.999.999 and 1.2.3.4.5");
});

test("private, loopback, link-local, CGNAT, and mapped private addresses are preserved by default", () => {
  const session = enabledSession();
  for (const address of [
    "10.2.3.4", "172.16.0.1", "172.31.255.255", "192.168.1.1", "127.0.0.1",
    "169.254.12.9", "100.64.0.1", "100.127.255.254", "::", "::1",
    "fd12:3456::1", "fc00::5", "fe80::cafe%eth0", "::ffff:10.0.0.1", "::ffff:7f00:1",
  ]) {
    assert.equal(session.redact(address), address);
    assert.deepEqual(session.redact({ host: address }), { host: address });
  }
  assert.match(session.redact("100.128.0.1"), TOKEN);
  assert.match(session.redact("172.32.0.1"), TOKEN);
});

test("private-address switch and CIDR opt-ins handle IPv4, IPv6, and zone spelling", () => {
  const all = enabledSession({ redactPrivateIps: true });
  for (const address of ["10.0.0.1", "::1", "fe80::1%eth0", "::ffff:10.0.0.1"]) {
    const token = all.redact(address);
    assert.match(token, TOKEN);
    assert.equal(all.restore(token), address);
  }
  const scoped = enabledSession({ cidrs: ["10.4.0.0/16", "fd12:3456::/32"] });
  assert.match(scoped.redact("10.4.1.8"), TOKEN);
  assert.equal(scoped.redact("10.5.1.8"), "10.5.1.8");
  assert.match(scoped.redact("fd12:3456:abcd::8"), TOKEN);
  assert.equal(scoped.redact("fd12:3457::8"), "fd12:3457::8");
});

test("hostnames require structured host/address context, not arbitrary dotted words", () => {
  const session = enabledSession();
  const source = {
    hostname: "build.internal.test", address: "ssh.example.test:2222",
    remoteHost: "ubuntu", endpoint: "https://api.example.test/path?q=1",
    description: "README.md and foo.example.test are ordinary prose",
  };
  const masked = session.redact(source);
  assert.match(masked.hostname, /_HOST_/);
  assert.match(masked.address, /_HOST_\d+\]:2222$/);
  assert.match(masked.remoteHost, /_HOST_/);
  assert.match(masked.endpoint, /^https:\/\/\[NC_[^\]]+_HOST_\d+\]\/path\?q=1$/);
  assert.equal(masked.description, source.description);
  assert.deepEqual(session.restore(masked), source);
  assert.match(session.redact('hostname = "build.internal.test"'), /^hostname = "\[NC_/);
  assert.equal(session.redact({ host: "not a hostname" }).host, "not a hostname");
});

test("credential recognizers preserve separators, quotes, whitespace, and escaped JSON contents", () => {
  const session = enabledSession();
  const values = [
    'PASSWORD \t= \t"synthetic pass\\"with quote"; unchanged',
    "api_key: 'synthetic\\\\escaped-value'",
    '{"password" : "synthetic\\nline\\tvalue", "ok": true}',
    'message = "password = \'synthetic-inner-quoted-value\'"',
    "token = synthetic_assignment_value; tokenCount=91",
    "curl --password  'synthetic cli pass' --api-key=synthetic_cli_key",
    "Authorization: Bearer \t SYNTHETIC_bearer_12345678",
    "https://alice:synthetic-url-password@service.example.test/path",
    "ghp_SYNTHETIC0000000000000000000001",
    "sk-SYNTHETIC0000000000000000000002",
  ];
  for (const value of values) {
    const masked = session.redact(value);
    assert.notEqual(masked, value, value);
    assert.equal(session.restore(masked), value);
  }
  assert.equal(session.redact('password = ""'), 'password = ""');
  assert.equal(session.redact("password = null"), "password = null");
  assert.equal(session.redact("tokenCount = 91; authType = bearer"), "tokenCount = 91; authType = bearer");
});

test("PEM private key blocks are a single secret, including every header and footer", () => {
  const session = enabledSession();
  const key = "-----BEGIN OPENSSH PRIVATE KEY-----\nSYNTHETIC-ONLY-NOT-A-KEY\n-----END OPENSSH PRIVATE KEY-----";
  const result = session.redact(`before\n${key}\nafter`);
  assert.match(result, /^before\n\[NC_[a-f0-9]+_SECRET_\d+\]\nafter$/);
  assert.equal(session.restore(result), `before\n${key}\nafter`);
});

test("repeated credentials are masked even before their defining field and in later responses", () => {
  const session = enabledSession();
  const source = { echo: "synthetic-repeat", password: "synthetic-repeat", nested: ["synthetic-repeat"] };
  const masked = session.redact(source);
  assert.match(masked.password, TOKEN);
  assert.equal(masked.echo, masked.password);
  assert.equal(masked.nested[0], masked.password);
  assert.equal(session.redact("echo synthetic-repeat"), `echo ${masked.password}`);
  assert.deepEqual(session.restore(masked), source);
});

test("known host literals repeat across free text without matching ordinary-word substrings", () => {
  const session = enabledSession();
  const source = {
    before: "connect to db or build.example.test",
    hostname: "db",
    nested: { host: "build.example.test" },
  };
  const masked = session.redact(source);
  assert.equal(masked.before, `connect to ${masked.hostname} or ${masked.nested.host}`);
  assert.equal(session.redact("ssh db; ping build.example.test"),
    `ssh ${masked.hostname}; ping ${masked.nested.host}`);
  assert.equal(session.redact("dbx adb db.internal build.example.test.other"),
    "dbx adb db.internal build.example.test.other");
  assert.deepEqual(session.restore(masked), source);
});

test("managed boundaries can preserve known aliases without changing external literal-token behavior", () => {
  const session = enabledSession();
  const source = { host: "db", password: 123456, secret: false, text: "8.8.8.8" };
  const aliases = session.redact(source);
  assert.deepEqual(session.redact(aliases, { acceptExistingTokens: true }), aliases);
  const repeated = { text: `${aliases.host} ${aliases.password} ${aliases.secret} ${aliases.text}` };
  assert.deepEqual(session.redact(repeated, { acceptExistingTokens: true }), repeated);
  assert.equal(session.redact(aliases.password, { acceptExistingTokens: true }), aliases.password);
  assert.equal(session.restore(aliases.password), 123456);
  assert.equal(session.restore(aliases.secret), false);
  assert.notEqual(session.redact(aliases.host), aliases.host);
  assert.throws(() => session.redact("[NC_unknown_HOST_1]", { acceptExistingTokens: true }),
    /Unknown External MCP redaction token/);
  assert.throws(() => session.redact("[NC_unclosed", { acceptExistingTokens: true }),
    /Unknown External MCP redaction token/);
});

test("managed aliases stay intact alongside new secrets and do not become learned secrets", () => {
  const session = enabledSession();
  const token = session.redact("8.8.8.8");
  const mixed = session.redact({ password: `fresh-secret ${token} another-secret`, text: token },
    { acceptExistingTokens: true });
  assert.equal(mixed.text, token);
  assert.equal(mixed.password.includes(token), true);
  assert.equal(mixed.password.includes("fresh-secret"), false);
  assert.deepEqual(session.restore(mixed), { password: "fresh-secret 8.8.8.8 another-secret", text: "8.8.8.8" });
  assert.equal(session.redact(token, { acceptExistingTokens: true }), token);
});

test("managed aliases do not break credential or custom-pattern context around raw fragments", () => {
  const session = enabledSession({ patterns: ["SENSITIVE-BEGIN[\\s\\S]*?SENSITIVE-END"] });
  const token = session.redact("8.8.8.8");
  for (const source of [
    `password=raw-prefix${token}raw-suffix`,
    `--password 'quoted-prefix${token}quoted-suffix'`,
    `SENSITIVE-BEGIN${token}SENSITIVE-END`,
  ]) {
    const masked = session.redact(source, { acceptExistingTokens: true });
    assert.equal(masked.includes(token), true);
    assert.equal(masked.includes("raw-prefix"), false);
    assert.equal(masked.includes("raw-suffix"), false);
    assert.equal(masked.includes("quoted-prefix"), false);
    assert.equal(masked.includes("quoted-suffix"), false);
    assert.equal(masked.includes("SENSITIVE-BEGIN"), false);
    assert.equal(masked.includes("SENSITIVE-END"), false);
    assert.equal(session.restore(masked), source.replace(token, "8.8.8.8"));
  }
});

test("a value keeps its first token even when later recognized in a different namespace", () => {
  const session = enabledSession();
  const ip = session.redact("8.8.8.8");
  assert.equal(session.redact({ password: "8.8.8.8" }).password, ip);
  const host = session.redact({ host: "synthetic.example.test" }).host;
  assert.equal(session.redact({ secret: "synthetic.example.test" }).secret, host);
});

test("structured numeric and nested credentials restore their original types", () => {
  const session = enabledSession();
  const source = { token: 123456, credentials: { password: "synthetic-nested", values: ["synthetic-value"] }, tokenCount: 123456 };
  const result = session.redact(source);
  assert.match(result.token, TOKEN);
  assert.equal(result.tokenCount, 123456);
  assert.deepEqual(session.restore(result), source);
});

test("custom RE2 patterns redact whole matches, including across lines and overlapping defaults", () => {
  const session = enabledSession({ patterns: ["ACCOUNT-[0-9]+", "BEGIN[\\s\\S]*?END", "address=8\\.8\\.8\\.8"] });
  const source = "ACCOUNT-123 and ACCOUNT-123; BEGIN\nsynthetic\nEND; address=8.8.8.8";
  const result = session.redact(source);
  assert.equal(result.includes("ACCOUNT-123"), false);
  assert.equal(result.includes("BEGIN"), false);
  assert.equal(result.includes("address="), false);
  assert.equal(session.restore(result), source);
  assert.equal(session.redact(""), "");
});

test("literal reserved tokens are escaped and restoration never rescans replacement text", () => {
  const session = enabledSession();
  const issued = session.redact("8.8.8.8");
  for (const literal of [
    "[NC_deadbeef0000_IP_1]", "[NC_other_SECRET_123]", "[NC_invalid]", "[NC_unclosed", issued,
  ]) {
    const escaped = session.redact(`literal=${literal}`);
    assert.equal(escaped.includes(literal), false);
    assert.equal(session.restore(escaped), `literal=${literal}`);
  }
  const escapedActual = session.redact(issued);
  assert.notEqual(escapedActual, issued);
  assert.equal(session.restore(escapedActual), issued);
  assert.equal(session.restore(issued), "8.8.8.8");
});

test("unknown, modified, cross-session tokens and tokens in object keys fail closed", () => {
  const session = enabledSession();
  const issued = session.redact("8.8.8.8");
  for (const unknown of [
    "[NC_unknown_IP_1]", "[NC_unclosed", issued.replace("_IP_", "_HOST_"), `${issued.slice(0, -1)}0]`,
  ]) {
    assert.throws(() => session.restore(`ping ${unknown}`), /Unknown External MCP redaction token/);
    assert.throws(() => session.restore({ [unknown]: "test" }), /Unknown External MCP redaction token/);
  }
});

test("restored object-key collisions fail closed and prototype-shaped keys remain plain data", () => {
  const session = enabledSession();
  const token = session.redact("8.8.8.8");
  assert.throws(() => session.restore({ [token]: 1, "8.8.8.8": 2 }), /could not safely process/);
  const source = JSON.parse('{"__proto__": "8.8.8.8", "constructor": "normal"}');
  const result = session.restore(session.redact(source));
  assert.deepEqual(result, source);
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  assert.equal(Object.hasOwn(result, "__proto__"), true);
});

test("nontext attachments and non-JSON data fail closed, while ordinary text attachments work", () => {
  const session = enabledSession();
  for (const source of [
    { base64Data: "U1lOVEhFVElD" },
    { content: [{ type: "image", data: "U1lOVEhFVElD", mimeType: "image/png" }] },
    { content: [{ type: "audio", data: "U1lOVEhFVElD", mimeType: "audio/wav" }] },
    { resource: { blob: "U1lOVEhFVElD", mimeType: "application/octet-stream" } },
    { data: "U1lOVEhFVElD", mimeType: "application/pdf" },
    "binary\0text", Buffer.from("synthetic"), new Date(), undefined, Number.NaN,
  ]) {
    assert.throws(() => session.redact(source), { message: "External MCP redaction could not safely process this value" });
  }
  const text = { content: [{ type: "text", text: "8.8.8.8" }], mimeType: "text/plain" };
  assert.deepEqual(session.restore(session.redact(text)), text);
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => session.redact(cyclic), /could not safely process/);
});

test("session growth fails closed without evicting or reassigning tokens", () => {
  const session = enabledSession();
  const first = session.redact("8.8.8.8");
  const many = Array.from({ length: 10001 }, (_, index) => ({ hostname: `host-${index}.example.test` }));
  assert.throws(() => session.redact(many), {
    message: "External MCP redaction session limit reached; reconnect the client",
  });
  assert.throws(() => session.redact("8.8.8.8"), /session limit reached/);
  assert.throws(() => session.restore(first), /session limit reached/);
});

test("large ordinary strings and bounded RE2 nested quantifiers do not use backtracking scans", () => {
  const session = enabledSession({ patterns: ["(a+)+$"] });
  const source = `${"a".repeat(50000)}!`;
  assert.equal(session.redact(source), source);
  assert.equal(session.restore(source), source);
});
