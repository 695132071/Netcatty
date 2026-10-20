import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { I18nProvider } from '../../../../application/i18n/I18nProvider';
import { STORAGE_KEY_AI_PRIVACY } from '../../../../infrastructure/config/storageKeys';
import { AIPrivacySection } from './AIPrivacySection';

function installEnvironment(setConfig: (config: unknown) => Promise<unknown>) {
  const values = new Map<string, string>();
  const events = new EventTarget();
  const globals = {
    IS_REACT_ACT_ENVIRONMENT: true,
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
    window: {
      netcatty: { externalMcpSetConfig: setConfig },
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      dispatchEvent: events.dispatchEvent.bind(events),
    },
  };
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries(globals)) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
  return {
    values,
    restore: () => {
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
}

function view() {
  return <I18nProvider locale="en"><AIPrivacySection /></I18nProvider>;
}

test('privacy settings default off and explain their limits and connection scope', async () => {
  const env = installEnvironment(async () => ({ ok: true }));
  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => { renderer = create(view()); });
    const markup = JSON.stringify(renderer!.toJSON());
    assert.equal(renderer!.root.findAllByType('button').filter((node) => node.props['aria-checked'] === false).length, 2);
    assert.match(markup, /cannot detect every secret/);
    assert.match(markup, /AI privacy/);
    assert.match(markup, /Catty, integrated agents and external MCP clients/);
    assert.match(markup, /Only Netcatty-managed data and tools are covered/);
    assert.match(markup, /native tools, direct file access and other MCP servers/);
    assert.match(markup, /Binary tool responses are blocked/);
    assert.match(markup, /one managed conversation or external MCP connection/);
    assert.match(markup, /reconnect external MCP clients/);
    assert.match(markup, /start a new managed conversation/);
    assert.match(markup, /Additional IP ranges/);
    assert.match(markup, /Custom regular expressions/);
  } finally {
    if (renderer) await act(async () => { renderer!.unmount(); });
    env.restore();
  }
});

test('AI privacy is shared Tool Access UI, not nested under External MCP', async () => {
  const settingsTab = await readFile(new URL('../SettingsAITab.tsx', import.meta.url), 'utf8');
  const externalCard = await readFile(new URL('./ExternalMcpCard.tsx', import.meta.url), 'utf8');
  const toolsTab = settingsTab.split('<TabsContent value="tools"')[1].split('</TabsContent>')[0];
  assert.match(toolsTab, /<\/SettingsSection>\s*<AIPrivacySection \/>\s*<SettingsSection anchorId="ai-external-mcp"/);
  assert.doesNotMatch(externalCard, /AIPrivacySection|ExternalMcpRedactionSection/);
});

test('privacy drafts apply together, retain rejected input and persist only validated settings', async () => {
  const calls: unknown[] = [];
  let accepted = false;
  const env = installEnvironment(async (config) => {
    calls.push(config);
    return accepted ? { ok: true } : { ok: false, error: 'Invalid privacy rules.' };
  });
  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => { renderer = create(view()); });
    const root = renderer!.root;
    const privacySwitch = () => root.findAllByType('button').find((node) => (
      node.props['aria-label'] === 'Enable text redaction'
    ))!;
    const apply = () => root.findAllByType('button').find((node) => node.props.children === 'Apply')!;
    await act(async () => { privacySwitch().props.onClick(); });
    await act(async () => {
      root.findAllByType('textarea')[0].props.onChange({ currentTarget: { value: '192.0.2.0/24\n\n2001:db8::/32' } });
      root.findAllByType('textarea')[1].props.onChange({ currentTarget: { value: '[' } });
    });
    assert.equal(calls.length, 0, 'draft edits must not change runtime or storage');
    assert.equal(env.values.get(STORAGE_KEY_AI_PRIVACY), undefined);
    await act(async () => { apply().props.onClick(); });
    assert.equal(root.findAllByType('textarea')[1].props.value, '[');
    assert.match(root.findByProps({ role: 'alert' }).children.join(''), /Invalid privacy rules/);
    assert.equal(env.values.get(STORAGE_KEY_AI_PRIVACY), undefined);

    accepted = true;
    await act(async () => {
      root.findAllByType('textarea')[1].props.onChange({ currentTarget: { value: 'INTERNAL_[A-Z0-9]+' } });
    });
    await act(async () => { apply().props.onClick(); });
    const saved = JSON.parse(env.values.get(STORAGE_KEY_AI_PRIVACY)!);
    assert.deepEqual(saved, {
      enabled: true,
      redactPrivateIps: false,
      cidrs: ['192.0.2.0/24', '2001:db8::/32'],
      patterns: ['INTERNAL_[A-Z0-9]+'],
    });
    assert.deepEqual(calls[1], { redaction: saved });
    assert.equal(root.findAllByProps({ role: 'alert' }).length, 0);
    assert.match(root.findByProps({ role: 'status' }).children.join(''), /new managed conversation/);
  } finally {
    if (renderer) await act(async () => { renderer!.unmount(); });
    env.restore();
  }
});

