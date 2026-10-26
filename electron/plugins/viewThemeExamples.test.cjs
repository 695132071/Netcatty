const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
test("official view examples consume initial/live host HSL tokens and dispose subscriptions", () => {
  for (const name of [
    "starter-netcatty",
    "vault-scratchpad",
    "session-scratchpad",
  ]) {
    const root = path.join(__dirname, "../../examples/plugins", name),
      dom = new JSDOM("<!doctype html><html></html>", {
        runScripts: "outside-only",
      });
    let listener,
      disposed = 0,
      subscriptions = 0;
    dom.window.netcattyView = {
      onDidChangeEnvironment(fn) {
        subscriptions++;
        listener = fn;
        return {
          dispose() {
            disposed++;
          },
        };
      },
    };
    dom.window.eval(fs.readFileSync(path.join(root, "theme.js"), "utf8"));
    listener({
      theme: "light",
      themeTokens: {
        "--primary": "120 50% 30%",
        "--background": "0 0% 100%",
        "--unsupported": "ignored",
      },
    });
    assert.equal(
      dom.window.document.documentElement.style.getPropertyValue("--primary"),
      "120 50% 30%",
    );
    assert.equal(
      dom.window.document.documentElement.style.getPropertyValue(
        "--unsupported",
      ),
      "",
    );
    listener({
      theme: "dark",
      reducedMotion: true,
      themeTokens: { "--primary": "120 50% 70%" },
    });
    assert.equal(dom.window.document.documentElement.style.colorScheme, "dark");
    assert.equal(
      dom.window.document.documentElement.style.getPropertyValue(
        "--background",
      ),
      "",
    );
    dom.window.dispatchEvent(new dom.window.Event("pagehide"));
    assert.equal(disposed, 1);
    dom.window.dispatchEvent(new dom.window.Event("pageshow"));
    assert.equal(subscriptions, 2);
    dom.window.close();
  }
});
