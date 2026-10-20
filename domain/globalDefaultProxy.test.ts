import assert from "node:assert/strict";
import test from "node:test";

import {
  clearActiveGlobalDefaultProxyProfile,
  getActiveGlobalDefaultProxyProfileId,
  publishActiveGlobalDefaultProxyProfileId,
  registerGlobalDefaultProxyProfileSetter,
} from "./globalDefaultProxy.ts";

test("clearing the global default uses the settings setter that is still mounted", () => {
  const writes: string[] = [];
  publishActiveGlobalDefaultProxyProfileId("profile-1");
  const unregisterGate = registerGlobalDefaultProxyProfileSetter((id) => {
    writes.push(`gate:${id ?? ""}`);
    publishActiveGlobalDefaultProxyProfileId(id);
  });
  const unregisterTab = registerGlobalDefaultProxyProfileSetter((id) => {
    writes.push(`tab:${id ?? ""}`);
    publishActiveGlobalDefaultProxyProfileId(id);
  });

  try {
    unregisterGate();
    clearActiveGlobalDefaultProxyProfile();
    assert.deepEqual(writes, ["tab:"]);
    assert.equal(getActiveGlobalDefaultProxyProfileId(), undefined);

    writes.length = 0;
    publishActiveGlobalDefaultProxyProfileId("profile-1");
    unregisterTab();
    const unregisterGateAgain = registerGlobalDefaultProxyProfileSetter((id) => {
      writes.push(`gate:${id ?? ""}`);
      publishActiveGlobalDefaultProxyProfileId(id);
    });
    try {
      clearActiveGlobalDefaultProxyProfile();
      assert.deepEqual(writes, ["gate:"]);
      assert.equal(getActiveGlobalDefaultProxyProfileId(), undefined);
    } finally {
      unregisterGateAgain();
    }

    publishActiveGlobalDefaultProxyProfileId("profile-1");
    clearActiveGlobalDefaultProxyProfile();
    assert.equal(getActiveGlobalDefaultProxyProfileId(), undefined);
    assert.deepEqual(writes, ["gate:"]);
  } finally {
    unregisterGate();
    unregisterTab();
    publishActiveGlobalDefaultProxyProfileId(undefined);
  }
});