test('malformed saved privacy settings remain visible as a recoverable error', async () => {
  const env = installEnvironment(async () => ({ ok: true }));
  let renderer: ReactTestRenderer | undefined;
  try {
    env.values.set(STORAGE_KEY_AI_PRIVACY, '{');
    await act(async () => { renderer = create(view()); });
    assert.match(renderer!.root.findByProps({ role: 'alert' }).children.join(''), /Invalid saved AI privacy settings/);
    assert.ok(renderer!.root.findAllByType('button').some((node) => node.props.children === 'Apply'));
    assert.equal(env.values.get(STORAGE_KEY_AI_PRIVACY), '{');
  } finally {
    if (renderer) await act(async () => { renderer!.unmount(); });
    env.restore();
  }
});

test('privacy apply disables draft controls until shared validation settles', async () => {
  let resolveConfig!: (result: unknown) => void;
  const env = installEnvironment(() => new Promise((resolve) => { resolveConfig = resolve; }));
  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => { renderer = create(view()); });
    const root = renderer!.root;
    await act(async () => {
      root.findAllByType('button').find((node) => node.props['aria-label'] === 'Enable text redaction')!.props.onClick();
    });
    await act(async () => {
      root.findAllByType('button').find((node) => node.props.children === 'Apply')!.props.onClick();
    });
    assert.ok(root.findAllByType('button').every((node) => node.props.disabled));
    assert.ok(root.findAllByType('textarea').every((node) => node.props.disabled));
    assert.equal(env.values.get(STORAGE_KEY_AI_PRIVACY), undefined);
    await act(async () => { resolveConfig({ ok: true }); });
    assert.ok(root.findAllByType('button').every((node) => !node.props.disabled));
    assert.equal(JSON.parse(env.values.get(STORAGE_KEY_AI_PRIVACY)!).enabled, true);
  } finally {
    if (renderer) await act(async () => { renderer!.unmount(); });
    env.restore();
  }
});

test('shared privacy controls refresh when another window changes the shared preference', async () => {
  const env = installEnvironment(async () => ({ ok: true }));
  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => { renderer = create(view()); });
    const settings = { enabled: true, redactPrivateIps: true, cidrs: ['192.0.2.0/24'], patterns: ['INTERNAL_.*'] };
    env.values.set(STORAGE_KEY_AI_PRIVACY, JSON.stringify(settings));
    const event = new Event('storage');
    Object.defineProperty(event, 'key', { value: STORAGE_KEY_AI_PRIVACY });
    await act(async () => { window.dispatchEvent(event); });
    assert.equal(renderer!.root.findAllByType('button').filter((node) => node.props['aria-checked'] === true).length, 2);
    assert.equal(renderer!.root.findAllByType('textarea')[0].props.value, '192.0.2.0/24');
    assert.equal(renderer!.root.findAllByType('textarea')[1].props.value, 'INTERNAL_.*');
  } finally {
    if (renderer) await act(async () => { renderer!.unmount(); });
    env.restore();
  }
});
