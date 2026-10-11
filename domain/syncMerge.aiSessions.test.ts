import test from "node:test";
import assert from "node:assert/strict";

import { mergeSyncPayloads, stripAiSessionPayloadForSync } from "./syncMerge.ts";
import type { SyncPayload } from "./sync.ts";

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
  assert.equal(attachment?.base64Data, undefined, "inline blob must be stripped");
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
