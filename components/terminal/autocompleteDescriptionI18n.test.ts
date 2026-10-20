import test from "node:test";
import assert from "node:assert/strict";

import type { FigSpec } from "./autocomplete/figSpecLoader.ts";

const SINCE = "Show logs since timestamp (e.g. 2013-01-02T13:23:37Z) or relative (e.g. 42m for 42 minutes)";
const SINCE_ZH = "从指定时间起显示日志（例如 2013-01-02T13:23:37Z），也可用相对时间（例如 42m 表示 42 分钟）";
const UNTRANSLATED = "This autocomplete description is intentionally untranslated.";

const dockerSpec: FigSpec = {
  name: "docker",
  subcommands: [
    {
      name: "logs",
      options: [
        { name: "--since", description: SINCE },
        { name: "--mystery", description: UNTRANSLATED },
      ],
    },
  ],
};

Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
  },
  configurable: true,
});

Object.defineProperty(globalThis, "window", {
  value: {
    netcatty: {
      listFigSpecs: async () => ["docker"],
      loadFigSpec: async (commandName: string) => commandName === "docker" ? dockerSpec : null,
    },
  },
  configurable: true,
});

const { getCompletions } = await import("./autocomplete/completionEngine.ts");

function sinceSuggestion(suggestions: Awaited<ReturnType<typeof getCompletions>>) {
  return suggestions.find((suggestion) => suggestion.displayText === "--since");
}

test("zh-CN translates docker logs --since and falls back for unknown descriptions", async () => {
  const suggestions = await getCompletions("docker logs --", {
    locale: "zh-CN",
    skipPathCompletion: true,
    maxResults: 20,
  });
  const since = sinceSuggestion(suggestions);
  const mystery = suggestions.find((suggestion) => suggestion.displayText === "--mystery");

  assert.equal(since?.displayText, "--since");
  assert.equal(since?.description, SINCE_ZH);
  assert.equal(mystery?.description, UNTRANSLATED);
  assert.equal(dockerSpec.subcommands?.[0].options?.[0].description, SINCE);
});

test("en locale leaves autocomplete descriptions unchanged", async () => {
  const suggestions = await getCompletions("docker logs --", {
    locale: "en",
    skipPathCompletion: true,
    maxResults: 20,
  });
  const since = sinceSuggestion(suggestions);

  assert.equal(since?.displayText, "--since");
  assert.equal(since?.description, SINCE);
  assert.equal(dockerSpec.subcommands?.[0].options?.[0].description, SINCE);
});
