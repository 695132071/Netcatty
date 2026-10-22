import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import type { GroupNode } from "../types";

test("HostTreeView React updates invalidate order when configs or sort mode change", async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="scroll"><div id="root"></div></div></body></html>', {
    url: "http://localhost", pretendToBeVisual: true,
  });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "Event", "CustomEvent", "MouseEvent", "KeyboardEvent", "FocusEvent", "localStorage"] as const) {
    install(key, key === "window" ? dom.window : dom.window[key]);
  }
  install("getComputedStyle", dom.window.getComputedStyle.bind(dom.window));
  install("requestAnimationFrame", dom.window.requestAnimationFrame.bind(dom.window));
  install("cancelAnimationFrame", dom.window.cancelAnimationFrame.bind(dom.window));
  install("ResizeObserver", ResizeObserverStub);
  install("IS_REACT_ACT_ENVIRONMENT", true);
  const scroller = dom.window.document.getElementById("scroll")!;
  Object.defineProperties(scroller, { offsetHeight: { value: 800 }, offsetWidth: { value: 1280 } });
  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { HostTreeView } = await import("./HostTreeView.tsx");
  const noop = () => undefined;
  const groupTree: GroupNode[] = ["alpha", "beta"].map((path) => ({ name: path, path, hosts: [], children: {} }));
  const common = {
    groupTree, hosts: [], expandedPaths: new Set<string>(), scrollRef: { current: scroller },
    onConnect: noop, onEditHost: noop, onDuplicateHost: noop, onDeleteHost: noop,
    onCopyCredentials: noop, onNewGroup: noop, onRenameGroup: noop, onEditGroup: noop,
    onDeleteGroup: noop, moveHostToGroup: noop, moveGroup: noop,
  };
  const root = createRoot(dom.window.document.getElementById("root")!);
  const paths = () => [...dom.window.document.querySelectorAll("[data-group-path]")].map((node) => node.getAttribute("data-group-path"));
  try {
    await act(async () => {
      root.render(createElement(HostTreeView, { ...common, sortMode: "manual", groupConfigs: [{ path: "beta", order: -1 }] }));
    });
    assert.deepEqual(paths(), ["beta", "alpha"]);
    await act(async () => {
      root.render(createElement(HostTreeView, { ...common, sortMode: "manual", groupConfigs: [{ path: "alpha", order: -1 }] }));
    });
    assert.deepEqual(paths(), ["alpha", "beta"]);
    const groupConfigs = [{ path: "beta", order: -1 }];
    await act(async () => {
      root.render(createElement(HostTreeView, { ...common, sortMode: "az", groupConfigs }));
    });
    assert.deepEqual(paths(), ["alpha", "beta"]);
    await act(async () => {
      root.render(createElement(HostTreeView, { ...common, sortMode: "manual", groupConfigs }));
    });
    assert.deepEqual(paths(), ["beta", "alpha"]);
  } finally {
    await act(async () => { root.unmount(); });
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});
