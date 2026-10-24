import assert from "node:assert/strict";
import test from "node:test";

import { decideHiddenTabKeepCountAction } from "../../domain/terminalHibernate.ts";
import { retainLeavingTabAfterEviction } from "./hiddenTabEviction.ts";
import { terminalHiddenRendererStore } from "./terminalHiddenRendererStore.ts";

test("a refused eviction tries the next candidate, then full-hibernates", async () => {
  const attempts: string[] = [];
  const outcomes: string[] = [];
  await retainLeavingTabAfterEviction({
    sessionId: "leaving",
    candidates: ["images", "plain"],
    keepCount: 2,
    stillWantsRetention: () => true,
    softHide: () => outcomes.push("soft-hide"),
    fullHibernate: () => outcomes.push("full-hibernate"),
    evict: async (sessionId) => {
      attempts.push(sessionId);
      return sessionId === "plain";
    },
  });
  assert.deepEqual(attempts, ["images", "plain"]);
  assert.deepEqual(outcomes, ["soft-hide"]);

  const blocked: string[] = [];
  const blockedOutcomes: string[] = [];
  await retainLeavingTabAfterEviction({
    sessionId: "leaving",
    candidates: ["images", "also-images"],
    keepCount: 2,
    stillWantsRetention: () => true,
    softHide: () => blockedOutcomes.push("soft-hide"),
    fullHibernate: () => blockedOutcomes.push("full-hibernate"),
    evict: async (sessionId) => {
      blocked.push(sessionId);
      return false;
    },
  });
  assert.deepEqual(blocked, ["images", "also-images"]);
  assert.deepEqual(blockedOutcomes, ["full-hibernate"]);
  assert.equal(terminalHiddenRendererStore.getSoftHiddenOccupancy(), 0);
});

test("hibernate failure after the soft-hidden marker drops does not retain the leaving tab", async () => {
  const attempts: string[] = [];
  const outcomes: string[] = [];
  await retainLeavingTabAfterEviction({
    sessionId: "leaving",
    candidates: ["victim"],
    keepCount: 2,
    stillWantsRetention: () => true,
    softHide: () => outcomes.push("soft-hide"),
    fullHibernate: () => outcomes.push("full-hibernate"),
    evict: async (sessionId) => {
      attempts.push(sessionId);
      await Promise.resolve();
      return false;
    },
  });
  assert.deepEqual(attempts, ["victim"]);
  assert.deepEqual(outcomes, ["full-hibernate"]);

  const recovered: string[] = [];
  const recoveredOutcomes: string[] = [];
  await retainLeavingTabAfterEviction({
    sessionId: "leaving",
    candidates: ["victim", "next"],
    keepCount: 2,
    stillWantsRetention: () => true,
    softHide: () => recoveredOutcomes.push("soft-hide"),
    fullHibernate: () => recoveredOutcomes.push("full-hibernate"),
    evict: async (sessionId) => {
      recovered.push(sessionId);
      await Promise.resolve();
      return sessionId === "next";
    },
  });
  assert.deepEqual(recovered, ["victim", "next"]);
  assert.deepEqual(recoveredOutcomes, ["soft-hide"]);
});

test("a live keep count that still fits after eviction soft-hides the leaving tab", async () => {
  let keepCount = 0;
  const outcomes: string[] = [];
  await retainLeavingTabAfterEviction({
    sessionId: "leaving",
    candidates: ["victim"],
    keepCount,
    resolveKeepCount: () => keepCount,
    stillWantsRetention: () => true,
    softHide: () => outcomes.push("soft-hide"),
    fullHibernate: () => outcomes.push("full-hibernate"),
    evict: async () => {
      keepCount = 2;
      await Promise.resolve();
      return true;
    },
  });
  assert.deepEqual(outcomes, ["soft-hide"]);
  assert.equal(terminalHiddenRendererStore.getSoftHiddenOccupancy(), 0);
});

test("a keep count dropped to zero during eviction full-hibernates the leaving tab", async () => {
  let keepCount = 2;
  const outcomes: string[] = [];
  await retainLeavingTabAfterEviction({
    sessionId: "leaving",
    candidates: ["victim"],
    keepCount,
    resolveKeepCount: () => keepCount,
    stillWantsRetention: () => true,
    softHide: () => outcomes.push("soft-hide"),
    fullHibernate: () => outcomes.push("full-hibernate"),
    evict: async () => {
      keepCount = 0;
      await Promise.resolve();
      return true;
    },
  });
  assert.deepEqual(outcomes, ["full-hibernate"]);
  assert.equal(terminalHiddenRendererStore.getSoftHiddenOccupancy(), 0);
});

test("a keep count that no longer fits after eviction full-hibernates the leaving tab", async () => {
  const sessions = ["victim", "other", "leaving"];
  for (const sessionId of sessions) terminalHiddenRendererStore.clearSoftHidden(sessionId);
  terminalHiddenRendererStore.markSoftHidden("other");
  let keepCount = 2;
  const outcomes: string[] = [];
  try {
    await retainLeavingTabAfterEviction({
      sessionId: "leaving",
      candidates: ["victim"],
      keepCount,
      resolveKeepCount: () => keepCount,
      stillWantsRetention: () => true,
      softHide: () => outcomes.push("soft-hide"),
      fullHibernate: () => outcomes.push("full-hibernate"),
      evict: async () => {
        keepCount = 1;
        await Promise.resolve();
        return true;
      },
    });
    assert.deepEqual(outcomes, ["full-hibernate"]);
    assert.equal(terminalHiddenRendererStore.isSoftHidden("leaving"), false);
  } finally {
    for (const sessionId of sessions) terminalHiddenRendererStore.clearSoftHidden(sessionId);
  }
});

