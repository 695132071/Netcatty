import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type { PluginAgentHostRequest, PluginAgentHostResult } from '@netcatty/plugin-contract';
import { AgentRuntime } from '../harness/agentRuntime';
import type { TurnDriver } from '../harness/turnDrivers/types';
import { ConfiguredPluginAgentBackends } from './configuredBackends';
import { createTrustedPluginAgentRuntime } from './trustedAgentRuntime';

function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { resolve, promise }; }
function fixture(t: TestContext, driver: TurnDriver, prepare = async () => {}) {
  const old = Object.getOwnPropertyDescriptor(globalThis, 'window');
  let revision = '1';
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { netcatty: {
    aiExec: async () => ({ ok: true, stdout: '', stderr: '', exitCode: 0 }), aiSetChatSessionCancelled: async () => ({ ok: true }),
  } } });
  const backends = new ConfiguredPluginAgentBackends({ getModel: () => ({ config: { id: 'fixture', name: 'Fixture', providerId: 'custom', enabled: true, defaultModel: 'fixture', apiKey: 'FIXTURE_MARKER' }, label: 'Fixture', revision }),
    prepareModel: prepare, getExternal: () => [] });
  const runtime = createTrustedPluginAgentRuntime({ isActive: () => true, chooseTargets: async () => [], backends, runtime: new AgentRuntime({ drivers: [driver] }) });
  const session = { conversationRef: crypto.randomUUID(), id: `plugin-agent:${crypto.randomUUID()}`, agentId: 'catty', title: 'Synthetic', scope: { type: 'global' }, messages: [], createdAt: 1, updatedAt: 1 };
  const call = (kind: string, payload: unknown, requestId: string = crypto.randomUUID(), runtimeId = 'r1', signal = new AbortController().signal): Promise<PluginAgentHostResult> => runtime.handle({ requestId, kind, payload, runtimeId, actionToken: 'fixture' } as PluginAgentHostRequest, signal);
  t.after(() => { runtime.shutdown(); if (old) Object.defineProperty(globalThis, 'window', old); else Reflect.deleteProperty(globalThis, 'window'); });
  const start = async (requestId?: string, signal?: AbortSignal) => {
    const result = await call('agent.backends', {}); assert.ok('backends' in result);
    return call('agent.run', { session, backendHandle: result.backends[0].hostHandle, terminalSessions: [], text: 'Synthetic user intent', maxIterations: 12, delegationTag: crypto.randomUUID(), capabilities: [] }, requestId, 'r1', signal);
  };
  return { runtime, call, start, modelTo: (value: string) => { revision = value; } };
}

test('trusted runtime reuses actual AgentRuntime and projects bounded events without raw tool data', async (t) => {
  const f = fixture(t, { backend: 'catty', run: async (input, context) => {
    assert.equal(input.backend, 'catty'); if (input.backend !== 'catty') return;
    assert.equal(input.context.scopeType, 'global'); assert.equal(input.context.agentKind, 'global'); assert.deepEqual(input.context.selectedUserSkillSlugs, []);
    context.emit({ id: 'delta', type: 'model_delta', text: 'Synthetic output' } as Parameters<typeof context.emit>[0]);
    context.emit({ id: 'tool', type: 'tool_call', toolName: 'terminal_execute', toolCallId: 't1', args: { command: 'DO_NOT_SERIALIZE_TOOL_ARGS' } } as Parameters<typeof context.emit>[0]);
    context.emit({ id: 'usage', type: 'usage', promptTokens: 12, completionTokens: 6 } as Parameters<typeof context.emit>[0]);
    input.ui.updateMessageById?.(input.chatSessionId, input.assistantMsgId, (message) => ({ ...message, content: 'Synthetic output', statusText: undefined }));
  } });
  const started = await f.start(); assert.ok('hostHandle' in started);
  const events = [];
  for (let i = 0; i < 10; i++) {
    const value = await f.call('agent.next', started); assert.ok('event' in value); events.push(value.event);
    // Real stream UI clears optional status fields with undefined. The trusted
    // IPC boundary accepts JSON values only, so each persisted snapshot must
    // normalize those omitted fields before it is submitted.
    const { assertPluginJsonValue } = createRequire(import.meta.url)('../../../electron/plugins/jsonBoundary.cjs');
    assert.doesNotThrow(() => assertPluginJsonValue(value, { maxBytes: 1_048_576 }));
    if (value.event.kind === 'end') break;
  }
  assert.ok(events.some((item) => item.kind === 'text')); assert.ok(events.some((item) => item.kind === 'activity'));
  assert.doesNotMatch(JSON.stringify(events), /DO_NOT_SERIALIZE|FIXTURE_MARKER|apiKey|command/);
  await assert.rejects(f.call('agent.next', started, undefined, 'foreign-runtime'));
});

