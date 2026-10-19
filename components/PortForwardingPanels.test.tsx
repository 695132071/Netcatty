import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "../application/i18n/I18nProvider";
import type { Host, PortForwardingRule, PortForwardingType } from "../domain/models";
import { EditPanel } from "./port-forwarding/EditPanel";
import { NewFormPanel } from "./port-forwarding/NewFormPanel";
import { WizardContent } from "./port-forwarding/WizardContent";
import { TooltipProvider } from "./ui/tooltip";

const baseHost: Omit<Host, "os"> = {
  id: "host-1",
  label: "Forwarding host",
  hostname: "example.com",
  username: "user",
  tags: [],
};

const baseRule: PortForwardingRule = {
  id: "rule-1",
  label: "Test forwarding rule",
  type: "local",
  hostId: baseHost.id,
  localPort: 8080,
  bindAddress: "127.0.0.1",
  remoteHost: "localhost",
  remotePort: 80,
  status: "inactive",
  createdAt: 1,
};

const noop = () => undefined;
const panelRenderers = {
  edit: (hosts: Host[], draft: PortForwardingRule) => (
    <EditPanel
      rule={draft}
      draft={draft}
      hosts={hosts}
      onDraftChange={noop}
      onSave={noop}
      onClose={noop}
      onDuplicate={noop}
      onDelete={noop}
      onOpenHostSelector={noop}
    />
  ),
  new: (hosts: Host[], draft: PortForwardingRule) => (
    <NewFormPanel
      draft={draft}
      hosts={hosts}
      onDraftChange={noop}
      onSave={noop}
      onClose={noop}
      onOpenHostSelector={noop}
      onOpenWizard={noop}
      isValid={false}
    />
  ),
  "remote-host-selection": (hosts: Host[], draft: PortForwardingRule) => (
    <WizardContent
      step="remote-host-selection"
      type={draft.type}
      draft={draft}
      hosts={hosts}
      onTypeChange={noop}
      onDraftChange={noop}
      onOpenHostSelector={noop}
    />
  ),
  "host-selection": (hosts: Host[], draft: PortForwardingRule) => (
    <WizardContent
      step="host-selection"
      type={draft.type}
      draft={draft}
      hosts={hosts}
      onTypeChange={noop}
      onDraftChange={noop}
      onOpenHostSelector={noop}
    />
  ),
};

const hostCases: { name: string; fields: { os?: Host["os"] | "" | null } }[] = [
  { name: "missing OS", fields: {} },
  { name: "undefined OS", fields: { os: undefined } },
  { name: "null OS", fields: { os: null } },
  { name: "empty OS", fields: { os: "" } },
  { name: "Linux", fields: { os: "linux" } },
  { name: "Windows", fields: { os: "windows" } },
  { name: "macOS", fields: { os: "macos" } },
];

function render(panel: React.ReactNode): string {
  return renderToStaticMarkup(
    <I18nProvider locale="en">
      <TooltipProvider>{panel}</TooltipProvider>
    </I18nProvider>,
  );
}

for (const [panelName, renderPanel] of Object.entries(panelRenderers)) {
  for (const type of ["local", "remote", "dynamic"] as PortForwardingType[]) {
    for (const { name, fields } of hostCases) {
      test(`${panelName} renders ${type} forwarding with ${name}`, () => {
        // Persisted legacy records can violate the required Host.os type at runtime.
        const host = { ...baseHost, ...fields } as unknown as Host;
        const markup = render(renderPanel([host], { ...baseRule, type }));

        assert.match(markup, /Forwarding host/);
        assert.match(markup, /lucide-server/);
      });
    }
  }

  test(`${panelName} preserves the selected host's distro icon`, () => {
    const host: Host = { ...baseHost, os: "linux", distro: "ubuntu" };
    const markup = render(renderPanel([host], baseRule));

    assert.match(markup, /Forwarding host/);
    assert.match(markup, /src="\/distro\/ubuntu\.svg"/);
  });

  test(`${panelName} renders the host picker when no host is selected`, () => {
    const markup = render(renderPanel([], { ...baseRule, hostId: undefined }));

    assert.match(markup, /Select a host/);
    assert.doesNotMatch(markup, /Forwarding host/);
  });

  test(`${panelName} renders the host picker when the selected host is unavailable`, () => {
    const markup = render(renderPanel([], baseRule));

    assert.match(markup, /Select a host/);
    assert.doesNotMatch(markup, /Forwarding host/);
  });
}
