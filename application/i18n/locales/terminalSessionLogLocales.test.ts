import assert from 'node:assert/strict';
import test from 'node:test';
import en from './en';
import es from './es';
import ru from './ru';
import zhCN from './zh-CN';
import zhTW from './zh-TW';

const keys = [
  'terminal.toolbar.openSessionLog',
  'terminal.toolbar.sessionLogActions',
  'terminal.toolbar.sessionLog.menu',
  'terminal.toolbar.sessionLog.open',
  'terminal.toolbar.sessionLog.reveal',
  'terminal.toolbar.sessionLog.chooseApplication',
  'terminal.toolbar.sessionLog.systemDefault',
  'terminal.toolbar.openSessionLogFailed',
] as const;

test('saved session log actions are translated in every shipped locale', () => {
  for (const [locale, messages] of Object.entries({ en, es, ru, 'zh-CN': zhCN, 'zh-TW': zhTW })) {
    for (const key of keys) assert.ok(messages[key], `${locale} is missing ${key}`);
    assert.equal(messages['terminal.toolbar.sessionLog.rememberApplication'], undefined);
  }
  assert.equal(en['terminal.toolbar.sessionLog.menu'], 'Session log');
  assert.equal(en['terminal.toolbar.sessionLog.open'], 'Open');
  assert.equal(en['terminal.toolbar.sessionLog.reveal'], 'Show in folder');
  assert.equal(en['terminal.toolbar.sessionLog.chooseApplication'], 'Open with…');
  assert.equal(en['terminal.toolbar.sessionLog.systemDefault'], 'Open with system default');
  assert.equal(zhCN['terminal.toolbar.sessionLog.menu'], '会话日志');
  assert.equal(zhTW['terminal.toolbar.sessionLog.menu'], '工作階段日誌');
});
