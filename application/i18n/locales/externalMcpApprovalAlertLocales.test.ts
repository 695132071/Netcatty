import assert from 'node:assert/strict';
import test from 'node:test';

import en from './en.ts';
import ru from './ru.ts';
import es from './es.ts';
import zhCN from './zh-CN.ts';
import zhTW from './zh-TW.ts';

const KEYS = [
  'ai.externalMcp.approvalAlert',
  'ai.externalMcp.approvalAlert.description',
  'ai.externalMcp.approvalAlert.off',
  'ai.externalMcp.approvalAlert.unfocused',
  'ai.externalMcp.approvalAlert.always',
  'ai.externalMcp.approvalAlert.notificationTitle',
  'ai.externalMcp.approvalAlert.notificationBody',
  'ai.externalMcp.approvalAlert.notificationBodyOnHost',
] as const;

test('External MCP approval alerts are localized in every supported locale', () => {
  for (const [name, messages] of Object.entries({ en, es, 'zh-CN': zhCN, 'zh-TW': zhTW, ru })) {
    const missing = KEYS.filter((key) => !messages[key]);
    assert.deepEqual(missing, [], `${name} is missing approval alert labels`);
    assert.match(messages['ai.externalMcp.approvalAlert.notificationBody'], /\{tool\}/);
    assert.match(messages['ai.externalMcp.approvalAlert.notificationBodyOnHost'], /\{tool\}/);
    assert.match(messages['ai.externalMcp.approvalAlert.notificationBodyOnHost'], /\{host\}/);
  }
});
