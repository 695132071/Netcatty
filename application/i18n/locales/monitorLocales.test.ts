import { test } from "node:test";
import assert from "node:assert/strict";
import { enMonitorMessages } from "./en/monitor";
import { esMonitorMessages } from "./es/monitor";
import { ruMonitorMessages } from "./ru/monitor";
import { zhCNMonitorMessages } from "./zh-CN/monitor";
import { zhTWMonitorMessages } from "./zh-TW/monitor";
for (const [locale, messages] of Object.entries({
  es: esMonitorMessages,
  ru: ruMonitorMessages,
  "zh-CN": zhCNMonitorMessages,
  "zh-TW": zhTWMonitorMessages,
})) {
  test(`monitoring has translated actions, states and matching placeholders in ${locale}`, () => {
    assert.deepEqual(
      Object.keys(messages).sort(),
      Object.keys(enMonitorMessages).sort(),
    );
    for (const key of Object.keys(enMonitorMessages)) {
      const english = enMonitorMessages[key as keyof typeof enMonitorMessages];
      const translated = messages[key as keyof typeof messages];
      assert.ok(translated.trim(), key);
      assert.deepEqual(
        (translated.match(/\{\w+\}/g) ?? []).sort(),
        (english.match(/\{\w+\}/g) ?? []).sort(),
        key,
      );
    }
  });
}
