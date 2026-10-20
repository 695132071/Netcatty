import test from 'node:test';
import assert from 'node:assert/strict';
import en from './en';
import zhCN from './zh-CN';
import zhTW from './zh-TW';

const KEYS = [
  'ai.opencode.v2.startupTimeout',
  'ai.opencode.v2.exited',
  'ai.opencode.v2.unauthorized',
  'ai.opencode.v2.unavailable',
  'ai.opencode.v2.sessionFailed',
  'ai.opencode.v2.empty',
  'ai.opencode.v2.contextSkipped',
  'ai.opencode.v2.mcpSkipped',
];

test('OpenCode 2 strings exist in English, Simplified Chinese, and Taiwan Chinese', () => {
  for (const key of KEYS) {
    assert.equal(typeof en[key], 'string', `en missing ${key}`);
    assert.equal(typeof zhCN[key], 'string', `zh-CN missing ${key}`);
    assert.equal(typeof zhTW[key], 'string', `zh-TW missing ${key}`);
    assert.notEqual(en[key], zhCN[key]);
    assert.notEqual(en[key], zhTW[key]);
    assert.notEqual(zhCN[key], zhTW[key]);
  }
});

test('Taiwan OpenCode 2 wording uses Taiwan terms', () => {
  const text = KEYS.map((key) => zhTW[key]).join('\n');
  assert.match(text, /終端機/);
  assert.match(text, /連線/);
  assert.match(text, /設定/);
  assert.match(text, /傳回/);
  assert.equal(text.includes('终端'), false);
  assert.equal(text.includes('连接'), false);
  assert.equal(text.includes('设置'), false);
  assert.equal(text.includes('返回'), false);
});
