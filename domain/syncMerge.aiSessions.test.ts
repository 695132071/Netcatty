import test from "node:test";
import assert from "node:assert/strict";

import { mergeAiSessionLists, mergeSyncPayloads, stripAiSessionDeviceState, stripAiSessionPayloadForSync } from "./syncMerge.ts";
import type { SyncPayload } from "./sync.ts";
import { encodeSdkSessionIdentity } from "../infrastructure/ai/harness/sdkSessionIdentity.ts";
import { buildExternalAgentHistoryMessagesForBridge } from "../components/ai/externalAgentHistory.ts";

type Session = NonNullable<SyncPayload["aiSessions"]>[number];

function payload(overrides: Partial<SyncPayload> = {}): SyncPayload {
  return {
    hosts: [],
    keys: [],
    identities: [],
    snippets: [],
    customGroups: [],
    snippetPackages: [],
    notes: [],
    noteGroups: [],
    portForwardingRules: [],
    groupConfigs: [],
    aiSessions: [],
    settings: undefined,
    syncedAt: 0,
    ...overrides,
  };
}

const msg = (id: string, timestamp: number) => ({ id, role: "user" as const, content: id, timestamp });
const session = (id: string, updatedAt: number, messages: ReturnType<typeof msg>[]) =>
  ({ id, title: id, agentId: "catty", scope: { type: "global" }, messages, createdAt: 0, updatedAt }) as Session;

test("ai sessions: union by session id", () => {
  const base = payload({ aiSessions: [session("s1", 100, [msg("m1", 10)])] });
  const local = payload({ aiSessions: [session("s1", 100, [msg("m1", 10)]), session("s-local", 120, [msg("l1", 20)])] });
  const remote = payload({ aiSessions: [session("s1", 100, [msg("m1", 10)]), session("s-remote", 130, [msg("r1", 30)])] });

  const merged = mergeSyncPayloads(base, local, remote);
  const ids = new Set(merged.payload.aiSessions?.map((s) => s.id));
  assert.deepEqual([...ids].sort(), ["s-local", "s-remote", "s1"]);
});

test("ai sessions: messages merge append-only — both devices' turns survive", () => {
  const base = payload({ aiSessions: [session("s1", 100, [msg("m1", 10)])] });
  // Local appended turn 2, remote appended turn 3 — a last-writer-wins merge would drop one.
  const local = payload({ aiSessions: [session("s1", 200, [msg("m1", 10), msg("m2", 20)])] });
  const remote = payload({ aiSessions: [session("s1", 300, [msg("m1", 10), msg("m3", 30)])] });

  const merged = mergeSyncPayloads(base, local, remote);
  const s1 = merged.payload.aiSessions?.find((s) => s.id === "s1");
  assert.deepEqual((s1?.messages ?? []).map((m) => m.id), ["m1", "m2", "m3"]);
});

test("ai sessions: messages are ordered by timestamp", () => {
  const base = payload({ aiSessions: [session("s1", 100, [])] });
  const local = payload({ aiSessions: [session("s1", 200, [msg("late", 90), msg("early", 5)])] });
  const remote = payload({ aiSessions: [session("s1", 300, [msg("mid", 50)])] });

  const merged = mergeSyncPayloads(base, local, remote);
  const s1 = merged.payload.aiSessions?.find((s) => s.id === "s1");
  assert.deepEqual((s1?.messages ?? []).map((m) => m.timestamp), [5, 50, 90]);
});

test("ai sessions: title/metadata come from the newer side", () => {
  const base = payload({ aiSessions: [session("s1", 100, [])] });
  const older = { ...session("s1", 150, []), title: "older-title" } as Session;
  const newer = { ...session("s1", 250, []), title: "newer-title" } as Session;

  const merged = mergeSyncPayloads(base, payload({ aiSessions: [older] }), payload({ aiSessions: [newer] }));
  assert.equal(merged.payload.aiSessions?.find((s) => s.id === "s1")?.title, "newer-title");
});

test("ai sessions: deletions follow the strategy (both-sides vs preserveDeletions)", () => {
  const base = payload({ aiSessions: [session("s1", 100, []), session("s2", 100, [])] });
  const local = payload({ aiSessions: [session("s1", 100, [])] });
  const remote = base;

  const destructive = mergeSyncPayloads(base, local, remote);
  assert.deepEqual((destructive.payload.aiSessions ?? []).map((s) => s.id), ["s1"]);

  const preserved = mergeSyncPayloads(base, local, remote, { preserveDeletions: true });
  assert.deepEqual(((preserved.payload.aiSessions ?? []).map((s) => s.id)).sort(), ["s1", "s2"]);
});

