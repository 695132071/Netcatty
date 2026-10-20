import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { generateText, isStepCount, streamText, tool, wrapLanguageModel } from 'ai';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart, LanguageModelV4StreamResult } from '@ai-sdk/provider';
import { z } from 'zod';
import {
  createModelPrivacyMiddleware,
  initializeModelPrivacy,
  protectModel,
  redactOpenAIChatAssistantFields,
  redactModelPrompt,
  type ModelPrivacyBridge,
} from './modelPrivacy';
import { redactSecretsForModel, setReversibleModelPrivacy } from './modelSecretRedaction';
import { fitTerminalExecuteResultForModel } from './terminalCompression';
import { fitLargeToolResultForModel } from './toolResultFitting';
import { formatMessagesForCompaction } from '../contextCompaction';
import { pruneStaleToolContext } from './staleContextPruner';
import { compactCattyMessages } from './cattyRuntime';
import { createBridgeFetchForSDK, createModelFromConfig } from '../sdk/providers';
import { getOpenAIChatAssistantFieldsForHistoryMessage } from '../providerContinuation';
import { createCattyToolsFromCatalog } from './capabilityTools';
import { buildCattyToolApproval } from './cattyToolApproval';
import { reserveSessionSlot } from '../shared/sessionExecutionQueue';

const require = createRequire(import.meta.url);
const { createAiPrivacyService } = require('../../../electron/shared/aiPrivacyService.cjs');
const ADDRESS = '203.0.113.19';
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

async function fixture(t: test.TestContext, chatSessionId = t.name) {
  const service = createAiPrivacyService();
  service.configure({ enabled: true });
  const bridge: ModelPrivacyBridge = {
    aiPrivacyStatus: async () => ({ ok: true, enabled: service.isEnabled() }),
    aiPrivacyTransform: async ({ operation, value, chatSessionId: id }) => {
      try {
        return { ok: true, value: service[operation](id, value) };
      } catch (error) {
        return { ok: false, error: String(error) };
      }
    },
  };
  t.after(() => setReversibleModelPrivacy(chatSessionId, false));
  const privacy = await initializeModelPrivacy(bridge, chatSessionId);
  assert.ok(privacy);
  return { privacy, service, bridge, chatSessionId };
}

