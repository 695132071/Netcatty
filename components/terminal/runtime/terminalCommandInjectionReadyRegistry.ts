export interface TerminalCommandInjectionReadyOptions {
  /** Keep a typed draft. Sensitive prompts, alt-screen, and non-prompts still block. */
  allowDraft?: boolean;
}

const commandInjectionReadyReaders = new Map<
  string,
  (options?: TerminalCommandInjectionReadyOptions) => boolean
>();

export function registerTerminalCommandInjectionReadyReader(
  sessionId: string,
  reader: (options?: TerminalCommandInjectionReadyOptions) => boolean,
): () => void {
  commandInjectionReadyReaders.set(sessionId, reader);
  return () => {
    if (commandInjectionReadyReaders.get(sessionId) === reader) {
      commandInjectionReadyReaders.delete(sessionId);
    }
  };
}

/** True when the live terminal reports a shell prompt ready for injection. */
export function isTerminalReadyForCommandInjection(
  sessionId: string,
  options?: TerminalCommandInjectionReadyOptions,
): boolean {
  return commandInjectionReadyReaders.get(sessionId)?.(options) === true;
}
