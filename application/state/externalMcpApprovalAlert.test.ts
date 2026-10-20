import assert from 'node:assert/strict';
import test from 'node:test';

import { presentExternalMcpApprovalNotification } from './externalMcpApprovalAlert.ts';

const t = (key: string, values?: Record<string, string | number | boolean | null | undefined>) => {
  if (key === 'ai.externalMcp.approvalAlert.notificationTitle') return 'External MCP approval';
  if (key === 'ai.externalMcp.approvalAlert.notificationBody') return `${values?.tool} is waiting for approval`;
  if (key === 'ai.externalMcp.approvalAlert.notificationBodyOnHost') {
    return `${values?.tool} on ${values?.host} is waiting for approval`;
  }
  return key;
};

test('approval alerts stay quiet when the preference is off', () => {
  const calls: unknown[] = [];
  const shown = presentExternalMcpApprovalNotification({
    toolName: 'sftp.write',
    dedupeKey: 'mcp_approval_1',
    mode: 'off',
    t,
    notify: (payload) => calls.push(payload),
  });
  assert.equal(shown, false);
  assert.deepEqual(calls, []);
});

test('unfocused approval alerts name the tool and host and defer focus to the main process', () => {
  const calls: Array<{ title: string; body: string; whenUnfocused: boolean; dedupeKey: string }> = [];
  const shown = presentExternalMcpApprovalNotification({
    toolName: 'sftp.write',
    hostLabel: 'bastion',
    dedupeKey: 'mcp_approval_2',
    mode: 'unfocused',
    t,
    notify: (payload) => calls.push(payload),
  });
  assert.equal(shown, true);
  assert.deepEqual(calls, [{
    title: 'External MCP approval',
    body: 'sftp.write on bastion is waiting for approval',
    dedupeKey: 'mcp_approval_2',
    whenUnfocused: true,
  }]);
});

test('always approval alerts notify even while a window may be focused', () => {
  const calls: Array<{ title: string; body: string; whenUnfocused: boolean; dedupeKey: string }> = [];
  presentExternalMcpApprovalNotification({
    toolName: 'terminal.execute',
    dedupeKey: 'mcp_approval_3',
    mode: 'always',
    t,
    notify: (payload) => calls.push(payload),
  });
  assert.deepEqual(calls, [{
    title: 'External MCP approval',
    body: 'terminal.execute is waiting for approval',
    dedupeKey: 'mcp_approval_3',
    whenUnfocused: false,
  }]);
});
