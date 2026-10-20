import { compressVerboseText, truncateTextWithHeadAndTail } from '../requestPayloadCompression';
import type { ToolOutputStore } from './toolOutputStore';
import { redactSecretsForModel } from './modelSecretRedaction';

export const MAX_LIVE_TOOL_STRING_CHARS = 8_000;

export interface FitLargeToolResultForModelInput {
  result: unknown;
  capabilityId: string;
  chatSessionId?: string;
  toolOutputStore?: ToolOutputStore;
  terminalSessionId?: string;
  maxStringChars?: number;
  normalizeStrings?: boolean;
}

export function fitLargeToolResultForModel({
  result,
  capabilityId,
  chatSessionId,
  toolOutputStore,
  terminalSessionId,
  maxStringChars = MAX_LIVE_TOOL_STRING_CHARS,
  normalizeStrings = false,
}: FitLargeToolResultForModelInput): unknown {
  return fitValue(result, {
    capabilityId,
    chatSessionId,
    toolOutputStore,
    terminalSessionId,
    maxStringChars,
    normalizeStrings,
    path: [],
  });
}

interface FitValueContext {
  capabilityId: string;
  chatSessionId?: string;
  toolOutputStore?: ToolOutputStore;
  terminalSessionId?: string;
  maxStringChars: number;
  normalizeStrings: boolean;
  path: string[];
}

function fitValue(value: unknown, ctx: FitValueContext): unknown {
  if (typeof value === 'string') {
    return fitString(value, ctx);
  }

  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((entry, index) => {
      const fitted = fitValue(entry, {
        ...ctx,
        path: [...ctx.path, `[${index}]`],
      });
      if (fitted !== entry) changed = true;
      return fitted;
    });
    return changed ? next : value;
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const fitted = fitValue(entry, {
      ...ctx,
      path: [...ctx.path, key],
    });
    if (fitted !== entry) changed = true;
    next[key] = fitted;
  }

  return changed ? next : value;
}

function fitString(value: string, ctx: FitValueContext): string {
  const safeValue = redactSecretsForModel(value, ctx.chatSessionId);
  const normalizedValue = ctx.normalizeStrings ? compressVerboseText(safeValue) : safeValue;
  if (safeValue.length <= ctx.maxStringChars && normalizedValue.length <= ctx.maxStringChars) {
    return normalizedValue;
  }

  const fitted = truncateTextWithHeadAndTail(
    ctx.normalizeStrings ? normalizedValue : compressVerboseText(safeValue),
    ctx.maxStringChars,
  );
  if (fitted === safeValue) return safeValue;

  let handleId: string | undefined;
  if (ctx.toolOutputStore && ctx.chatSessionId) {
    handleId = ctx.toolOutputStore.store({
      chatSessionId: ctx.chatSessionId,
      capabilityId: ctx.capabilityId,
      content: value,
      sessionId: ctx.terminalSessionId,
    }).id;
  }

  return appendToolOutputHandleNotice(fitted, {
    capabilityId: ctx.capabilityId,
    fieldPath: formatFieldPath(ctx.path),
    totalChars: value.length,
    handleId,
    restartPersistenceAvailable: false,
  });
}

function formatFieldPath(path: string[]): string {
  if (path.length === 0) return '$';
  return path
    .map((part, index) => {
      if (part.startsWith('[')) return part;
      return index === 0 ? part : `.${part}`;
    })
    .join('');
}

function appendToolOutputHandleNotice(
  fitted: string,
  details: {
    capabilityId: string;
    fieldPath: string;
    totalChars: number;
    handleId?: string;
    restartPersistenceAvailable?: boolean;
  },
): string {
  const handleSuffix = details.handleId ? ` handleId=${details.handleId}` : '';
  const restartSuffix = details.handleId && details.restartPersistenceAvailable === false
    ? ' restartPersistence=unavailable (read before closing the app)'
    : '';
  return `${fitted}\n\n[tool output handle: capability=${details.capabilityId} field=${details.fieldPath} chars=${details.totalChars} truncated for model context${handleSuffix}${restartSuffix}]`;
}
