const assert = require('node:assert/strict');
const test = require('node:test');
const { describePluginRuntime, assertBrowserOnlyPlugin } = require('./pluginRuntimePolicy.cjs');

test('dual entrypoints retain browser default placement but require developer admission', () => {
  const manifest = { main: { browser: 'browser.js', node: 'node.js' } };
  assert.equal(describePluginRuntime(manifest).defaultRuntimeKind, 'browser');
  assert.equal(describePluginRuntime(manifest).hasNode, true);
  assert.throws(() => assertBrowserOnlyPlugin(manifest), /developer mode/);
});
test('normal release admission rejects advanced declarations and privileged providers', () => {
  assert.doesNotThrow(() => assertBrowserOnlyPlugin({ main: { browser: 'index.js' }, permissions: { required: ['settings.read', 'commands'] } }));
  for (const permission of ['runtime.advanced', 'companion.execute', 'terminal.intercept.input', 'terminal.intercept.output']) {
    for (const kind of ['required', 'optional']) {
      assert.throws(() => assertBrowserOnlyPlugin({ main: { browser: 'index.js' }, permissions: { [kind]: [permission] } }), /developer mode/);
    }
  }
  const manifest = { main: { browser: 'index.js', node: 'node.js' }, contributes: { providers: [{ kind: 'terminal.interceptor.input' }] } };
  assert.equal(describePluginRuntime(manifest).defaultRuntimeKind, 'utility');
  assert.throws(() => assertBrowserOnlyPlugin(manifest), /developer mode/);
});
