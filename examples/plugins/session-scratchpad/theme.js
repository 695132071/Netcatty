"use strict";
/* global document, window */
// This page owns its DOM. Only the host's public semantic colors are copied.
(() => {
  const names = ["--background", "--foreground", "--muted", "--muted-foreground", "--border", "--primary", "--primary-foreground"];
  let subscription;
  const subscribe = () => {
    if (subscription) return;
    subscription = window.netcattyView.onDidChangeEnvironment((environment) => {
      const root = document.documentElement;
      root.style.colorScheme = environment.theme === "system" ? "light dark" : environment.theme;
      root.dataset.reducedMotion = String(Boolean(environment.reducedMotion));
      root.dataset.highContrast = String(Boolean(environment.highContrast));
      for (const name of names) {
        const value = environment.themeTokens?.[name];
        if (typeof value === "string" && value.length <= 96) root.style.setProperty(name, value);
        else root.style.removeProperty(name);
      }
    });
  };
  subscribe();
  window.addEventListener("pagehide", () => { subscription?.dispose(); subscription = undefined; });
  window.addEventListener("pageshow", subscribe);
})();
