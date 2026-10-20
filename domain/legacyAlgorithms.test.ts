import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeHost } from "./host.ts";
import {
  prepareConnectionHost,
  resolveConnectionLegacyAlgorithms,
} from "./legacyAlgorithms.ts";
import { normalizeTerminalSettings } from "./models/terminal.ts";
import type { Host } from "./models.ts";

const host = (overrides: Partial<Host> = {}): Host => ({
  id: "host-1",
  label: "host",
  hostname: "bastion.example",
  username: "root",
  tags: [],
  os: "linux",
  protocol: "ssh",
  ...overrides,
});

test("a saved host uses its per-host legacy algorithm value when the global setting is on", () => {
  const saved = host({
    hostname: "127.0.0.1",
    port: 2222,
    legacyAlgorithms: false,
  });

  assert.equal(prepareConnectionHost(saved, true), saved);
  assert.equal(resolveConnectionLegacyAlgorithms({
    hasSavedHost: true,
    hostLegacyAlgorithms: false,
    temporaryConnectionsAllowLegacyAlgorithms: true,
  }), false);
});

test("a saved host keeps legacy algorithms enabled when the global setting is off", () => {
  const saved = host({ legacyAlgorithms: true });

  assert.equal(prepareConnectionHost(saved, false), saved);
  assert.equal(resolveConnectionLegacyAlgorithms({
    hasSavedHost: true,
    hostLegacyAlgorithms: true,
    temporaryConnectionsAllowLegacyAlgorithms: false,
  }), true);
});

test("a saved host with no explicit value does not inherit the global temporary setting", () => {
  const saved = host({ hostname: "127.0.0.1", legacyAlgorithms: undefined });

  assert.equal(prepareConnectionHost(saved, true), saved);
  assert.equal(resolveConnectionLegacyAlgorithms({
    hasSavedHost: true,
    hostLegacyAlgorithms: undefined,
    temporaryConnectionsAllowLegacyAlgorithms: true,
  }), false);
});

test("a temporary connection uses the global legacy algorithm value", () => {
  const temporary = host({
    id: "ephemeral-1",
    ephemeral: true,
    hostname: "127.0.0.1",
    port: 54321,
  });

  assert.equal(prepareConnectionHost(temporary, true).legacyAlgorithms, true);
  assert.equal(prepareConnectionHost(temporary, false).legacyAlgorithms, undefined);
  assert.equal(resolveConnectionLegacyAlgorithms({
    hasSavedHost: false,
    temporaryConnectionsAllowLegacyAlgorithms: true,
  }), true);
  assert.equal(resolveConnectionLegacyAlgorithms({
    hasSavedHost: false,
    hostLegacyAlgorithms: true,
    temporaryConnectionsAllowLegacyAlgorithms: false,
  }), false);
});

test("an ephemeral clone of a saved host keeps that host's legacy algorithm value", () => {
  const cloned = host({
    id: "ephemeral-from-saved",
    ephemeral: true,
    backedBySavedHost: true,
    hostname: "127.0.0.1",
    port: 61000,
    legacyAlgorithms: false,
  });

  assert.equal(prepareConnectionHost(cloned, true), cloned);
  assert.equal(prepareConnectionHost(host({
    ephemeral: true,
    backedBySavedHost: true,
    legacyAlgorithms: true,
  }), false).legacyAlgorithms, true);
});

test("temporary connection legacy algorithms default to off", () => {
  const temporary = host({ ephemeral: true, hostname: "127.0.0.1" });

  assert.equal(resolveConnectionLegacyAlgorithms({ hasSavedHost: false }), false);
  assert.equal(prepareConnectionHost(temporary).legacyAlgorithms, undefined);
  assert.equal(normalizeTerminalSettings().temporaryConnectionsAllowLegacyAlgorithms, false);
  assert.equal(
    normalizeTerminalSettings({ temporaryConnectionsAllowLegacyAlgorithms: true })
      .temporaryConnectionsAllowLegacyAlgorithms,
    true,
  );
  assert.equal(
    normalizeTerminalSettings({
      temporaryConnectionsAllowLegacyAlgorithms: "yes" as never,
    }).temporaryConnectionsAllowLegacyAlgorithms,
    false,
  );
});

test("saved-host clones do not persist the runtime backing marker", () => {
  const sanitized = sanitizeHost(host({
    ephemeral: true,
    backedBySavedHost: true,
    legacyAlgorithms: true,
  }));

  assert.equal("backedBySavedHost" in sanitized, false);
  assert.equal(sanitized.legacyAlgorithms, true);
});

test("temporary telnet connections do not receive the SSH legacy algorithm flag", () => {
  const telnet = host({
    ephemeral: true,
    protocol: "telnet",
    hostname: "127.0.0.1",
  });

  assert.equal(prepareConnectionHost(telnet, true), telnet);
});
