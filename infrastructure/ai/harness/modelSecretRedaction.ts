const REDACTED = '[REDACTED]';
const reversibleSessions = new Set<string>();

/** Only bypass legacy masking when a fail-closed model boundary owns this chat. */
export function setReversibleModelPrivacy(chatSessionId: string, enabled: boolean): void {
  if (enabled) reversibleSessions.add(chatSessionId);
  else reversibleSessions.delete(chatSessionId);
}

export function hasReversibleModelPrivacy(chatSessionId?: string): boolean {
  return !!chatSessionId && reversibleSessions.has(chatSessionId);
}

const PRIVATE_KEY_PATTERN = /-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----[\s\S]*?-----END \1-----/g;
const BEARER_PATTERN = /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const URL_CREDENTIAL_PATTERN = /([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@]+)(@)/gi;
const QUOTED_SECRET_ASSIGNMENT_PATTERN = /(["'])([A-Za-z0-9_.-]*(?:password|passwd|passphrase|pwd|token|secret|api[_-]?key|access[_-]?key|secret[_-]?key|private[_-]?key|credential)[A-Za-z0-9_.-]*)\1\s*([:=])\s*(["'])((?:\\.|(?!\4)[\s\S])*?)\4/gi;
const QUOTED_VALUE_SECRET_ASSIGNMENT_PATTERN = /\b([A-Za-z0-9_.-]*(?:password|passwd|passphrase|pwd|token|secret|api[_-]?key|access[_-]?key|secret[_-]?key|private[_-]?key|credential)[A-Za-z0-9_.-]*)\s*([:=])\s*(["'])((?:\\.|(?!\3)[\s\S])*?)\3/gi;
const SECRET_ASSIGNMENT_PATTERN = /\b([A-Za-z0-9_.-]*(?:password|passwd|passphrase|pwd|token|secret|api[_-]?key|access[_-]?key|secret[_-]?key|private[_-]?key|credential)[A-Za-z0-9_.-]*)\s*([:=])\s*(["']?)([^\s"',;]+)\3/gi;
const SECRET_CLI_FLAG_PATTERN = /(--(?:password|passwd|passphrase|token|secret|api-key|access-key|secret-key|private-key))\s+(?:["']([^"']+)["']|([^\s]+))/gi;
const WELL_KNOWN_TOKEN_PATTERN = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,})\b/g;

function isSecretKey(key: string): boolean {
  const normalized = key.replace(/[^A-Za-z0-9]/g, '').toLocaleLowerCase();
  return /(?:password|passwd|passphrase|pwd|token|secret|apikey|accesskey|secretkey|privatekey|credential|credentials)$/.test(normalized);
}

/** Redacts likely credentials only on data that is about to become model-visible. */
export function redactSecretsForModel(value: string, chatSessionId?: string): string {
  if (hasReversibleModelPrivacy(chatSessionId)) return value;
  if (!value) return value;
  return value
    .replace(PRIVATE_KEY_PATTERN, REDACTED)
    .replace(BEARER_PATTERN, '$1 [REDACTED]')
    .replace(URL_CREDENTIAL_PATTERN, `$1${REDACTED}$3`)
    .replace(QUOTED_SECRET_ASSIGNMENT_PATTERN, '$1$2$1$3$4[REDACTED]$4')
    .replace(QUOTED_VALUE_SECRET_ASSIGNMENT_PATTERN, '$1$2$3[REDACTED]$3')
    .replace(SECRET_ASSIGNMENT_PATTERN, '$1$2[REDACTED]')
    .replace(SECRET_CLI_FLAG_PATTERN, '$1 [REDACTED]')
    .replace(WELL_KNOWN_TOKEN_PATTERN, REDACTED);
}

/** Recursively redacts model-visible event arguments without mutating the source value. */
export function redactSecretsInValueForModel<T>(value: T, chatSessionId?: string): T {
  if (hasReversibleModelPrivacy(chatSessionId)) return value;
  if (typeof value === 'string') return redactSecretsForModel(value, chatSessionId) as T;
  if (Array.isArray(value)) return value.map(entry => redactSecretsInValueForModel(entry, chatSessionId)) as T;
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => [
        key,
        isSecretKey(key) ? REDACTED : redactSecretsInValueForModel(entry, chatSessionId),
      ]),
  ) as T;
}
