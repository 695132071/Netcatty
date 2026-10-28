import assert from 'node:assert/strict';
import test from 'node:test';

import type { AISession, ExternalAgentConfig } from '../../infrastructure/ai/types.ts';
import {
  buildAiChatsListingEntries,
  formatAiChatsListingNote,
  resolveChatAgentLabel,
  truncateChatTitle,
} from './aiChatsListing.ts';

function createSession(
  id: string,
  overrides: Partial<AISession> = {},
): AISession {
  return {
    id,
    title: id,
    agentId: 'catty',
    scope: { type: 'workspace', targetId: 'ws-1' },
    messages: [],
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

const t = (key: string) => key;
const externalAgents: ExternalAgentConfig[] = [
  { id: 'claude', name: 'Claude Code' } as ExternalAgentConfig,
];

function buildEntries(sessions: AISession[], activeSessionId: string | null = 's-live') {
  return buildAiChatsListingEntries({
    sessions,
    activeSessionId,
    externalAgents,
    workspaces: [{ id: 'ws-1', title: 'Web farm' }],
    liveTerminalIds: new Set(['term-1']),
    scopeTargetId: 'ws-1',
    t,
  });
}

test('/chats listing marks the live workspace chat, terminal chat and dangling chat', () => {
  const now = Date.now();
  const sessions = [
    createSession('s-live', { scope: { type: 'workspace', targetId: 'ws-1' }, updatedAt: now }),
    createSession('s-term', { scope: { type: 'terminal', targetId: 'term-1' }, agentId: 'claude', updatedAt: now }),
    createSession('s-dangling', { scope: { type: 'workspace', targetId: 'ws-gone' }, updatedAt: now }),
  ];

  const entries = buildEntries(sessions);
  assert.equal(entries.length, 3);

  assert.equal(entries[0].isCurrent, true);
  assert.equal(entries[0].agentLabel, 'Catty Agent');
  assert.equal(entries[0].scopeLabel, 'ai.chat.chatsScopeWorkspace: Web farm');
  assert.equal(entries[0].isDangling, false);

  assert.equal(entries[1].isCurrent, false);
  assert.equal(entries[1].agentLabel, 'Claude Code');
  assert.equal(entries[1].scopeLabel, 'ai.chat.chatsScopeTerminal');
  assert.equal(entries[1].isDangling, false);

  assert.equal(entries[2].isDangling, true);
  assert.equal(entries[2].scopeLabel, 'ai.chat.chatsScopeDangling');
});

test('/chats listing falls back to the panel scope label for the current workspace', () => {
  const sessions = [
    createSession('s-live', { scope: { type: 'workspace', targetId: 'ws-1' } }),
  ];
  const entries = buildAiChatsListingEntries({
    sessions,
    activeSessionId: 's-live',
    externalAgents,
    workspaces: [],
    liveTerminalIds: new Set<string>(),
    currentScopeLabel: 'Web farm',
    scopeTargetId: 'ws-1',
    t,
  });
  assert.equal(entries[0].isDangling, false);
  assert.equal(entries[0].scopeLabel, 'ai.chat.chatsScopeWorkspace: Web farm');
});

test('/chats note renders header, current marker and one line per chat', () => {
  const sessions = [
    createSession('s-live', { title: 'Fix deploy' }),
    createSession('s-term', { title: 'Logs', scope: { type: 'terminal', targetId: 'term-1' }, agentId: 'claude' }),
    createSession('s-dangling', { title: 'Old', scope: { type: 'workspace', targetId: 'ws-gone' } }),
  ];
  const entries = buildEntries(sessions);
  const note = formatAiChatsListingNote(entries, t);
  const lines = note.split('\n');
  assert.equal(lines[0], 'ai.chat.chatsHeader');
  assert.equal(lines.length, 4);
  assert.match(lines[1], /^• Fix deploy — Catty Agent · /);
  assert.match(lines[2], /^ {2}Logs — Claude Code · /);
  assert.match(lines[3], /ai\.chat\.chatsScopeDangling/);
  assert.ok(!lines[3].startsWith('•'));
});

test('/chats note reports an empty panel', () => {
  assert.equal(formatAiChatsListingNote([], t), 'ai.chat.chatsEmpty');
});

test('truncateChatTitle clamps long titles and keeps short ones intact', () => {
  assert.equal(truncateChatTitle('short'), 'short');
  assert.equal(truncateChatTitle('  '), '');
  const long = 'x'.repeat(80);
  const truncated = truncateChatTitle(long);
  assert.equal(truncated.length, 42);
  assert.ok(truncated.endsWith('…'));
});

test('resolveChatAgentLabel resolves external agents and falls back to the raw id', () => {
  assert.equal(resolveChatAgentLabel('catty', externalAgents), 'Catty Agent');
  assert.equal(resolveChatAgentLabel('claude', externalAgents), 'Claude Code');
  assert.equal(resolveChatAgentLabel('mystery', externalAgents), 'mystery');
});
