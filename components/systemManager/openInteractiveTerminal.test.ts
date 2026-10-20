import test from 'node:test';
import assert from 'node:assert/strict';

import type { TerminalSession } from '../../types';
import { openInteractiveTerminal } from './openInteractiveTerminal';

const parentSession = (overrides: Partial<TerminalSession> = {}): TerminalSession => ({
  id: 'session-1',
  hostId: 'host-1',
  hostLabel: 'Prod',
  hostname: 'prod.example.com',
  username: 'deploy',
  status: 'connected',
  protocol: 'ssh',
  port: 22,
  ...overrides,
});

test('openInteractiveTerminal opens command popups over SSH even when the source host uses Mosh', async () => {
  const payloads: unknown[] = [];
  const backend = {
    openTerminalPopup: async (payload: unknown) => {
      payloads.push(payload);
      return { success: true };
    },
  };

  await openInteractiveTerminal(
    backend as never,
    parentSession({ moshEnabled: true }),
    'docker: api',
    'docker exec -it abc123 sh',
  );

  assert.equal(payloads.length, 1);
  assert.deepEqual(payloads[0], {
    title: 'Prod · docker: api',
    icon: undefined,
    parentSessionId: 'session-1',
    startupCommand: 'docker exec -it abc123 sh',
    sourceSession: {
      ...parentSession({ moshEnabled: true }),
      protocol: 'ssh',
      moshEnabled: false,
      etEnabled: false,
      startupCommand: 'docker exec -it abc123 sh',
      reuseConnectionFromSessionId: undefined,
    },
  });
});

test('openInteractiveTerminal opens command popups over SSH even when the source host uses ET', async () => {
  const payloads: unknown[] = [];
  const backend = {
    openTerminalPopup: async (payload: unknown) => {
      payloads.push(payload);
      return { success: true };
    },
  };

  await openInteractiveTerminal(
    backend as never,
    parentSession({ protocol: 'et' as TerminalSession['protocol'], etEnabled: true }),
    'tmux: api',
    'tmux attach-session -t api',
  );

  const payload = payloads[0] as { sourceSession: TerminalSession };
  assert.equal(payload.sourceSession.protocol, 'ssh');
  assert.equal(payload.sourceSession.moshEnabled, false);
  assert.equal(payload.sourceSession.etEnabled, false);
  assert.equal(payload.sourceSession.reuseConnectionFromSessionId, undefined);
});

test('openInteractiveTerminal keeps SSH connection reuse for ordinary connected SSH parents', async () => {
  const payloads: unknown[] = [];
  const backend = {
    openTerminalPopup: async (payload: unknown) => {
      payloads.push(payload);
      return { success: true };
    },
  };

  await openInteractiveTerminal(
    backend as never,
    parentSession(),
    'logs: api',
    'docker logs -f abc123',
  );

  const payload = payloads[0] as { sourceSession: TerminalSession };
  assert.equal(payload.sourceSession.moshEnabled, false);
  assert.equal(payload.sourceSession.protocol, 'ssh');
  assert.equal(payload.sourceSession.reuseConnectionFromSessionId, 'session-1');
});

async function withSystemPanels(
  panels: Array<{ getBoundingClientRect: () => { x: number; y: number; width: number; height: number } }>,
  run: () => Promise<void>,
): Promise<void> {
  const previous = globalThis.document;
  globalThis.document = {
    querySelectorAll(selector: string) {
      return selector === '[data-section="system-manager-panel"]' ? panels : [];
    },
  } as unknown as Document;
  try {
    await run();
  } finally {
    if (previous === undefined) {
      delete (globalThis as { document?: Document }).document;
    } else {
      globalThis.document = previous;
    }
  }
}

test('openInteractiveTerminal passes the system panel rectangle so the shell can avoid it', async () => {
  const panel = {
    getBoundingClientRect: () => ({ x: 1000, y: 40, width: 440, height: 860 }),
  };
  const payloads: Array<{ avoidClientRect?: { x: number; width: number } }> = [];
  await withSystemPanels([panel], async () => {
    await openInteractiveTerminal(
      {
        openTerminalPopup: async (payload: { avoidClientRect?: { x: number; width: number } }) => {
          payloads.push(payload);
          return { success: true };
        },
      } as never,
      parentSession(),
      'pod: multi-box',
      'kubectl exec -it multi-box -- sh',
    );
  });

  assert.deepEqual(payloads[0]?.avoidClientRect, { x: 1000, y: 40, width: 440, height: 860 });
});

test('openInteractiveTerminal skips a parked zero-size system panel and avoids the visible one', async () => {
  const parked = {
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 0, height: 0 }),
  };
  const visible = {
    getBoundingClientRect: () => ({ x: 1000, y: 40, width: 440, height: 860 }),
  };
  const payloads: Array<{ avoidClientRect?: { x: number; y: number; width: number; height: number } }> = [];
  await withSystemPanels([parked, visible], async () => {
    await openInteractiveTerminal(
      {
        openTerminalPopup: async (payload: { avoidClientRect?: { x: number; y: number; width: number; height: number } }) => {
          payloads.push(payload);
          return { success: true };
        },
      } as never,
      parentSession(),
      'pod: multi-box',
      'kubectl exec -it multi-box -- sh',
    );
  });

  assert.deepEqual(payloads[0]?.avoidClientRect, { x: 1000, y: 40, width: 440, height: 860 });
});