function stream(chunks: LanguageModelV4StreamPart[]): LanguageModelV4StreamResult {
  return {
    stream: simulateReadableStream<LanguageModelV4StreamPart>({
      chunks: [
        { type: 'stream-start', warnings: [] },
        ...chunks,
        { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
      ],
      initialDelayInMs: null,
      chunkDelayInMs: null,
    }),
  };
}

async function drain(source: ReadableStream<LanguageModelV4StreamPart>) {
  const reader = source.getReader();
  const chunks: LanguageModelV4StreamPart[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return chunks;
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
}

test('privacy off and old bridge mocks retain the existing behavior', async () => {
  const model = new MockLanguageModelV4();
  assert.equal(protectModel(model), model);
  assert.equal(await initializeModelPrivacy({}, 'old-bridge'), undefined);
  const disabled = await initializeModelPrivacy({
    aiPrivacyStatus: async () => ({ ok: true, enabled: false }),
    aiPrivacyTransform: async ({ value }) => ({ ok: true, value }),
  }, 'disabled');
  assert.equal(disabled?.enabled, false);
  assert.equal(redactSecretsForModel('password=private', 'disabled'), 'password=[REDACTED]');
});

test('status and transformation errors fail closed without provider calls', async (t) => {
  await assert.rejects(initializeModelPrivacy({
    aiPrivacyStatus: async () => ({ ok: false, enabled: false, error: 'failed' }),
  }, 'denied'), /privacy protection is unavailable/);
  const { bridge, chatSessionId } = await fixture(t);
  const privacy = await initializeModelPrivacy(bridge, chatSessionId);
  bridge.aiPrivacyTransform = async () => ({ ok: false, error: 'synthetic failure' });
  const model = new MockLanguageModelV4();
  await assert.rejects(async () => protectModel(model, privacy).doGenerate({
    prompt: [{ role: 'user', content: [{ type: 'text', text: ADDRESS }] }],
  }), /privacy protection is unavailable/);
  assert.equal(model.doGenerateCalls.length, 0);
});

test('model boundary masks semantic content while leaving protocol and opaque fields intact', async (t) => {
  const { privacy } = await fixture(t);
  const opaque = { anthropic: { signature: 'opaque-signature' } };
  const params: LanguageModelV4CallOptions = {
    prompt: [
      { role: 'system', content: `hostname: ${ADDRESS}` },
      { role: 'user', content: [{ type: 'text', text: `password=synth-secret; inspect ${ADDRESS}` }] },
      { role: 'assistant', content: [
        { type: 'reasoning', text: 'safe signed reasoning', providerOptions: opaque },
        { type: 'tool-call', toolCallId: 'call-1', toolName: 'inspect', input: { target: ADDRESS, password: 'synth-secret' } },
      ] },
      { role: 'tool', content: [{
        type: 'tool-result', toolCallId: 'call-1', toolName: 'inspect',
        output: { type: 'json', value: { address: ADDRESS, output: 'synth-secret' } },
      }] },
    ],
    providerOptions: { example: { opaqueValue: ADDRESS } },
  };
  const result = await redactModelPrompt(params, privacy);
  assert.doesNotMatch(JSON.stringify(result.prompt), /203\.0\.113\.19|synth-secret/);
  assert.match(JSON.stringify(result.prompt), /NC_.*IP_/);
  assert.match(JSON.stringify(result.prompt), /"toolCallId":"call-1","toolName":"inspect"/);
  assert.equal(result.providerOptions, params.providerOptions);
  assert.equal((result.prompt[2].content[0] as { providerOptions?: unknown }).providerOptions, opaque);
  assert.match(JSON.stringify(params.prompt), /synth-secret/);
});

test('signed private reasoning is rejected instead of being modified or leaked', async (t) => {
  const { privacy } = await fixture(t);
  await assert.rejects(redactModelPrompt({
    prompt: [{ role: 'assistant', content: [{
      type: 'reasoning',
      text: `Connecting to ${ADDRESS}`,
      providerOptions: { anthropic: { signature: 'signed-before-privacy' } },
    }] }],
  }, privacy), /Start a new chat/);
});

test('UTF-8 text attachments are redacted and binary attachments fail closed', async (t) => {
  const { privacy } = await fixture(t);
  const result = await redactModelPrompt({
    prompt: [{ role: 'user', content: [{
      type: 'file',
      filename: 'hosts.txt',
      mediaType: 'text/plain',
      data: { type: 'data', data: Buffer.from(`hostname: ${ADDRESS}`).toString('base64') },
    }] }],
  }, privacy);
  const part = result.prompt[0].content[0] as { data: { data: Uint8Array } };
  assert.doesNotMatch(new TextDecoder().decode(part.data.data), /203\.0\.113\.19/);
  assert.match(new TextDecoder().decode(part.data.data), /NC_/);
  await assert.rejects(redactModelPrompt({
    prompt: [{ role: 'user', content: [{
      type: 'file', mediaType: 'image/png', data: { type: 'data', data: 'AA==' },
    }] }],
  }, privacy), /cannot inspect this attachment/);
});

test('attachment tool results and history omit the encoded duplicate before redaction', async (t) => {
  const { privacy } = await fixture(t);
  const payload = { text: `hostname: ${ADDRESS}`, base64Data: Buffer.from(ADDRESS).toString('base64') };
  for (const output of [
    { type: 'json' as const, value: payload },
    { type: 'text' as const, value: JSON.stringify(payload) },
  ]) {
    const result = await redactModelPrompt({
      prompt: [{ role: 'tool', content: [{
        type: 'tool-result', toolName: 'read_attachment', toolCallId: 'attachment', output,
      }] }],
    }, privacy);
    assert.doesNotMatch(JSON.stringify(result.prompt), /base64Data|203\.0\.113\.19/);
    assert.match(JSON.stringify(result.prompt), /NC_/);
  }
  await assert.rejects(redactModelPrompt({
    prompt: [{ role: 'tool', content: [{
      type: 'tool-result', toolName: 'read_attachment', toolCallId: 'image',
      output: { type: 'json', value: { base64Data: 'AA==', mediaType: 'image/png' } },
    }] }],
  }, privacy), /cannot inspect this attachment/);
  assert.ok(payload.base64Data);
});

test('stream restores tokens split at every character and flushes an ordinary bracket suffix', async (t) => {
  const { privacy } = await fixture(t);
  const token = await privacy.transform('redact', ADDRESS);
  const model = new MockLanguageModelV4({
    doStream: stream([
      { type: 'text-start', id: 'text-1' },
      ...[...`host=${token}; [`].map(delta => ({ type: 'text-delta' as const, id: 'text-1', delta })),
      { type: 'text-end', id: 'text-1' },
    ]),
  });
  const response = await protectModel(model, privacy).doStream({
    prompt: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
  });
  let text = '';
  for (const chunk of await drain(response.stream)) {
    if (chunk.type === 'text-delta') text += chunk.delta;
  }
  assert.equal(text, `host=${ADDRESS}; [`);
});

test('stream preserves reasoning bytes and provider continuation metadata', async (t) => {
  const { privacy } = await fixture(t);
  const token = await privacy.transform('redact', ADDRESS);
  const metadata = { anthropic: { signature: 'opaque-signature' } };
  const chunks: LanguageModelV4StreamPart[] = [
    { type: 'reasoning-start', id: 'reasoning', providerMetadata: metadata },
    { type: 'reasoning-delta', id: 'reasoning', delta: `inspect ${token}`, providerMetadata: metadata },
    { type: 'reasoning-end', id: 'reasoning', providerMetadata: metadata },
  ];
  const model = new MockLanguageModelV4({ doStream: stream(chunks) });
  const response = await protectModel(model, privacy).doStream({
    prompt: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
  });
  const actual = [];
  for (const chunk of await drain(response.stream)) {
    if (chunk.type.startsWith('reasoning-')) actual.push(chunk);
  }
  assert.deepEqual(actual, chunks);
});

test('full tool input is restored before schema validation, approval and execution', async (t) => {
  const { privacy } = await fixture(t);
  const token = await privacy.transform('redact', ADDRESS);
  let requests = 0;
  let approved = false;
  let executed = false;
  const model = new MockLanguageModelV4({
    doStream: async (params) => {
      requests++;
      assert.doesNotMatch(JSON.stringify(params.prompt), /203\.0\.113\.19|synth-result-secret/);
      if (requests === 1) {
        return {
          stream: simulateReadableStream<LanguageModelV4StreamPart>({
            chunks: [
              { type: 'stream-start', warnings: [] },
              { type: 'tool-call', toolCallId: 'call-1', toolName: 'inspect', input: JSON.stringify({ target: token }) },
              { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage },
            ],
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        };
      }
      assert.match(JSON.stringify(params.prompt), /SECRET_/);
      return stream([
        { type: 'text-start', id: 'answer' },
        { type: 'text-delta', id: 'answer', delta: `Checked ${token}` },
        { type: 'text-end', id: 'answer' },
      ]);
    },
  });
  const result = streamText({
    model: protectModel(model, privacy),
    messages: [{ role: 'user', content: `Inspect ${ADDRESS}` }],
    tools: {
      inspect: tool({
        inputSchema: z.object({ target: z.literal(ADDRESS) }),
        execute: async ({ target }) => {
          assert.equal(target, ADDRESS);
          assert.equal(approved, true);
          executed = true;
          return { password: 'synth-result-secret' };
        },
      }),
    },
    toolApproval: async ({ toolCall }) => {
      assert.deepEqual(toolCall.input, { target: ADDRESS });
      approved = true;
      return { type: 'approved' };
    },
    stopWhen: isStepCount(2),
  });
  for await (const chunk of result.stream) {
    if (chunk.type === 'error') throw chunk.error;
  }
  assert.equal(await result.text, `Checked ${ADDRESS}`);
  assert.equal(approved, true);
  assert.equal(executed, true);
  assert.equal(requests, 2);
});

test('policy changes while restored tool arguments await approval prevent execution', async (t) => {
  const { privacy, bridge, service, chatSessionId } = await fixture(t);
  const token = await privacy.transform('redact', ADDRESS);
  let calls = 0;
  const bundle = createCattyToolsFromCatalog({
    ...bridge,
    aiExec: async () => { calls++; return { ok: true }; },
    aiCapability: async () => { calls++; return { ok: true }; },
  }, { sessions: [] }, [], 'confirm', undefined, chatSessionId);
  const catalogExecute = bundle.tools.sftp_write_file.execute as (
    input: unknown, options: unknown,
  ) => Promise<unknown>;
  let approvalEntered!: () => void;
  let finishApproval!: (approved: boolean) => void;
  const pendingApproval = new Promise<void>(resolve => { approvalEntered = resolve; });
  const decision = new Promise<boolean>(resolve => { finishApproval = resolve; });
  const approve = buildCattyToolApproval({
    permissionMode: 'confirm',
    chatSessionId,
    requestApproval: async (_id, _name, args) => {
      assert.equal(args.content, ADDRESS);
      approvalEntered();
      return decision;
    },
  });
  const model = new MockLanguageModelV4({
    doStream: stream([{
      type: 'tool-call', toolCallId: 'write', toolName: 'sftp_write_file',
      input: JSON.stringify({ sessionId: 'session', path: '/synthetic.txt', content: token }),
    }]),
  });
  const result = streamText({
    model: protectModel(model, privacy),
    messages: [{ role: 'user', content: `Write ${ADDRESS}` }],
    tools: {
      sftp_write_file: tool({
        inputSchema: z.object({ sessionId: z.string(), path: z.string(), content: z.literal(ADDRESS) }),
        execute: async (args, options) => catalogExecute(args, {
          ...options, context: bundle.toolsContext.sftp_write_file,
        }),
      }),
    },
    toolApproval: async ({ toolCall }) => approve({ toolCall } as Parameters<typeof approve>[0]),
    stopWhen: isStepCount(1),
  });
  const failures: string[] = [];
  const consumed = (async () => {
    for await (const chunk of result.stream) {
      if (chunk.type === 'tool-error' || chunk.type === 'error') failures.push(String(chunk.error));
    }
  })();
  await pendingApproval;
  service.configure({ enabled: false });
  finishApproval(true);
  await consumed;
  assert.equal(calls, 0);
  assert.match(failures.join('\n'), /privacy protection is unavailable/);
});

test('queued catalog calls recheck the pinned privacy policy after their slot becomes ready', async (t) => {
  const { bridge, service, chatSessionId } = await fixture(t);
  let calls = 0;
  const bundle = createCattyToolsFromCatalog({
    ...bridge,
    aiExec: async () => { calls++; return { ok: true }; },
    aiCapability: async () => { calls++; return { ok: true }; },
  }, { sessions: [] }, [], 'auto', undefined, chatSessionId);
  const slot = reserveSessionSlot(`${chatSessionId}:session`);
  const catalogExecute = bundle.tools.sftp_write_file.execute as (
    input: unknown, options: unknown,
  ) => Promise<unknown>;
  const result = catalogExecute({
    sessionId: 'session', path: '/synthetic.txt', content: ADDRESS,
  }, {
    toolCallId: 'queued-write', messages: [], context: bundle.toolsContext.sftp_write_file,
  });
  const rejected = assert.rejects(async () => result, /privacy protection is unavailable/);
  service.configure({ enabled: false });
  slot.release();
  await rejected;
  assert.equal(calls, 0);
});

test('generate path used by compaction redacts requests and restores returned summaries', async (t) => {
  const { privacy, chatSessionId } = await fixture(t);
  let requests = 0;
  const model = new MockLanguageModelV4({
    doGenerate: async params => {
      requests++;
      const serialized = JSON.stringify(params.prompt);
      assert.doesNotMatch(serialized, /synth-compaction-secret/);
      const token = serialized.match(/\[NC_[^\]]+_SECRET_\d+\]/)?.[0];
      assert.ok(token);
      return {
        content: [{ type: 'text', text: `Remember ${token}` }],
        finishReason: { unified: 'stop', raw: undefined },
        usage,
        warnings: [],
      };
    },
  });
  const compacted = await compactCattyMessages({
    messages: [
      { role: 'user', content: 'password=synth-compaction-secret' },
      { role: 'assistant', content: 'Noted' },
    ],
    sessionId: chatSessionId,
    chatSessionId,
    model: protectModel(model, privacy),
    abortSignal: new AbortController().signal,
    force: true,
    trigger: 'force',
    protectRecentMessages: 0,
  });
  assert.equal(requests, 1);
  assert.equal(compacted.summary, 'Remember synth-compaction-secret');
});

test('legacy fitters and pruning defer irreversible masking only for the protected chat', async (t) => {
  const { chatSessionId } = await fixture(t);
  const secret = 'password=synth-secret';
  const terminal = fitTerminalExecuteResultForModel({
    stdout: secret, stderr: '', exitCode: 0,
  }, { chatSessionId });
  assert.equal(terminal.stdout, secret);
  assert.equal(fitLargeToolResultForModel({
    result: secret, capabilityId: 'test', chatSessionId,
  }), secret);
  assert.match(formatMessagesForCompaction([{ role: 'user', content: secret }], chatSessionId), /synth-secret/);
  const messages = [{
    role: 'assistant' as const,
    content: [{ type: 'tool-call' as const, toolCallId: 'x', toolName: 'test', input: { password: 'synth-secret' } }],
  }];
  assert.match(JSON.stringify(pruneStaleToolContext(messages, { chatSessionId }).messages), /synth-secret/);
  assert.doesNotMatch(JSON.stringify(pruneStaleToolContext(messages).messages), /synth-secret/);
  assert.equal(redactSecretsForModel(secret, 'another-chat'), 'password=[REDACTED]');
});

test('unknown tool tokens cannot reach execution', async (t) => {
  const { privacy } = await fixture(t);
  const model = new MockLanguageModelV4({
    doGenerate: {
      content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'inspect', input: '{"target":"[NC_unknown_IP_1]"}' }],
      finishReason: { unified: 'tool-calls', raw: undefined },
      usage,
      warnings: [],
    },
  });
  let executed = false;
  await assert.rejects(generateText({
    model: protectModel(model, privacy),
    messages: [{ role: 'user', content: ADDRESS }],
    tools: {
      inspect: tool({
        inputSchema: z.object({ target: z.string() }),
        execute: async () => { executed = true; return 'unsafe'; },
      }),
    },
    maxRetries: 0,
  }), /privacy protection is unavailable/);
  assert.equal(executed, false);
});

test('OpenAI-compatible reasoning injected after model conversion is still protected', async (t) => {
  const { privacy } = await fixture(t);
  const mockGlobal = globalThis as unknown as { window?: unknown };
  const originalWindow = mockGlobal.window;
  t.after(() => {
    mockGlobal.window = originalWindow;
  });
  let sentBody = '';
  mockGlobal.window = {
    netcatty: {
      aiFetch: async (_url: string, _method: string, _headers: unknown, body: string) => {
        sentBody = body;
        return { ok: true, status: 200, data: '{}' };
      },
    },
  };
  const fields = [{ reasoning_content: `Inspect ${ADDRESS}`, signature: 'opaque-signature' }];
  const fetch = createBridgeFetchForSDK('synthetic-provider', {
    getOpenAIChatAssistantFields: () => fields,
    transformOpenAIChatAssistantFields: values => redactOpenAIChatAssistantFields(values, privacy),
  });
  await fetch('https://example.test/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      messages: [
        { role: 'assistant', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'inspect', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'call-1', content: 'done' },
      ],
    }),
  });
  assert.doesNotMatch(sentBody, /203\.0\.113\.19/);
  assert.match(sentBody, /NC_/);
  assert.match(sentBody, /opaque-signature/);
  assert.equal(fields[0].reasoning_content, `Inspect ${ADDRESS}`);
});

