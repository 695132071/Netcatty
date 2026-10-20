import assert from "node:assert/strict";
import test from "node:test";

import en from "./en.ts";
import ru from "./ru.ts";
import es from "./es.ts";
import zhCN from "./zh-CN.ts";
import zhTW from "./zh-TW.ts";

const KEYS = [
  "ai.externalMcp.http.title",
  "ai.externalMcp.http.description",
  "ai.externalMcp.http.enable",
  "ai.externalMcp.http.port",
  "ai.externalMcp.http.portHint",
  "ai.externalMcp.http.allowCustomBind",
  "ai.externalMcp.http.allowCustomBind.description",
  "ai.externalMcp.http.listenAddress",
  "ai.externalMcp.http.listenAddress.placeholder",
  "ai.externalMcp.http.clientHost",
  "ai.externalMcp.http.clientHost.description",
  "ai.externalMcp.http.clientHost.placeholder",
  "ai.externalMcp.http.clientHostRequired",
  "ai.externalMcp.http.invalidClientHost",
  "ai.externalMcp.http.warning",
  "ai.externalMcp.http.url",
  "ai.externalMcp.http.token",
  "ai.externalMcp.http.regenerate",
  "ai.externalMcp.http.regenerateHint",
  "ai.externalMcp.http.wslHint",
  "ai.externalMcp.http.codexSnippet",
  "ai.externalMcp.http.claudeCommand",
  "ai.externalMcp.http.genericSnippet",
  "ai.externalMcp.http.envLine",
  "ai.externalMcp.http.notListening",
  "ai.externalMcp.http.listening",
  "ai.externalMcp.http.portInUse",
  "ai.externalMcp.http.requiresExternalMcp",
  "ai.externalMcp.http.invalidPort",
  "ai.externalMcp.http.invalidAddress",
  "ai.externalMcp.http.listenFailed",
  "ai.externalMcp.http.legacySseNote",
] as const;

test("External MCP HTTP strings exist in every locale", () => {
  for (const [name, messages] of Object.entries({ en, es, "zh-CN": zhCN, "zh-TW": zhTW, ru })) {
    const missing = KEYS.filter((key) => !messages[key]);
    assert.deepEqual(missing, [], `${name} is missing HTTP MCP labels`);
    assert.match(messages["ai.externalMcp.http.portInUse"], /\{port\}/);
  }
  assert.match(zhTW["ai.externalMcp.http.port"], /連接埠/);
  assert.match(zhTW["ai.externalMcp.http.listenAddress"], /位址/);
  assert.match(zhTW["ai.externalMcp.http.clientHost"], /位址/);
  assert.doesNotMatch(zhTW["ai.externalMcp.http.clientHost"], /地址/);
  assert.doesNotMatch(zhTW["ai.externalMcp.http.port"], /端口/);
  assert.doesNotMatch(zhTW["ai.externalMcp.http.listenAddress"], /地址/);
  assert.match(zhTW["ai.externalMcp.http.wslHint"], /鏡像網路/);
});
