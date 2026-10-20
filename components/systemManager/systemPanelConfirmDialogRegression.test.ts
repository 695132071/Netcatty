import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../..", import.meta.url));

function readProjectFile(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

const SYSTEM_MANAGER_PANELS = [
  "components/systemManager/ProcessManagerTab.tsx",
  "components/systemManager/TmuxSessionCard.tsx",
  "components/systemManager/DockerContainersPanel.tsx",
  "components/systemManager/DockerImagesPanel.tsx",
  "components/systemManager/PortsManagerTab.tsx",
  "components/systemManager/ServicesManagerTab.tsx",
] as const;

test("system manager destructive actions use in-app confirm dialogs", () => {
  for (const path of SYSTEM_MANAGER_PANELS) {
    const source = readProjectFile(path);
    assert.match(
      source,
      /import \{ SystemPanelConfirmDialog \} from ['"]\.\/SystemPanelConfirmDialog['"]/,
      `${path} should import SystemPanelConfirmDialog`,
    );
    assert.match(
      source,
      /<SystemPanelConfirmDialog/,
      `${path} should render SystemPanelConfirmDialog`,
    );
    assert.doesNotMatch(
      source,
      /window\.confirm|globalThis\.confirm/,
      `${path} must not use native confirm dialogs`,
    );
  }
});

test("process and docker confirm dialogs reset when sessionId changes", () => {
  const processSource = readProjectFile("components/systemManager/ProcessManagerTab.tsx");
  const containersSource = readProjectFile("components/systemManager/DockerContainersPanel.tsx");
  const imagesSource = readProjectFile("components/systemManager/DockerImagesPanel.tsx");

  assert.match(processSource, /setPendingSignal\(null\)/);
  assert.match(processSource, /}, \[sessionId\]\);/);

  assert.match(containersSource, /setConfirmAction\(null\)/);
  assert.match(containersSource, /}, \[runtime, sessionId\]\);/);

  assert.match(imagesSource, /setConfirmTarget\(null\)/);
  assert.match(imagesSource, /setActionBusy\(false\)/);
  assert.match(imagesSource, /}, \[runtime, sessionId\]\);/);
});

test("ports and services confirm dialogs reset when sessionId changes", () => {
  const portsSource = readProjectFile("components/systemManager/PortsManagerTab.tsx");
  const servicesSource = readProjectFile("components/systemManager/ServicesManagerTab.tsx");

  assert.match(portsSource, /setPendingKillPid\(null\)/);
  assert.match(portsSource, /setKillBusy\(false\)/);
  assert.match(portsSource, /setActionError\(null\)/);
  assert.match(portsSource, /}, \[sessionId\]\);/);

  assert.match(servicesSource, /setPending\(null\)/);
  assert.match(servicesSource, /setActionBusy\(false\)/);
  assert.match(servicesSource, /setActionError\(null\)/);
  assert.match(servicesSource, /}, \[sessionId\]\);/);
});

test("ports and services surface pending channel results instead of treating them as success", () => {
  const portsSource = readProjectFile("components/systemManager/PortsManagerTab.tsx");
  const servicesSource = readProjectFile("components/systemManager/ServicesManagerTab.tsx");

  assert.match(portsSource, /result\.pending/);
  assert.match(portsSource, /systemManager\.errors\.sshChannelUnavailable/);
  assert.match(servicesSource, /result\.pending/);
  assert.match(servicesSource, /systemManager\.errors\.sshChannelUnavailable/);
});

test("ports and services ignore late action results after session switches", () => {
  const portsSource = readProjectFile("components/systemManager/PortsManagerTab.tsx");
  const servicesSource = readProjectFile("components/systemManager/ServicesManagerTab.tsx");

  assert.match(portsSource, /sessionIdRef\.current !== requestedSessionId/);
  assert.match(servicesSource, /sessionIdRef\.current !== requestedSessionId/);
});
