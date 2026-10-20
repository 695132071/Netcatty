import assert from "node:assert/strict";
import test from "node:test";

import {
  prepareConnectionHost,
  temporaryConnectionPrepareOptions,
} from "./legacyAlgorithms.ts";
import { normalizeTerminalSettings } from "./models/terminal.ts";
import type { Host } from "./models.ts";
import { buildQuickConnectHost } from "./quickConnectHost.ts";

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

test("a saved host keeps its own device type when temporary network device mode is on", () => {
  const saved = host({
    hostname: "10.0.0.8",
    deviceType: "general",
  });
  const unset = host({ hostname: "10.0.0.9" });
  const network = host({ hostname: "10.0.0.10", deviceType: "network" });

  assert.equal(prepareConnectionHost(saved, {
    temporaryConnectionsNetworkDeviceMode: true,
  }), saved);
  assert.equal(prepareConnectionHost(unset, {
    temporaryConnectionsNetworkDeviceMode: true,
  }), unset);
  assert.equal(prepareConnectionHost(network, {
    temporaryConnectionsNetworkDeviceMode: true,
  }), network);
});

test("an ephemeral clone of a saved host keeps that host's device type", () => {
  const cloned = host({
    id: "ephemeral-from-saved",
    ephemeral: true,
    backedBySavedHost: true,
    hostname: "10.0.0.8",
    deviceType: "general",
  });

  assert.equal(prepareConnectionHost(cloned, {
    temporaryConnectionsNetworkDeviceMode: true,
  }), cloned);
  assert.equal(prepareConnectionHost(host({
    ephemeral: true,
    backedBySavedHost: true,
    deviceType: "network",
  }), {
    temporaryConnectionsNetworkDeviceMode: false,
  }).deviceType, "network");
});

test("a temporary SSH connection uses network device mode only when the setting is on", () => {
  const temporary = host({
    id: "ephemeral-1",
    ephemeral: true,
    hostname: "10.1.1.1",
    port: 22,
  });

  assert.equal(prepareConnectionHost(temporary, {
    temporaryConnectionsNetworkDeviceMode: true,
  }).deviceType, "network");
  assert.equal(prepareConnectionHost(temporary, {
    temporaryConnectionsNetworkDeviceMode: false,
  }), temporary);
  assert.equal(prepareConnectionHost(temporary).deviceType, undefined);
});

test("temporary network device mode does not clear an explicit device type when the setting is off", () => {
  const temporary = host({
    ephemeral: true,
    hostname: "10.1.1.1",
    deviceType: "network",
  });

  assert.equal(prepareConnectionHost(temporary, {
    temporaryConnectionsNetworkDeviceMode: false,
  }), temporary);
});

test("temporary network device mode can be combined with the legacy algorithm opt-in", () => {
  const temporary = host({
    ephemeral: true,
    hostname: "192.0.2.10",
  });

  const prepared = prepareConnectionHost(temporary, {
    temporaryConnectionsAllowLegacyAlgorithms: true,
    temporaryConnectionsNetworkDeviceMode: true,
  });

  assert.equal(prepared.legacyAlgorithms, true);
  assert.equal(prepared.deviceType, "network");
  assert.equal(prepared.hostname, "192.0.2.10");
});

test("temporary Mosh and ET connections do not receive network device mode", () => {
  const mosh = host({
    ephemeral: true,
    protocol: "ssh",
    moshEnabled: true,
    hostname: "10.1.1.1",
  });
  const et = host({
    ephemeral: true,
    protocol: "ssh",
    etEnabled: true,
    hostname: "10.1.1.1",
  });
  const options = {
    temporaryConnectionsAllowLegacyAlgorithms: true,
    temporaryConnectionsNetworkDeviceMode: true,
  };

  assert.equal(prepareConnectionHost(mosh, options).deviceType, undefined);
  assert.equal(prepareConnectionHost(mosh, options).legacyAlgorithms, true);
  assert.equal(prepareConnectionHost(et, options).deviceType, undefined);
  assert.equal(prepareConnectionHost(et, options).legacyAlgorithms, true);
});

test("temporary telnet connections do not receive network device mode", () => {
  const telnet = host({
    ephemeral: true,
    protocol: "telnet",
    hostname: "10.1.1.1",
  });

  assert.equal(prepareConnectionHost(telnet, {
    temporaryConnectionsNetworkDeviceMode: true,
  }), telnet);
});

test("an unsaved quick connect host receives temporary connection defaults", () => {
  const quickHost = buildQuickConnectHost({
    id: "quick-1",
    createdAt: 1,
    target: { hostname: "10.1.1.1" },
    protocol: "ssh",
    port: 22,
    username: "admin",
    authMethod: "password",
    password: "secret",
  });

  const prepared = prepareConnectionHost(quickHost, {
    temporaryConnectionsAllowLegacyAlgorithms: true,
    temporaryConnectionsNetworkDeviceMode: true,
  });
  const saved = prepareConnectionHost({ ...quickHost, ephemeral: false }, {
    temporaryConnectionsAllowLegacyAlgorithms: true,
    temporaryConnectionsNetworkDeviceMode: true,
  });

  assert.equal(prepared.ephemeral, true);
  assert.equal(prepared.legacyAlgorithms, true);
  assert.equal(prepared.deviceType, "network");
  assert.equal(saved.deviceType, undefined);
  assert.equal(saved.legacyAlgorithms, undefined);
});

test("temporary connection toggles are read from the settings object at connect time", () => {
  const settings = {
    temporaryConnectionsAllowLegacyAlgorithms: false,
    temporaryConnectionsNetworkDeviceMode: false,
  };
  const temporary = host({
    id: "ephemeral-live",
    ephemeral: true,
    hostname: "10.9.9.9",
  });
  const connect = () => prepareConnectionHost(
    temporary,
    temporaryConnectionPrepareOptions(settings),
  );

  assert.equal(connect(), temporary);

  settings.temporaryConnectionsNetworkDeviceMode = true;
  settings.temporaryConnectionsAllowLegacyAlgorithms = true;
  const enabled = connect();
  assert.equal(enabled.deviceType, "network");
  assert.equal(enabled.legacyAlgorithms, true);

  settings.temporaryConnectionsNetworkDeviceMode = false;
  settings.temporaryConnectionsAllowLegacyAlgorithms = false;
  assert.equal(connect(), temporary);
});

test("temporary connection network device mode defaults to off", () => {
  assert.equal(normalizeTerminalSettings().temporaryConnectionsNetworkDeviceMode, false);
  assert.equal(
    normalizeTerminalSettings({ temporaryConnectionsNetworkDeviceMode: true })
      .temporaryConnectionsNetworkDeviceMode,
    true,
  );
  assert.equal(
    normalizeTerminalSettings({
      temporaryConnectionsNetworkDeviceMode: "yes" as never,
    }).temporaryConnectionsNetworkDeviceMode,
    false,
  );
});