test("a leaving tab that no longer wants retention is not soft-hidden or hibernated", async () => {
  const outcomes: string[] = [];
  await retainLeavingTabAfterEviction({
    sessionId: "leaving",
    candidates: ["victim"],
    keepCount: 2,
    stillWantsRetention: () => false,
    softHide: () => outcomes.push("soft-hide"),
    fullHibernate: () => outcomes.push("full-hibernate"),
    evict: async () => true,
  });
  assert.deepEqual(outcomes, []);
  assert.equal(terminalHiddenRendererStore.getSoftHiddenOccupancy(), 0);
});

test("a pending reservation keeps a second tab from seeing spare capacity", async () => {
  const sessions = ["victim", "other", "leaving"];
  for (const sessionId of sessions) terminalHiddenRendererStore.clearSoftHidden(sessionId);
  terminalHiddenRendererStore.markSoftHidden("victim");
  terminalHiddenRendererStore.markSoftHidden("other");

  const unsubscribe = terminalHiddenRendererStore.subscribe(() => {
    if (!terminalHiddenRendererStore.consumeEvictionRequest("victim")) return;
    terminalHiddenRendererStore.clearSoftHidden("victim");
  });

  const outcomes: string[] = [];
  const pending = retainLeavingTabAfterEviction({
    sessionId: "leaving",
    candidates: ["victim"],
    keepCount: 2,
    stillWantsRetention: () => true,
    softHide: () => {
      terminalHiddenRendererStore.markSoftHidden("leaving");
      outcomes.push("soft-hide");
    },
    fullHibernate: () => outcomes.push("full-hibernate"),
    evict: (sessionId) => terminalHiddenRendererStore.evictSoftHidden(sessionId),
  });

  try {
    assert.equal(terminalHiddenRendererStore.isSoftHidden("victim"), false);
    assert.equal(terminalHiddenRendererStore.getSoftHiddenCount(), 1);
    assert.equal(terminalHiddenRendererStore.getSoftHiddenOccupancy(), 2);
    assert.deepEqual(decideHiddenTabKeepCountAction({
      keepCount: 2,
      softHiddenCount: terminalHiddenRendererStore.getSoftHiddenOccupancy(),
      sessionId: "second",
      candidatesOldestFirst: terminalHiddenRendererStore.listSoftHiddenOldestFirst(),
    }), { action: "await-eviction", candidates: ["other"] });

    terminalHiddenRendererStore.settleEviction("victim", true);
    await pending;
    assert.deepEqual(outcomes, ["soft-hide"]);
    assert.equal(terminalHiddenRendererStore.getSoftHiddenCount(), 2);
    assert.equal(terminalHiddenRendererStore.getSoftHiddenOccupancy(), 2);
  } finally {
    unsubscribe();
    terminalHiddenRendererStore.settleEviction("victim", false);
    for (const sessionId of sessions) terminalHiddenRendererStore.clearSoftHidden(sessionId);
    await pending.catch(() => undefined);
  }
});

test("two leaving tabs share one freed slot and stay within keep-count", async () => {
  const sessions = ["victim", "other", "leaving-a", "leaving-b"];
  for (const sessionId of sessions) terminalHiddenRendererStore.clearSoftHidden(sessionId);
  terminalHiddenRendererStore.markSoftHidden("victim");
  terminalHiddenRendererStore.markSoftHidden("other");

  const unsubscribe = terminalHiddenRendererStore.subscribe(() => {
    if (!terminalHiddenRendererStore.consumeEvictionRequest("victim")) return;
    terminalHiddenRendererStore.clearSoftHidden("victim");
    queueMicrotask(() => {
      terminalHiddenRendererStore.settleEviction("victim", true);
    });
  });

  const retained: string[] = [];
  const hibernated: string[] = [];
  const retain = (sessionId: string) => retainLeavingTabAfterEviction({
    sessionId,
    candidates: ["victim"],
    keepCount: 2,
    stillWantsRetention: () => true,
    softHide: () => {
      terminalHiddenRendererStore.markSoftHidden(sessionId);
      retained.push(sessionId);
    },
    fullHibernate: () => hibernated.push(sessionId),
  });

  try {
    await Promise.all([retain("leaving-a"), retain("leaving-b")]);
    assert.equal(retained.length, 1);
    assert.equal(hibernated.length, 1);
    assert.equal(terminalHiddenRendererStore.getSoftHiddenCount(), 2);
    assert.equal(terminalHiddenRendererStore.getSoftHiddenOccupancy(), 2);
  } finally {
    unsubscribe();
    for (const sessionId of sessions) terminalHiddenRendererStore.clearSoftHidden(sessionId);
  }
});