test('legacy continuation secrets are discovered with each model prompt before provider conversion', async (t) => {
  const { privacy } = await fixture(t);
  const mockGlobal = globalThis as unknown as { window?: unknown };
  const originalWindow = mockGlobal.window;
  t.after(() => { mockGlobal.window = originalWindow; });
  const bodies: string[] = [];
  mockGlobal.window = {
    netcatty: {
      aiFetch: async (_url: string, _method: string, _headers: unknown, body: string) => {
        bodies.push(body);
        return {
          ok: true, status: 200,
          data: JSON.stringify({
            id: 'synthetic-response', object: 'chat.completion', created: 0, model: 'synthetic',
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          }),
        };
      },
    },
  };
  const source = { providerConfigId: 'synthetic', providerType: 'custom', modelId: 'synthetic' };
  let fields: Array<Record<string, unknown> | undefined> = [];
  const getOpenAIChatAssistantFields = () => fields;
  const model = protectModel(createModelFromConfig({
    id: source.providerConfigId, providerId: source.providerType, name: 'Synthetic',
    enabled: true, defaultModel: source.modelId, baseURL: 'https://example.test/v1', apiKey: 'synthetic-key',
  }, {
    getOpenAIChatAssistantFields,
    transformOpenAIChatAssistantFields: values => redactOpenAIChatAssistantFields(values, privacy),
  }), privacy, { getOpenAIChatAssistantFields });
  for (const [host, secret] of [
    ['prod.example.test', 'synthetic-first-token'],
    ['second.example.test', 'synthetic-second-token'],
  ]) {
    const thinking = `hostname=${host} password=${secret}`;
    // Old conversations have only thinking, not stored reasoningParts.
    const legacy = getOpenAIChatAssistantFieldsForHistoryMessage({
      providerId: source.providerType, model: source.modelId, thinking,
    }, source);
    fields = [{ ...legacy, signature: 'opaque-signature' }];
    await model.doGenerate({
      prompt: [
        { role: 'user', content: [{ type: 'text', text: `${host} ${secret}` }] },
        { role: 'assistant', content: [{
          type: 'tool-call', toolCallId: 'call', toolName: 'inspect', input: {},
        }] },
        { role: 'tool', content: [{
          type: 'tool-result', toolCallId: 'call', toolName: 'inspect',
          output: { type: 'text', value: 'done' },
        }] },
      ],
    });
    const body = bodies.at(-1)!;
    assert.ok(!body.includes(host));
    assert.ok(!body.includes(secret));
    assert.match(body, /NC_.*HOST_/);
    assert.match(body, /NC_.*SECRET_/);
    assert.match(body, /reasoning_content/);
    assert.match(body, /opaque-signature/);
    assert.equal(fields[0]?.reasoning_content, thinking);
  }
  assert.equal(bodies.length, 2);
});

