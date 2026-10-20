import {
  parseQuickConnectInputWithWarnings,
  type QuickConnectTarget,
} from "../domain/quickConnect";

export interface QuickConnectOpenRequest {
  target: QuickConnectTarget;
  warnings: string[];
}

type QuickConnectOpener = (request: QuickConnectOpenRequest) => void;

let opener: QuickConnectOpener | null = null;

/** Vault owns the single QuickConnectWizard. The switcher asks it to open. */
export function registerQuickConnectOpener(next: QuickConnectOpener): () => void {
  opener = next;
  return () => {
    if (opener === next) opener = null;
  };
}

export function openQuickConnectFromInput(input: string): boolean {
  const parsed = parseQuickConnectInputWithWarnings(input);
  if (!parsed.target || !opener) return false;
  opener({ target: parsed.target, warnings: parsed.warnings });
  return true;
}
