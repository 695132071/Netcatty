import assert from "node:assert/strict";
import test from "node:test";

import {
  openQuickConnectFromInput,
  registerQuickConnectOpener,
  type QuickConnectOpenRequest,
} from "./quickConnectBridge.ts";

test("openQuickConnectFromInput reuses the registered quick connect wizard", () => {
  const seen: QuickConnectOpenRequest[] = [];
  const unregister = registerQuickConnectOpener((request) => {
    seen.push(request);
  });

  assert.equal(openQuickConnectFromInput(" root@10.1.1.1:2222 "), true);
  assert.deepEqual(seen, [{
    target: { hostname: "10.1.1.1", username: "root", port: 2222 },
    warnings: [],
  }]);

  unregister();
  assert.equal(openQuickConnectFromInput("10.1.1.1"), false);
});

test("openQuickConnectFromInput ignores text that is not an address", () => {
  const seen: QuickConnectOpenRequest[] = [];
  const unregister = registerQuickConnectOpener((request) => {
    seen.push(request);
  });

  assert.equal(openQuickConnectFromInput("core switch"), false);
  assert.deepEqual(seen, []);
  unregister();
});