test('cancelled start replies and runtime release abort exact turns, dropping late events', async (t) => {
  const entered = deferred(); const resume = deferred(); let signal: AbortSignal | undefined;
  const f = fixture(t, { backend: 'catty', run: async (_input, context) => { signal = context.signal; entered.resolve(); await resume.promise; context.emit({ id: 'late', type: 'model_delta', text: 'LATE_TEXT' } as Parameters<typeof context.emit>[0]); } });
  const requestId = crypto.randomUUID(); const result = await f.start(requestId); await entered.promise;
  f.runtime.cancelRequest(requestId, 'foreign-runtime'); assert.equal(signal?.aborted, false);
  f.runtime.cancelRequest(requestId, 'r1'); assert.equal(signal?.aborted, true); resume.resolve();
  await assert.rejects(f.call('agent.next', result));
});

test('release during backend preparation prevents a late AgentRuntime start', async (t) => {
  const entered = deferred(); const resume = deferred(); let starts = 0;
  const f = fixture(t, { backend: 'catty', run: async () => { starts++; } }, async () => { entered.resolve(); await resume.promise; });
  const pending = f.start(); const rejected = assert.rejects(pending); await entered.promise;
  f.runtime.releaseRuntime('r1'); resume.resolve(); await rejected; assert.equal(starts, 0);
});

test('host configuration changes abort a pending existing runtime turn and suppress late model text', async (t) => {
  const resume = deferred(); let signal: AbortSignal | undefined;
  const f = fixture(t, { backend: 'catty', run: async (_input, context) => { signal = context.signal; await resume.promise;
    context.emit({ id: 'late', type: 'model_delta', text: 'LATE_MODEL_TEXT' } as Parameters<typeof context.emit>[0]); } });
  const started = await f.start(); f.modelTo('2'); f.runtime.invalidateConfiguration(); assert.equal(signal?.aborted, true);
  resume.resolve(); const value = await f.call('agent.next', started); assert.ok('event' in value);
  assert.deepEqual(value.event, { kind: 'end', reason: 'unavailable' });
});

test('Stop then Send waits for the actual runtime driver to unwind before starting replacement B', async (t) => {
  const resume = deferred(); t.after(resume.resolve); let starts = 0;
  const f = fixture(t, { backend: 'catty', run: async (_input, context) => {
    if (++starts === 1) await resume.promise;
    context.emit({ id: 'delta', type: 'model_delta', text: starts === 1 ? 'LATE_A' : 'Replacement B' } as Parameters<typeof context.emit>[0]);
  } });
  const first = await f.start(); assert.ok('hostHandle' in first);
  await f.call('agent.release', first);
  let published = false; const pending = f.start().then((value) => { published = true; return value; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(published, false, 'replacement handle must not precede runtime availability');
  assert.equal(starts, 1); resume.resolve();
  const second = await pending; assert.ok('hostHandle' in second);
  const next = await f.call('agent.next', second); assert.ok('event' in next);
  assert.deepEqual(next.event, { kind: 'text', text: 'Replacement B' }); assert.equal(starts, 2);
});

for (const change of ['cancel', 'release', 'configuration'] as const) test(`replacement waiting for old runtime revalidates ${change} before starting`, async (t) => {
  const resume = deferred(); t.after(resume.resolve); let starts = 0;
  const f = fixture(t, { backend: 'catty', run: async () => { starts++; await resume.promise; } });
  const first = await f.start(); await f.call('agent.release', first);
  const caller = new AbortController(); const pending = f.start(undefined, caller.signal); const rejected = assert.rejects(pending);
  await new Promise<void>((resolve) => setImmediate(resolve));
  if (change === 'cancel') caller.abort();
  else if (change === 'release') f.runtime.releaseRuntime('r1');
  else f.modelTo('2');
  resume.resolve(); await rejected; assert.equal(starts, 1);
});
