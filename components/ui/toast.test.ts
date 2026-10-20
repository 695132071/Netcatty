import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const toastSource = readFileSync(new URL("./toast.tsx", import.meta.url), "utf8");

test("toast surfaces follow app theme tokens instead of OS palette fills", () => {
  const styles = toastSource.slice(
    toastSource.indexOf("const TOAST_STYLES"),
    toastSource.indexOf("export const ToastProvider"),
  );

  assert.match(styles, /success: 'border-emerald-600'/);
  assert.match(styles, /error: 'border-red-600'/);
  assert.match(styles, /warning: 'border-yellow-600'/);
  assert.match(styles, /info: 'border-blue-600'/);
  // `dark:` is prefers-color-scheme, so these fills stay pale while
  // text-foreground / text-muted-foreground follow the `.dark` class.
  assert.doesNotMatch(styles, /bg-(?:emerald|red|yellow|blue)-50/);
  assert.doesNotMatch(styles, /dark:bg-(?:emerald|red|yellow|blue)-950/);
  assert.match(toastSource, /"bg-card animate-in/);
  assert.match(toastSource, /text-sm font-medium text-foreground/);
  assert.match(toastSource, /text-sm text-muted-foreground break-words/);
});
