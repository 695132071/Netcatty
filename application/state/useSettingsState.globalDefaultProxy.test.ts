import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";

import {
  clearActiveGlobalDefaultProxyProfile,
  getActiveGlobalDefaultProxyProfileId,
  publishActiveGlobalDefaultProxyProfileId,
} from "../../domain/globalDefaultProxy.ts";
import { STORAGE_KEY_GLOBAL_DEFAULT_PROXY_PROFILE } from "../../infrastructure/config/storageKeys.ts";
import { useSettingsState } from "./useSettingsState.ts";

type Notification = { key: string; value: unknown };

const withSettingsDom = async (
  run: (env: { dom: JSDOM; root: Root; notifications: Notification[] }) => Promise<void>,
) => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
  const globalAny = globalThis as Record<string, unknown>;
  const saved = {
    window: globalAny.window,
    document: globalAny.document,
    localStorage: globalAny.localStorage,
    actEnv: globalAny.IS_REACT_ACT_ENVIRONMENT,
  };
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: dom.window.localStorage });
  Object.defineProperty(globalAny, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });

  const notifications: Notification[] = [];
  dom.window.netcatty = {
    notifySettingsChanged: (payload: Notification) => {
      notifications.push(payload);
    },
  } as Window["netcatty"];
  dom.window.localStorage.setItem(STORAGE_KEY_GLOBAL_DEFAULT_PROXY_PROFILE, "profile-1");

  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await run({ dom, root, notifications });
  } finally {
    await act(async () => {
      root.unmount();
    });
    publishActiveGlobalDefaultProxyProfileId(undefined);
    container.remove();
    dom.window.close();
    for (const key of ["window", "document", "localStorage"] as const) {
      if (saved[key] === undefined) delete globalAny[key];
      else {
        Object.defineProperty(globalThis, key, {
          configurable: true,
          enumerable: true,
          writable: true,
          value: saved[key],
        });
      }
    }
    Object.defineProperty(globalAny, "IS_REACT_ACT_ENVIRONMENT", {
      configurable: true,
      value: saved.actEnv,
    });
  }
};

const proxyNotifications = (notifications: Notification[]) => (
  notifications.filter((entry) => entry.key === STORAGE_KEY_GLOBAL_DEFAULT_PROXY_PROFILE)
);

test("closing a second settings instance still persists a cleared global default proxy", async () => {
  await withSettingsDom(async ({ dom, root, notifications }) => {
    let showSecond = true;
    function SettingsProbe() {
      useSettingsState({ enableSystemEffects: false });
      return null;
    }
    function Harness() {
      return React.createElement(
        React.Fragment,
        null,
        React.createElement(SettingsProbe),
        showSecond ? React.createElement(SettingsProbe) : null,
      );
    }

    await act(async () => {
      root.render(React.createElement(Harness));
    });
    assert.equal(getActiveGlobalDefaultProxyProfileId(), "profile-1");
    assert.equal(dom.window.localStorage.getItem(STORAGE_KEY_GLOBAL_DEFAULT_PROXY_PROFILE), "profile-1");

    showSecond = false;
    await act(async () => {
      root.render(React.createElement(Harness));
    });
    notifications.length = 0;
    await act(async () => {
      clearActiveGlobalDefaultProxyProfile();
    });

    assert.equal(getActiveGlobalDefaultProxyProfileId(), undefined);
    assert.equal(dom.window.localStorage.getItem(STORAGE_KEY_GLOBAL_DEFAULT_PROXY_PROFILE), "");
    assert.deepEqual(proxyNotifications(notifications), [
      { key: STORAGE_KEY_GLOBAL_DEFAULT_PROXY_PROFILE, value: "" },
    ]);
  });
});

test("a peer session window follows global default proxy storage without settings sync", async () => {
  await withSettingsDom(async ({ dom, root, notifications }) => {
    function PeerSettings() {
      useSettingsState({ enableSettingsSync: false, enableSystemEffects: false });
      return null;
    }

    await act(async () => {
      root.render(React.createElement(PeerSettings));
    });
    assert.equal(getActiveGlobalDefaultProxyProfileId(), "profile-1");

    notifications.length = 0;
    dom.window.localStorage.setItem(STORAGE_KEY_GLOBAL_DEFAULT_PROXY_PROFILE, "profile-2");
    await act(async () => {
      dom.window.dispatchEvent(new dom.window.StorageEvent("storage", {
        key: STORAGE_KEY_GLOBAL_DEFAULT_PROXY_PROFILE,
        newValue: "profile-2",
        storageArea: dom.window.localStorage,
      }));
    });

    assert.equal(getActiveGlobalDefaultProxyProfileId(), "profile-2");
    assert.equal(dom.window.localStorage.getItem(STORAGE_KEY_GLOBAL_DEFAULT_PROXY_PROFILE), "profile-2");
    assert.deepEqual(proxyNotifications(notifications), []);
  });
});
