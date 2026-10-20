import { wrapLanguageModel, type LanguageModelMiddleware } from 'ai';
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4StreamPart,
  LanguageModelV4ToolCall,
} from '@ai-sdk/provider';
import { setReversibleModelPrivacy } from './modelSecretRedaction';
import type { OpenAIChatAssistantFields } from '../providerContinuation';

export interface ModelPrivacyBridge {
  aiPrivacyStatus?: () => Promise<{ ok?: boolean; enabled?: boolean; error?: string }>;
  aiPrivacyTransform?: (input: {
    chatSessionId: string;
    operation: 'redact' | 'restore';
    value: unknown;
  }) => Promise<{ ok: boolean; value?: unknown; error?: string }>;
}

export interface ModelPrivacy {
  enabled: boolean;
  transform<T>(operation: 'redact' | 'restore', value: T): Promise<T>;
}

export interface ModelPrivacyContext {
  getOpenAIChatAssistantFields?: () => Array<OpenAIChatAssistantFields | undefined>;
}

const PRIVACY_ERROR = 'AI privacy protection is unavailable. No unprotected request was sent.';
const BINARY_ERROR = 'AI privacy protection cannot inspect this attachment. Use a text attachment instead.';
const SIGNED_REASONING_ERROR = 'AI privacy protection cannot safely rewrite signed reasoning from an earlier conversation. Start a new chat.';
const TOKEN_PREFIX = '[NC_';

/** Revalidate the pinned policy after approval/queue waits, before tool effects. */
export async function assertModelPrivacySession(
  bridge: ModelPrivacyBridge,
  chatSessionId?: string,
): Promise<void> {
  if (!bridge.aiPrivacyStatus) return;
  if (!bridge.aiPrivacyTransform || !chatSessionId) throw new Error(PRIVACY_ERROR);
  try {
    // Restore cannot create a map. Deleted/retired chats must not be reopened.
    const result = await bridge.aiPrivacyTransform({
      chatSessionId, operation: 'restore', value: [],
    });
    if (!result?.ok) throw new Error(PRIVACY_ERROR);
  } catch {
    throw new Error(PRIVACY_ERROR);
  }
}