test("ai sessions: missing field on one side falls back to the other", () => {
  const base = payload();
  const withSessions = payload({ aiSessions: [session("s1", 100, [msg("m1", 1)])] });
  const withoutSessions = { ...payload() } as SyncPayload;
  delete (withoutSessions as { aiSessions?: unknown }).aiSessions;

  const merged = mergeSyncPayloads(base, withoutSessions, withSessions);
  assert.deepEqual((merged.payload.aiSessions ?? []).map((s) => s.id), ["s1"]);
});

test("stripAiSessionPayloadForSync removes inline attachment blobs but keeps metadata", () => {
  const [stripped] = stripAiSessionPayloadForSync([
    {
      id: "s1",
      title: "t",
      messages: [
        {
          id: "m1",
          role: "user",
          content: "look",
          attachments: [{ base64Data: "AAAA", mediaType: "image/png", filename: "a.png", lineCount: 3 }],
        },
      ],
    } as unknown as Session,
  ]);

  const attachment = (stripped.messages?.[0] as unknown as { attachments?: Array<Record<string, unknown>> }).attachments?.[0];
  assert.ok(attachment, "attachment metadata should survive");
  assert.equal(attachment?.base64Data, "", "inline blob must be stripped");
  assert.equal(attachment?.contentUnavailable, true);
  assert.equal(attachment?.filename, "a.png");
  assert.equal(attachment?.lineCount, 3);
});

test("ai sessions: merge is idempotent", () => {
  const base = payload({ aiSessions: [session("s1", 100, [msg("m1", 1)])] });
  const local = payload({ aiSessions: [session("s1", 200, [msg("m1", 1), msg("m2", 2)])] });
  const remote = payload({ aiSessions: [session("s1", 300, [msg("m1", 1), msg("m3", 3)])] });

  const first = mergeSyncPayloads(base, local, remote);
  const second = mergeSyncPayloads(base, first.payload, remote);
  const s1 = second.payload.aiSessions?.find((s) => s.id === "s1");
  assert.deepEqual((s1?.messages ?? []).map((m) => m.id), ["m1", "m2", "m3"]);
});


test("ai sessions: old or opted-out clients omit chats without deleting the known baseline", () => {
  const base = payload({ aiSessions: [session("s1", 100, [msg("m1", 1)])] });
  const oldClient = payload();
  delete oldClient.aiSessions;
  for (const [local, remote] of [[oldClient, base], [base, oldClient], [oldClient, oldClient]]) {
    assert.deepEqual(mergeSyncPayloads(base, local, remote).payload.aiSessions, base.aiSessions);
  }
  assert.deepEqual(mergeSyncPayloads(base, payload(), base).payload.aiSessions, []);
  assert.equal(Object.hasOwn(mergeSyncPayloads(null, oldClient, oldClient).payload, 'aiSessions'), false);
});

test("ai sessions: completed messages replace their streamed copy on the newer side", () => {
  const partial = session("s1", 100, [{ ...msg("m1", 1), content: "Hel" }]);
  const complete = session("s1", 200, [{ ...msg("m1", 1), content: "Hello world" }]);
  for (const [local, remote] of [[partial, complete], [complete, partial]]) {
    const result = mergeAiSessionLists([local], [remote]);
    assert.equal(result[0].messages.length, 1);
    assert.equal(result[0].messages[0].content, "Hello world");
  }
});

test("ai sessions: a new turn survives deletion on the other device", () => {
  const initial = session("s1", 100, [msg("m1", 1)]);
  const edited = session("s1", 200, [msg("m1", 1), msg("m2", 2)]);
  const base = payload({ aiSessions: [initial] });
  const modified = payload({ aiSessions: [edited] });
  for (const [local, remote] of [[modified, payload()], [payload(), modified]]) {
    const result = mergeSyncPayloads(base, local, remote);
    assert.deepEqual(result.payload.aiSessions, [edited]);
    assert.equal(result.hadConflicts, true);
  }
});

test("cloud attachment whitelist excludes previews, paths, data URLs and arbitrary body properties", () => {
  const attachment = {
    base64Data: "U0VDUkVU", mediaType: "text/plain", filename: "terminal.txt",
    terminalSelection: true, vaultNoteId: "note-1", vaultNoteTitle: "My note", lineCount: 2,
    previewText: "SECRET", filePath: "/private/file", dataUrl: "data:text/plain;base64,U0VDUkVU",
    futureBody: "SECRET",
  };
  const original = [{ messages: [{ attachments: [attachment], images: [attachment] }] }];
  const [stripped] = stripAiSessionPayloadForSync(original);
  const expected = {
    base64Data: "", contentUnavailable: true, mediaType: "text/plain", filename: "terminal.txt",
    terminalSelection: true, vaultNoteId: "note-1", vaultNoteTitle: "My note", lineCount: 2,
  };
  assert.deepEqual(stripped.messages[0].attachments, [expected]);
  assert.deepEqual(stripped.messages[0].images, [expected]);
  assert.equal(original[0].messages[0].attachments[0].base64Data, "U0VDUkVU");
});

