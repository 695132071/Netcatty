import assert from "node:assert/strict";
import test from "node:test";
import en from "./en";
import es from "./es";
import ru from "./ru";
import zhCN from "./zh-CN";
import zhTW from "./zh-TW";

test("folder cleanup-warning counts are localized in every supported locale", () => {
  for (const [locale, messages] of Object.entries({ en, es, ru, zhCN, zhTW })) {
    assert.match(messages["sftp.transfers.cleanupWarnings"] ?? "", /\{count\}/, locale);
  }
});
