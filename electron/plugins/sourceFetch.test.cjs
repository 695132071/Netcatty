"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createSourceFetch, isPublicAddress } = require("./sourceFetch.cjs");

test("source transport refuses non-public resolution before any HTTP request", async () => {
  let requests = 0;
  for (const address of ["127.0.0.1", "10.1.2.3", "169.254.169.254", "172.16.1.1", "192.168.1.1", "100.64.1.1", "224.0.0.1", "::1", "::ffff:127.0.0.1"]) {
    assert.equal(isPublicAddress(address), false);
    const fetch = createSourceFetch("https://example.com", { resolve4: async () => [address], request() { requests++; } });
    await assert.rejects(fetch("https://example.com/v1/snapshot.json"), /non-public/);
  }
  assert.equal(requests, 0);
  assert.equal(isPublicAddress("1.1.1.1"), true);
});

test("static resources cannot redirect requests to unrelated origins or arbitrary paths", async () => {
  let resolutions = 0;
  const fetch = createSourceFetch("https://example.com", { resolve4: async () => { resolutions++; return ["1.1.1.1"]; } });
  for (const value of ["https://other.com/v1/snapshot.json", "https://example.com/admin", "https://example.com/assets/%2e%2e/secret", "https://example.com/v1/snapshot.json?token=secret", "https://user:pass@example.com/v1/snapshot.json"]) await assert.rejects(fetch(value));
  assert.equal(resolutions, 0);
});
