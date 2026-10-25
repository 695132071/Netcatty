import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ClaudeCodeCard } from "./ClaudeCodeCard";
import { CodebuddyCard } from "./CodebuddyCard";
import { CodexConnectionCard } from "./CodexConnectionCard";
import { CopilotCliCard } from "./CopilotCliCard";

const LONG_PATH = "C:\\Users\\70541\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Anthropic.ClaudeCode_Microsoft.Winget.Source_8wekyb3d8bbwe\\claude.exe";
const VERSION = "9.9.9-test";

function classList(tag: string): Set<string> {
  const match = tag.match(/class="([^"]*)"/);
  assert.ok(match, `missing class on ${tag}`);
  return new Set(match[1].split(/\s+/));
}

function assertClasses(tag: string, expected: string[]) {
  const have = classList(tag);
  for (const name of expected) {
    assert.ok(have.has(name), `expected ${name} on ${tag}`);
  }
}

function openingTagContaining(markup: string, text: string): string {
  const idx = markup.indexOf(`>${text}<`);
  assert.ok(idx >= 0, `missing text node ${text}`);
  const start = markup.lastIndexOf("<", idx);
  return markup.slice(start, idx + 1);
}

function pathRowClass(markup: string): string {
  const idx = markup.indexOf(LONG_PATH);
  assert.ok(idx >= 0, "missing path text");
  const matches = [...markup.slice(0, idx).matchAll(/<div\b[^>]*class="([^"]*)"/g)];
  assert.ok(matches.length > 0, "missing path row");
  return matches[matches.length - 1][1];
}

function assertLongPathTruncates(markup: string) {
  const pathTag = openingTagContaining(markup, LONG_PATH);
  assertClasses(pathTag, ["truncate", "min-w-0", "flex-1"]);
  assert.match(pathTag, new RegExp(`title="${LONG_PATH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
  assert.ok(pathRowClass(markup).split(/\s+/).includes("min-w-0"), "path row missing min-w-0");

  const versionTag = openingTagContaining(markup, VERSION);
  assertClasses(versionTag, ["shrink-0"]);

  const input = markup.match(/<input\b[^>]*>/);
  assert.ok(input, "missing custom path input");
  assertClasses(input[0], ["flex-1", "min-w-0"]);
  assert.match(input[0], new RegExp(`value="${LONG_PATH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
}

test("Claude Code card truncates a long CLI path inside the card", () => {
  const markup = renderToStaticMarkup(
    <ClaudeCodeCard
      pathInfo={{ path: LONG_PATH, version: VERSION, available: true }}
      isResolvingPath={false}
      customPath={LONG_PATH}
      onCustomPathChange={() => {}}
      onRecheckPath={() => {}}
      onResetPath={() => {}}
      configDir=""
      onConfigDirChange={() => {}}
      settingsPath=""
      onSettingsPathChange={() => {}}
      envText=""
      onEnvTextChange={() => {}}
    />,
  );
  assertLongPathTruncates(markup);
});

test("Codex card truncates a long CLI path inside the card", () => {
  const markup = renderToStaticMarkup(
    <CodexConnectionCard
      pathInfo={{ path: LONG_PATH, version: VERSION, available: true }}
      isResolvingPath={false}
      customPath={LONG_PATH}
      onCustomPathChange={() => {}}
      onRecheckPath={() => {}}
      onResetPath={() => {}}
      integration={null}
      loginSession={null}
      isLoading={false}
      error={null}
      onRefresh={() => {}}
      onConnect={() => {}}
      onCancel={() => {}}
      onOpenUrl={() => {}}
      onLogout={() => {}}
      appServerRuntime="sdk"
      appServerStatus={null}
      onAppServerRuntimeChange={() => {}}
    />,
  );
  assertLongPathTruncates(markup);
});

test("Codebuddy card truncates a long CLI path inside the card", () => {
  const markup = renderToStaticMarkup(
    <CodebuddyCard
      pathInfo={{ path: LONG_PATH, version: VERSION, available: true }}
      isResolvingPath={false}
      customPath={LONG_PATH}
      onCustomPathChange={() => {}}
      onRecheckPath={() => {}}
      onResetPath={() => {}}
      internetEnv=""
      onInternetEnvChange={() => {}}
      envText=""
      onEnvTextChange={() => {}}
    />,
  );
  assertLongPathTruncates(markup);
});

test("Copilot CLI card truncates a long CLI path inside the card", () => {
  const markup = renderToStaticMarkup(
    <CopilotCliCard
      pathInfo={{ path: LONG_PATH, version: VERSION, available: true }}
      isResolvingPath={false}
      customPath={LONG_PATH}
      onCustomPathChange={() => {}}
      onRecheckPath={() => {}}
      onResetPath={() => {}}
    />,
  );
  assertLongPathTruncates(markup);
});
