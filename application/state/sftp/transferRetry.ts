import { isSessionError } from "./errors";

/**
 * Errors that are worth an automatic one-shot retry (WinSCP/FileZilla-style
 * "network blip" recovery). Permanent failures (auth, permission, missing
 * path) should not be retried.
 */
export function isTransientTransferError(err: unknown): boolean {
  // The channel is gone. Retrying opens a new dial, and an OTP host then
  // sits on keyboard-interactive while the transfer stays active.
  if (err instanceof Error && /sftp channel closed/i.test(err.message)) return false;
  if (isSessionError(err)) return true;
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes("econnreset")
    || msg.includes("etimedout")
    || msg.includes("econnrefused")
    || msg.includes("epipe")
    || msg.includes("socket hang up")
    || msg.includes("network")
    || msg.includes("temporarily unavailable")
    || msg.includes("try again")
    || msg.includes("broken pipe")
  );
}

export function isTransferCancelledError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return msg.includes("transfer cancelled") || msg.includes("transfer canceled");
}

export interface RunWithTransferRetryOptions {
  retries?: number;
  delayMs?: number;
  shouldRetry?: (err: unknown, attempt: number) => boolean;
  onRetry?: (err: unknown, attempt: number) => void;
}

/**
 * Run an async transfer step with a small number of automatic retries for
 * transient network / session failures.
 */
export async function runWithTransferRetry<T>(
  work: (attempt: number) => Promise<T>,
  options: RunWithTransferRetryOptions = {},
): Promise<T> {
  const retries = Math.max(0, options.retries ?? 1);
  const delayMs = Math.max(0, options.delayMs ?? 400);
  const shouldRetry = options.shouldRetry ?? ((err, attempt) => (
    attempt < retries
    && !isTransferCancelledError(err)
    && isTransientTransferError(err)
  ));

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await work(attempt);
    } catch (err) {
      lastError = err;
      if (!shouldRetry(err, attempt)) throw err;
      options.onRetry?.(err, attempt + 1);
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs * (attempt + 1)));
      }
    }
  }
  throw lastError;
}
