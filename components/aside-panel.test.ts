import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AsidePanel, invokeAsideActionMenuItemClick } from "./ui/aside-panel.tsx";

test("AsideActionMenuItem closes its menu before running the action", () => {
  const events: string[] = [];

  invokeAsideActionMenuItemClick(
    () => events.push("close"),
    () => events.push("action"),
  );

  assert.deepEqual(events, ["close", "action"]);
});

test("AsideActionMenuItem still closes when no action is provided", () => {
  const events: string[] = [];

  invokeAsideActionMenuItemClick(() => events.push("close"));

  assert.deepEqual(events, ["close"]);
});

test("overlay aside panels ask native views to yield; inline panels do not", () => {
  const render = (layout: "overlay" | "inline") => renderToStaticMarkup(
    React.createElement(AsidePanel, { open: true, onClose: () => {}, layout, children: "content" }),
  );

  assert.match(render("overlay"), /data-native-view-occluder=""/);
  assert.doesNotMatch(render("inline"), /data-native-view-occluder/);
});