/** Main owns the reverse map; the renderer retains only the enabled flag. */
export async function initializeModelPrivacy(
  bridge: ModelPrivacyBridge,
  chatSessionId: string,
): Promise<ModelPrivacy | undefined> {
  setReversibleModelPrivacy(chatSessionId, false);
  if (!bridge.aiPrivacyStatus) return undefined;
  let status: { ok?: boolean; enabled?: boolean };
  try {
    status = await bridge.aiPrivacyStatus();
  } catch {
    throw new Error(PRIVACY_ERROR);
  }
  if (status?.ok === false || typeof status?.enabled !== 'boolean') throw new Error(PRIVACY_ERROR);
  if (!bridge.aiPrivacyTransform) throw new Error(PRIVACY_ERROR);
  const privacy: ModelPrivacy = {
    enabled: status.enabled,
    async transform<T>(operation: 'redact' | 'restore', value: T): Promise<T> {
      let result;
      try {
        result = await bridge.aiPrivacyTransform!({ chatSessionId, operation, value });
      } catch {
        throw new Error(PRIVACY_ERROR);
      }
      if (!result?.ok) throw new Error(PRIVACY_ERROR);
      return result.value as T;
    },
  };
  // Pin even disabled chats. A policy switch must not leave a running turn
  // using an unprotected model selected under the previous policy.
  await privacy.transform('redact', []);
  let pinnedStatus;
  try {
    pinnedStatus = await bridge.aiPrivacyStatus();
  } catch {
    throw new Error(PRIVACY_ERROR);
  }
  if (pinnedStatus?.ok === false || pinnedStatus?.enabled !== privacy.enabled) {
    throw new Error(PRIVACY_ERROR);
  }
  setReversibleModelPrivacy(chatSessionId, privacy.enabled);
  return privacy;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function textOnlyAttachment(value: unknown): unknown {
  let payload = value;
  if (typeof value === 'string') {
    try { payload = JSON.parse(value); } catch { return value; }
  }
  if (!isRecord(payload) || !('base64Data' in payload)) return value;
  if (payload.base64Data && typeof payload.text !== 'string') throw new Error(BINARY_ERROR);
  const { base64Data: _encoded, ...textPayload } = payload;
  return typeof value === 'string' ? JSON.stringify(textPayload) : textPayload;
}

/**
 * Select semantic content only. IDs, schemas, provider settings and signed
 * continuation metadata must never pass through a generic recursive rewrite.
 * A single batch lets the shared detector discover repeated secrets regardless
 * of their position in the prompt.
 */
export async function redactModelPrompt(
  params: LanguageModelV4CallOptions,
  privacy: ModelPrivacy,
  assistantFields: Array<OpenAIChatAssistantFields | undefined> = [],
): Promise<LanguageModelV4CallOptions> {
  if (!privacy.enabled) {
    await privacy.transform('redact', []);
    return params;
  }
  const values: unknown[] = [];
  const apply: Array<(value: unknown) => void> = [];
  const queue = (value: unknown, assign: (value: unknown) => void) => {
    values.push(value);
    apply.push(assign);
  };
  // Plain continuation reasoning is injected later by the provider fetch.
  // Discover its labelled secrets in this same batch so bare occurrences in
  // the normal prompt cannot escape before that late injection is transformed.
  // Do not rewrite stored continuation bytes or touch opaque signed metadata.
  for (const entry of assistantFields) {
    if (typeof entry?.reasoning_content === 'string') {
      queue(entry.reasoning_content, () => {});
    }
  }
  const field = (record: Record<string, unknown>, key: string) => {
    if (record[key] !== undefined) queue(record[key], value => { record[key] = value; });
  };
  const file = (part: Record<string, unknown>) => {
    const data = part.data;
    if (!isRecord(data) || !/^(?:text\/|application\/(?:json|xml|javascript|x-yaml|yaml|toml|x-sh|csv)(?:;|$))/i.test(String(part.mediaType))) {
      throw new Error(BINARY_ERROR);
    }
    if (data.type === 'text' && typeof data.text === 'string') {
      const copy = { ...data };
      part.data = copy;
      field(copy, 'text');
    } else if (data.type === 'data' && (typeof data.data === 'string' || data.data instanceof Uint8Array)) {
      let text: string;
      try {
        const bytes = typeof data.data === 'string'
          ? Uint8Array.from(atob(data.data), char => char.charCodeAt(0))
          : data.data;
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        throw new Error(BINARY_ERROR);
      }
      queue(text, value => {
        if (typeof value !== 'string') throw new Error(PRIVACY_ERROR);
        part.data = { type: 'data', data: new TextEncoder().encode(value) };
      });
    } else {
      // URL/reference attachments would be fetched outside this text boundary.
      throw new Error(BINARY_ERROR);
    }
    field(part, 'filename');
  };
  const output = (value: unknown, toolName: unknown): unknown => {
    if (!isRecord(value)) throw new Error(PRIVACY_ERROR);
    const copy = { ...value };
    if (['text', 'json', 'error-text', 'error-json'].includes(String(copy.type))) {
      if (toolName === 'read_attachment') copy.value = textOnlyAttachment(copy.value);
      field(copy, 'value');
    } else if (copy.type === 'execution-denied') {
      field(copy, 'reason');
    } else if (copy.type === 'content' && Array.isArray(copy.value)) {
      copy.value = copy.value.map(part => content(part));
    } else {
      throw new Error(PRIVACY_ERROR);
    }
    return copy;
  };
  const content = (value: unknown): unknown => {
    if (!isRecord(value)) throw new Error(PRIVACY_ERROR);
    const copy = { ...value };
    switch (copy.type) {
      case 'text':
        field(copy, 'text');
        break;
      case 'reasoning':
        if (copy.providerOptions) {
          // Old signed history may contain private source text. Reject rather
          // than either leak it or change bytes that the provider will verify.
          queue(copy.text, redacted => {
            if (redacted !== copy.text) throw new Error(SIGNED_REASONING_ERROR);
          });
        } else {
          field(copy, 'text');
        }
        break;
      case 'file':
        file(copy);
        break;
      case 'tool-call':
        field(copy, 'input');
        break;
      case 'tool-result':
        copy.output = output(copy.output, copy.toolName);
        break;
      case 'tool-approval-response':
        field(copy, 'reason');
        break;
      default:
        // New/custom multimodal parts need an explicit privacy adapter.
        throw new Error(BINARY_ERROR);
    }
    return copy;
  };
  const prompt = params.prompt.map(message => {
    if (message.role === 'system') {
      const copy = { ...message };
      queue(copy.content, value => {
        if (typeof value !== 'string') throw new Error(PRIVACY_ERROR);
        copy.content = value;
      });
      return copy;
    }
    return { ...message, content: message.content.map(part => content(part)) };
  });
  const redacted = await privacy.transform('redact', values);
  if (!Array.isArray(redacted) || redacted.length !== apply.length) throw new Error(PRIVACY_ERROR);
  redacted.forEach((value, index) => apply[index](value));
  return { ...params, prompt: prompt as LanguageModelV4CallOptions['prompt'] };
}

async function restoreToolCall(
  call: LanguageModelV4ToolCall,
  privacy: ModelPrivacy,
): Promise<LanguageModelV4ToolCall> {
  let input: unknown;
  try {
    input = JSON.parse(call.input);
  } catch {
    // Let the SDK report malformed JSON. It cannot execute this tool call.
    return call;
  }
  const restored = await privacy.transform('restore', input);
  return { ...call, input: JSON.stringify(restored) };
}

/** Hold only a possible token suffix, never whole model responses. */
function splitSafeText(text: string): [string, string] {
  const start = text.lastIndexOf(TOKEN_PREFIX);
  if (start >= 0 && text.indexOf(']', start) < 0) {
    if (text.length - start > 256) throw new Error(PRIVACY_ERROR);
    return [text.slice(0, start), text.slice(start)];
  }
  for (let length = TOKEN_PREFIX.length - 1; length > 0; length--) {
    if (text.endsWith(TOKEN_PREFIX.slice(0, length))) {
      return [text.slice(0, -length), text.slice(-length)];
    }
  }
  return [text, ''];
}

export function createModelPrivacyMiddleware(
  privacy: ModelPrivacy,
  context: ModelPrivacyContext = {},
): LanguageModelMiddleware {
  const restoreText = async (text: string) => {
    const value = await privacy.transform('restore', text);
    if (typeof value !== 'string') throw new Error(PRIVACY_ERROR);
    return value;
  };
  return {
    specificationVersion: 'v4',
    transformParams: ({ params }) => redactModelPrompt(
      params, privacy, context.getOpenAIChatAssistantFields?.(),
    ),
    wrapGenerate: async ({ doGenerate }) => {
      // The SDK awaits transformed params before entering this provider handoff.
      await privacy.transform('restore', []);
      if (!privacy.enabled) return doGenerate();
      const result = await doGenerate();
      const content: LanguageModelV4Content[] = [];
      for (const part of result.content) {
        content.push(part.type === 'tool-call'
          ? await restoreToolCall(part, privacy)
          : part.type === 'text' ? { ...part, text: await restoreText(part.text) } : part);
      }
      return { ...result, content };
    },
    wrapStream: async ({ doStream }) => {
      await privacy.transform('restore', []);
      if (!privacy.enabled) return doStream();
      const result = await doStream();
      const pending = new Map<string, { text: string; chunk: Extract<LanguageModelV4StreamPart, { type: 'text-delta' }> }>();
      const flush = async (
        controller: TransformStreamDefaultController<LanguageModelV4StreamPart>,
        id?: string,
      ) => {
        for (const [key, entry] of [...pending]) {
          if (id !== undefined && key !== id) continue;
          pending.delete(key);
          if (entry.text) controller.enqueue({ ...entry.chunk, delta: await restoreText(entry.text) });
        }
      };
      return {
        ...result,
        stream: result.stream.pipeThrough(new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
          async transform(chunk, controller) {
            if (chunk.type === 'text-delta') {
              const [safe, suffix] = splitSafeText((pending.get(chunk.id)?.text ?? '') + chunk.delta);
              pending.set(chunk.id, { text: suffix, chunk });
              if (safe) controller.enqueue({ ...chunk, delta: await restoreText(safe) });
              return;
            }
            if (chunk.type === 'text-end') await flush(controller, chunk.id);
            if (chunk.type === 'finish' || chunk.type === 'error') await flush(controller);
            controller.enqueue(chunk.type === 'tool-call' ? await restoreToolCall(chunk, privacy) : chunk);
          },
          flush,
        })),
      };
    },
  };
}

export function protectModel(
  model: LanguageModelV4,
  privacy?: ModelPrivacy,
  context?: ModelPrivacyContext,
): LanguageModelV4 {
  return privacy ? wrapLanguageModel({ model, middleware: createModelPrivacyMiddleware(privacy, context) }) : model;
}

/** OpenAI-compatible reasoning_content is injected after SDK prompt conversion. */
export async function redactOpenAIChatAssistantFields(
  fields: Array<OpenAIChatAssistantFields | undefined>,
  privacy: ModelPrivacy,
): Promise<Array<OpenAIChatAssistantFields | undefined>> {
  if (!privacy.enabled) {
    await privacy.transform('redact', []);
    return fields;
  }
  const text = fields.map(entry => typeof entry?.reasoning_content === 'string'
    ? entry.reasoning_content : null);
  const redacted = await privacy.transform('redact', text);
  if (!Array.isArray(redacted) || redacted.length !== fields.length) throw new Error(PRIVACY_ERROR);
  return fields.map((entry, index) => {
    if (text[index] === null) return entry;
    if (typeof redacted[index] !== 'string') throw new Error(PRIVACY_ERROR);
    return { ...entry, reasoning_content: redacted[index] };
  });
}
