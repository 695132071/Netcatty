import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAgentHostWorkspace } from './agentHostWorkspace';

test('current resolves only to an existing workspace, not a terminal tab', () => {
  assert.deepEqual(resolveAgentHostWorkspace('current', 'ws-1', ['ws-1']), { workspaceId: 'ws-1' });
  assert.match(resolveAgentHostWorkspace('current', 'terminal-1', ['ws-1']).error ?? '', /workspace/i);
});

test('explicit missing workspace is rejected without standalone fallback', () => {
  assert.match(resolveAgentHostWorkspace('missing', 'ws-1', ['ws-1']).error ?? '', /workspace/i);
  assert.deepEqual(resolveAgentHostWorkspace('ws-1', 'other', ['ws-1']), { workspaceId: 'ws-1' });
  assert.deepEqual(resolveAgentHostWorkspace(undefined, 'ws-1', ['ws-1']), {});
});
