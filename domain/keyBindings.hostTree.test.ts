import assert from 'node:assert/strict';
import test from 'node:test';

import { getTerminalPassthroughActions } from '../application/state/useGlobalHotkeys.ts';
import en from '../application/i18n/locales/en.ts';
import zhCN from '../application/i18n/locales/zh-CN.ts';
import zhTW from '../application/i18n/locales/zh-TW.ts';
import { findActiveSystemShortcutConflict } from './activeKeyBindings.ts';
import { DEFAULT_KEY_BINDINGS, matchesKeyBinding } from './models/keyBindings.ts';

test('host list toggle defaults to Ctrl/Cmd+Shift+B and leaves Ctrl/Cmd+B on broadcast', () => {
  const binding = DEFAULT_KEY_BINDINGS.find((entry) => entry.id === 'toggle-host-tree');

  assert.equal(binding?.action, 'toggleHostTree');
  assert.equal(binding?.label, 'Toggle Host List');
  assert.equal(binding?.category, 'app');
  assert.equal(binding?.pc, 'Ctrl + Shift + B');
  assert.equal(binding?.mac, '⌘ + Shift + B');

  assert.equal(
    findActiveSystemShortcutConflict('Ctrl + B', 'pc', DEFAULT_KEY_BINDINGS)?.id,
    'broadcast',
  );
  assert.equal(
    findActiveSystemShortcutConflict('⌘ + B', 'mac', DEFAULT_KEY_BINDINGS)?.id,
    'broadcast',
  );
  assert.equal(
    findActiveSystemShortcutConflict('Ctrl + Shift + B', 'pc', DEFAULT_KEY_BINDINGS)?.id,
    'toggle-host-tree',
  );
  assert.equal(
    findActiveSystemShortcutConflict('⌘ + Shift + B', 'mac', DEFAULT_KEY_BINDINGS)?.id,
    'toggle-host-tree',
  );

  assert.deepEqual(
    DEFAULT_KEY_BINDINGS.filter((entry) => entry.pc === 'Ctrl + Shift + B').map((entry) => entry.id),
    ['toggle-host-tree'],
  );
  assert.deepEqual(
    DEFAULT_KEY_BINDINGS.filter((entry) => entry.mac === '⌘ + Shift + B').map((entry) => entry.id),
    ['toggle-host-tree'],
  );

  assert.equal(getTerminalPassthroughActions().has('toggleHostTree'), false);
  assert.equal(matchesKeyBinding({
    key: 'B',
    code: 'KeyB',
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    shiftKey: true,
  } as KeyboardEvent, binding?.pc ?? '', false), true);
  assert.equal(matchesKeyBinding({
    key: 'b',
    code: 'KeyB',
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    shiftKey: false,
  } as KeyboardEvent, binding?.pc ?? '', false), false);
});

test('host list shortcut label is localized in English and Chinese', () => {
  assert.equal(en['settings.shortcuts.binding.toggle-host-tree'], 'Toggle Host List');
  assert.equal(zhCN['settings.shortcuts.binding.toggle-host-tree'], '切换主机列表');
  assert.equal(zhTW['settings.shortcuts.binding.toggle-host-tree'], '切換主機列表');
});