test("merging metadata-only history preserves available attachment bytes on this device", () => {
  const attachment = {
    base64Data: "U0VDUkVU", mediaType: "image/png", filename: "a.png",
    previewText: "preview", filePath: "/private/a.png",
  };
  const local = { ...session("s1", 100, [msg("m1", 1)]), messages: [{ ...msg("m1", 1), attachments: [attachment], images: [attachment] }] };
  const [incoming] = stripAiSessionPayloadForSync([{ ...local, updatedAt: 200, title: "remote title" }]);
  const [merged] = mergeAiSessionLists([local], [incoming]);
  assert.equal(merged.title, "remote title");
  assert.deepEqual(merged.messages[0].attachments, [attachment]);
  assert.deepEqual(merged.messages[0].images, [attachment]);
  assert.equal(incoming.messages[0].attachments[0].base64Data, "");
});


test("new attachment representation keeps bytes from the legacy image list", () => {
  const attachment = { base64Data: "SU1BR0U=", mediaType: "image/png", filename: "a.png" };
  const local = { ...session("s1", 100, [msg("m1", 1)]), messages: [{ ...msg("m1", 1), images: [attachment] }] };
  const incoming = { ...session("s1", 200, [msg("m1", 1)]), messages: [{ ...msg("m1", 1), attachments: [{ ...attachment, base64Data: "", contentUnavailable: true }] }] };
  const [merged] = mergeAiSessionLists<Session>([local], [incoming]);
  assert.equal(merged.messages[0].attachments?.[0].base64Data, "SU1BR0U=");
});


test("cloud copies start a fresh external SDK thread and replay the saved history", () => {
  for (const [backend, runtime] of [["claude", "sdk"], ["codex", "sdk"], ["codex", "app-server"], ["cursor", "sdk"]]) {
    const original: Session = {
      ...session("s1", 100, [msg("m1", 1)]),
      externalSessionId: encodeSdkSessionIdentity("source-thread", backend, "/source/bin/agent", runtime),
    };
    const [cloud] = stripAiSessionPayloadForSync([original]);
    assert.equal(Object.hasOwn(cloud, "externalSessionId"), false, `${backend}/${runtime}`);
    assert.equal(original.externalSessionId?.includes("source-thread"), true);
    const restored = mergeAiSessionLists<Session>([], [cloud])[0];
    assert.equal(restored.externalSessionId, undefined);
    assert.ok(buildExternalAgentHistoryMessagesForBridge(restored.messages, restored.externalSessionId)?.length);
  }
});

test("cloud copies clear source-only work state while preserving portable replay metadata", () => {
  const source: Session = {
    ...session("s1", 100, [msg("m1", 1)]),
    messages: [{
      id: "a1", role: "assistant", timestamp: 2, content: "Saved tool-output-source-123",
      statusText: "Waiting for approval", executionStatus: "running",
      pendingApproval: { approvalId: "source-approval", toolCallId: "call1", toolName: "exec", toolArgs: {}, status: "pending" },
      providerContinuation: {
        source: { providerConfigId: "provider-1", providerType: "anthropic", modelId: "claude" },
        reasoningParts: [{ text: "checked", providerOptions: { anthropic: { signature: "signed-thinking" } } }],
      },
    }],
    contextCompaction: { summary: "Earlier context", compactedMessageCount: 1 },
  };
  const [cloud] = stripAiSessionPayloadForSync([source]);
  assert.equal(cloud.messages[0].pendingApproval, undefined);
  assert.equal(cloud.messages[0].statusText, undefined);
  assert.equal(cloud.messages[0].executionStatus, "cancelled");
  assert.doesNotMatch(cloud.messages[0].content, /tool-output-source-123/);
  assert.deepEqual(cloud.messages[0].providerContinuation, source.messages[0].providerContinuation);
  assert.deepEqual(cloud.contextCompaction, source.contextCompaction);
  assert.equal(source.messages[0].executionStatus, "running");
  assert.equal(source.messages[0].pendingApproval?.approvalId, "source-approval");
});


test("cloud application device cleanup preserves attachment bytes for existing local storage", () => {
  const source: Session = {
    ...session("s1", 100, [msg("m1", 1)]), externalSessionId: "source-thread",
    messages: [{ ...msg("m1", 1), attachments: [{ mediaType: "image/png", base64Data: "SU1BR0U=", filename: "a.png", filePath: "/local/a.png" }] }],
  };
  const clean = stripAiSessionDeviceState(source);
  assert.equal(clean.externalSessionId, undefined);
  assert.deepEqual(clean.messages[0].attachments, source.messages[0].attachments);
  assert.equal(source.externalSessionId, "source-thread");
});
