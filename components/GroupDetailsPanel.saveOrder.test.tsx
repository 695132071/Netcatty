import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { normalizeVaultOrder, sortByVaultOrder } from "../domain/vaultOrder.ts";
import type { GroupConfig } from "../types.ts";
import GroupDetailsPanel from "./GroupDetailsPanel.tsx";
import { HostNotesEditor } from "./host/HostNotesEditor.tsx";
import { AsidePanel } from "./ui/aside-panel.tsx";
import { Input } from "./ui/input.tsx";
import { TooltipProvider } from "./ui/tooltip.tsx";
import { installDomEnvironment } from "./test-support/renderReactDom.tsx";

async function saveGroup(config: GroupConfig | undefined, newName?: string) {
  const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = environment.IS_REACT_ACT_ENVIRONMENT;
  const dom = installDomEnvironment();
  const previousRaf = globalThis.requestAnimationFrame;
  const previousCancelRaf = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = (callback) => setTimeout(() => callback(0), 0) as unknown as number;
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  let renderer: ReactTestRenderer | undefined;
  let saved: GroupConfig | undefined;
  let savedName: string | undefined;
  try {
    await act(async () => {
      renderer = create(
        <TooltipProvider>
          <GroupDetailsPanel
            groupPath={config?.path ?? "new-group"}
            config={config}
            availableKeys={[]}
            identities={[]}
            allHosts={[]}
            groups={[]}
            terminalThemeId="default"
            terminalFontSize={14}
            onSave={(value, name) => { saved = value; savedName = name; }}
            onCancel={() => {}}
          />
        </TooltipProvider>,
      );
    });
    await act(async () => {
      renderer!.root.findByType(HostNotesEditor).props.onChange(" Updated note ");
      if (newName) {
        renderer!.root.findAllByType(Input)[0].props.onChange({ target: { value: newName } });
      }
    });
    await act(async () => {
      renderer!.root.findByType(AsidePanel).props.actions.props.onClick();
    });
    assert.ok(saved, "the actual panel save handler must emit a config");
    return { saved, savedName };
  } finally {
    if (renderer) await act(async () => { renderer!.unmount(); });
    globalThis.requestAnimationFrame = previousRaf;
    globalThis.cancelAnimationFrame = previousCancelRaf;
    dom.cleanup();
    environment.IS_REACT_ACT_ENVIRONMENT = previous;
  }
}

test("editing group notes retains its manual position through write normalization", async () => {
  const original = { path: "Fleet-0999", order: 1000 };
  const sibling = { path: "Fleet-0998", order: 2000 };
  const { saved, savedName } = await saveGroup(original);
  assert.deepEqual(saved, { ...original, notes: "Updated note" });
  assert.equal(savedName, undefined);
  // VaultView removes the old config and appends the panel's replacement.
  const written = normalizeVaultOrder([sibling, saved]);
  assert.deepEqual(sortByVaultOrder(written).map((config) => config.path), [original.path, sibling.path]);
  assert.deepEqual(original, { path: "Fleet-0999", order: 1000 });
});

test("renaming a group in the details panel retains its manual position", async () => {
  const { saved, savedName } = await saveGroup({ path: "parent/old", order: 2500 }, "renamed");
  assert.equal(saved.path, "parent/renamed");
  assert.equal(saved.order, 2500);
  assert.equal(savedName, "renamed");
});

test("group saves preserve zero and negative manual order values", async () => {
  for (const order of [0, -1000]) {
    const { saved } = await saveGroup({ path: "group", order });
    assert.equal(saved.order, order);
  }
});

test("saving a new or unordered group leaves order assignment to the write path", async () => {
  for (const config of [undefined, { path: "existing-unordered" }]) {
    const { saved } = await saveGroup(config);
    assert.equal(Object.hasOwn(saved, "order"), false);
    assert.equal(normalizeVaultOrder([saved])[0].order, 1000);
  }
});
