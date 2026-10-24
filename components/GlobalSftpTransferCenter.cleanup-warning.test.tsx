import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { createDomRenderer, dispatchDomEvent, flushEffects, installDomEnvironment } from "./test-support/renderReactDom";

test("global completed rows and expanded folder children show cleanup paths without a failed status", async (t) => {
  const env = installDomEnvironment();
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    MutationObserver: env.window.MutationObserver, NodeFilter: env.window.NodeFilter,
    HTMLInputElement: env.window.HTMLInputElement, Element: env.window.Element,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: clearTimeout,
  })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const { I18nProvider } = await import("../application/i18n/I18nProvider");
  const { sftpTransferCenterStore: store } = await import("../application/state/sftpTransferCenterStore");
  const { GlobalSftpTransferCenter } = await import("./GlobalSftpTransferCenter");
  const { TooltipProvider } = await import("./ui/tooltip");
  const renderer = await createDomRenderer(env.document);
  t.after(async () => {
    await renderer.unmount();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    env.cleanup();
  });
  const warning = "Upload completed; remove backup /remote/.netcatty-backup-file.bin manually.";
  const base = {
    fileName: "file.bin", sourcePath: "/local/file.bin", targetPath: "/remote/file.bin",
    sourceConnectionId: "local", targetConnectionId: "remote", direction: "upload" as const,
    status: "completed" as const, totalBytes: 10, transferredBytes: 10, speed: 0,
    startTime: Date.now(), endTime: Date.now(), isDirectory: false,
  };
  store.publishOwner("cleanup-ui", [
    { ...base, id: "warning-file", warning },
    { ...base, id: "warning-folder", fileName: "folder", isDirectory: true },
    { ...base, id: "warning-child", parentTaskId: "warning-folder", warning },
  ]);
  await renderer.render(<I18nProvider locale="en"><TooltipProvider><GlobalSftpTransferCenter /></TooltipProvider></I18nProvider>);
  const click = async (selector: string) => {
    const node = env.document.querySelector(selector);
    assert.ok(node, selector);
    await dispatchDomEvent(node, new env.window.MouseEvent("click", { bubbles: true }));
    await flushEffects();
  };
  await click("[data-section=global-sftp-transfer-toggle]");
  assert.match(env.document.body.textContent ?? "", /Backup cleanup warnings: 1/);
  await click('button[aria-label="Show files"]');
  const notices = env.document.querySelectorAll('[data-section="sftp-transfer-warning"]');
  assert.equal(notices.length, 2);
  for (const notice of notices) assert.equal(notice.textContent, warning);
  assert.equal(env.document.querySelector('[data-transfer-status="failed"]'), null);
  assert.equal(store.getTask("warning-child")?.status, "completed");
  await click("[data-section=global-sftp-transfer-toggle]");
});
