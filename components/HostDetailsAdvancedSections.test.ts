import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./HostDetailsAdvancedSections.tsx', import.meta.url), 'utf8');

test('advanced host settings expose per-host SSH connection timeouts', () => {
  assert.match(source, /hostDetails\.section\.sshTimeouts/);
  assert.match(source, /value=\{form\.sshTcpConnectTimeoutSeconds \?\?/);
  assert.match(source, /update\("sshTcpConnectTimeoutSeconds", value\)/);
  assert.match(source, /value=\{form\.sshAuthReadyTimeoutSeconds \?\?/);
  assert.match(source, /update\("sshAuthReadyTimeoutSeconds", value\)/);
  assert.equal(source.match(/!Number\.isFinite\(value\)/g)?.length, 2);
});

test('editing enabled SSH agent controls persists the enabled state', () => {
  assert.match(source, /effectiveGroupDefaults,\s*effectiveAuthMethod,/);
  assert.doesNotMatch(source, /resolveHostAuthMethodSelection/);
  assert.match(source, /const systemSshAgentSupported = effectiveAuthMethod === "auto" \|\| effectiveAuthMethod === "key"/);
  assert.match(source, /effectiveAuthMethod === "key" && form\.useSshAgent === true/);
  assert.match(source, /enabled=\{systemSshAgentEnabled\}/);
  assert.match(source, /disabled=\{!systemSshAgentSupported\}/);
  assert.match(source, /resolveSshAgentToggleUpdate\(previous, effectiveAuthMethod, enabling\)/);
  assert.match(source, /\{systemSshAgentEnabled && \(/);
  assert.match(source, /useSshAgent: true,\s*identityAgent:/);
  assert.match(source, /useSshAgent: true,\s*identitiesOnly:/);
});

test('enabling SSH agent login clears an imported none sentinel', () => {
  assert.match(source, /resolveSshAgentToggleUpdate/);
});

test('X11 forwarding display follows the effective host after group defaults', () => {
  assert.match(source, /applyGroupDefaults\(form, effectiveGroupDefaults\)/);
  assert.match(source, /const showX11Forwarding = \(!effectiveConnectionHost\.protocol \|\| effectiveConnectionHost\.protocol === "ssh"\)/);
  assert.match(source, /!effectiveConnectionHost\.moshEnabled/);
  assert.match(source, /!effectiveConnectionHost\.etEnabled/);
  assert.match(source, /const effectiveX11Forwarding = !!effectiveConnectionHost\.x11Forwarding/);
  assert.match(source, /\{showX11Forwarding && \(/);
  assert.match(source, /enabled=\{effectiveX11Forwarding\}/);
  assert.doesNotMatch(source, /effectiveGroupDefaults\?\.x11Forwarding/);
});

test('login and forwarding warnings use independent agent status', () => {
  assert.match(source, /systemSshAgentEnabled && sshAgentStatus && !sshAgentStatus\.running/);
  assert.match(source, /form\.agentForwarding && sshForwardingAgentStatus && !sshForwardingAgentStatus\.running/);
});