test('enabling privacy during an off-mode turn blocks its next model call', async (t) => {
  const { bridge, service } = await fixture(t);
  service.configure({ enabled: false });
  const chatSessionId = 'off-mode-policy-switch';
  t.after(() => setReversibleModelPrivacy(chatSessionId, false));
  const privacy = await initializeModelPrivacy(bridge, chatSessionId);
  assert.equal(privacy?.enabled, false);
  const model = new MockLanguageModelV4({
    doGenerate: {
      content: [{ type: 'text', text: 'ok' }],
      finishReason: { unified: 'stop', raw: undefined },
      usage,
      warnings: [],
    },
  });
  const protectedModel = protectModel(model, privacy);
  const params: LanguageModelV4CallOptions = {
    prompt: [{ role: 'user', content: [{ type: 'text', text: ADDRESS }] }],
  };
  await protectedModel.doGenerate(params);
  assert.match(JSON.stringify(model.doGenerateCalls[0].prompt), /203\.0\.113\.19/);
  service.configure({ enabled: true });
  await assert.rejects(async () => protectedModel.doGenerate(params), /privacy protection is unavailable/);
  assert.equal(model.doGenerateCalls.length, 1);
});

for (const method of ['doGenerate', 'doStream'] as const) {
  test(`enabling privacy after prompt transformation blocks the ${method} provider handoff`, async (t) => {
    const { bridge, service } = await fixture(t);
    service.configure({ enabled: false });
    const chatSessionId = `${t.name}-off`;
    t.after(() => setReversibleModelPrivacy(chatSessionId, false));
    const privacy = await initializeModelPrivacy(bridge, chatSessionId);
    assert.ok(privacy);
    assert.equal(privacy.enabled, false);
    const model = new MockLanguageModelV4({
      doGenerate: {
        content: [{ type: 'text', text: 'ok' }],
        finishReason: { unified: 'stop', raw: undefined },
        usage,
        warnings: [],
      },
      doStream: stream([]),
    });
    const middleware = createModelPrivacyMiddleware(privacy);
    const protectedModel = wrapLanguageModel({
      model,
      middleware: {
        ...middleware,
        async transformParams(options) {
          const params = await middleware.transformParams!(options);
          // Model the SDK await gap after the disabled prompt was validated.
          service.configure({ enabled: true });
          return params;
        },
      },
    });
    await assert.rejects(async () => protectedModel[method]({
      prompt: [{ role: 'user', content: [{ type: 'text', text: ADDRESS }] }],
    }), /privacy protection is unavailable/);
    assert.equal(model.doGenerateCalls.length, 0);
    assert.equal(model.doStreamCalls.length, 0);
  });
}
