import assert from 'node:assert/strict';
import test from 'node:test';
import en from './en.ts';
import es from './es.ts';
import ru from './ru.ts';
import zhCN from './zh-CN.ts';
import zhTW from './zh-TW.ts';

const KEYS = [
  'title', 'description', 'boundary', 'enable', 'privateIps', 'privateIps.description',
  'cidrs', 'cidrs.description', 'patterns', 'patterns.description',
  'connectionScope', 'reconnect', 'apply', 'applying', 'applied', 'failed',
];

test('Shared AI privacy settings are localized in every supported locale', () => {
  for (const [name, messages] of Object.entries({ en, es, ru, 'zh-CN': zhCN, 'zh-TW': zhTW })) {
    assert.deepEqual(
      KEYS.filter((key) => !messages[`ai.privacy.${key}`]),
      [],
      `${name} is missing privacy settings labels`,
    );
  }
});
