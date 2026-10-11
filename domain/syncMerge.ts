/**
 * Three-Way Merge for Cloud Sync Payloads
 *
 * Implements a Git-style three-way merge using a stored "base" snapshot
 * (the last successfully synced payload) to detect per-entity changes
 * on both the local and remote sides.
 *
 * Algorithm:
 *   For each entity (identified by `id`):
 *     - Only in local  → local addition  → keep
 *     - Only in remote → remote addition → keep
 *     - In base, removed locally   → local deletion  → remove (unless remote modified)
 *     - In base, removed remotely  → remote deletion → remove (unless local modified)
 *     - Modified only locally      → keep local version
 *     - Modified only remotely     → keep remote version
 *     - Modified on both sides     → prefer local (conflict logged)
 *
 * When no base is available (first sync), falls back to a set-union
 * merge by entity ID, preferring local for duplicates.
 *
 * With `preserveDeletions` the merge becomes non-destructive: a deletion
 * observed on a single side is never propagated to the other side, because
 * a missing entity is ambiguous — it may mean "deleted", or it may mean the
 * device simply has not loaded / holds a partial vault (for example right
 * after restoring an older local backup, or when the keychain failed).
 * Entities are only removed when *both* sides dropped them. This is the
 * "smart merge (keep all)" strategy; see `domain/syncStrategy.ts`.
 */

import { carryForwardSyncDeletions, getDeletedEntityIds } from './syncReliability';
import {
  sanitizeHostsForSync,
  type CloudSyncPayloadEntityKey,
  type SyncPayload,
} from './sync';
import { mergePluginSyncSidecarsThreeWay } from './pluginSyncSidecar';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

interface MergeSummary {
  added: { local: number; remote: number };
  deleted: { local: number; remote: number };
  modified: { local: number; remote: number; conflicts: number };
}

interface MergeResult {
  payload: SyncPayload;
  /** True when both sides modified the same entity (resolved by preferring local) */
  hadConflicts: boolean;
  summary: MergeSummary;
}

/** Options controlling how a payload merge treats one-sided deletions. */
export interface MergeSyncPayloadsOptions {
  /**
   * When true, a deletion seen on a single side is not propagated: the entity
   * is carried forward from whichever side still has it. Only entities that
   * are absent from base, local *and* remote are removed.
   *
   * Rationale: absence is not proof of intent. A restored-from-backup vault,
   * a partially loaded vault, or a failed keychain read all look like "the
   * user deleted everything". Propagating that to the cloud is how a small
   * local mistake used to wipe every other device.
   */
  preserveDeletions?: boolean;
}

interface EntityMergeOptions {
  preserveDeletions?: boolean;
}

const OPTIONAL_ENTITY_KEYS = new Set<CloudSyncPayloadEntityKey>([
  'identities',
  'proxyProfiles',
  'snippetPackages',
  'notes',
  'noteGroups',
  'portForwardingRules',
  'groupConfigs',
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Deterministic JSON string for content comparison.
 * Sorts object keys to avoid false diffs from key ordering.
 */
function fingerprint(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.keys(v).sort().reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = (v as Record<string, unknown>)[k];
        return acc;
      }, {});
    }
    return v;
  });
}

function entityArray<T>(
  payload: SyncPayload,
  key: CloudSyncPayloadEntityKey,
  fallback: T[],
): T[] {
  if (
    OPTIONAL_ENTITY_KEYS.has(key)
    && !Object.prototype.hasOwnProperty.call(payload, key)
  ) {
    return fallback;
  }
  const value = payload[key];
  return Array.isArray(value) ? value as T[] : [];
}

// ---------------------------------------------------------------------------
// Entity-array merge (hosts, keys, identities, snippets, etc.)
// ---------------------------------------------------------------------------

interface EntityMergeResult<T> {
  merged: T[];
  conflicts: number;
  added: { local: number; remote: number };
  deleted: { local: number; remote: number };
  modified: { local: number; remote: number };
}

function mergeEntityArrays<T extends { id: string }>(
  base: T[],
  local: T[],
  remote: T[],
  tombstones?: { local: Set<string>; remote: Set<string> },
  options?: EntityMergeOptions,
): EntityMergeResult<T> {
  const baseMap = new Map(base.map((e) => [e.id, e]));
  const localMap = new Map(local.map((e) => [e.id, e]));
  const remoteMap = new Map(remote.map((e) => [e.id, e]));

  const allIds = new Set([
    ...baseMap.keys(),
    ...localMap.keys(),
    ...remoteMap.keys(),
  ]);

  const merged: T[] = [];
  let conflicts = 0;
  const added = { local: 0, remote: 0 };
  const deleted = { local: 0, remote: 0 };
  const modified = { local: 0, remote: 0 };

  for (const id of allIds) {
    const baseItem = baseMap.get(id);
    const localItem = localMap.get(id);
    const remoteItem = remoteMap.get(id);

    const inBase = baseItem !== undefined;
    const inLocal = localItem !== undefined;
    const inRemote = remoteItem !== undefined;

    if (!inBase && inLocal && !inRemote && tombstones?.remote.has(id)) {
      // Remote explicitly records this entity as deleted. When no base is
      // available, this tombstone is the only durable signal that absence is
      // intentional rather than an old client omitting the entity.
      deleted.remote++;
    } else if (!inBase && !inLocal && inRemote && tombstones?.local.has(id)) {
      deleted.local++;
    } else if (!inBase && inLocal && !inRemote) {
      // Local addition
      merged.push(localItem);
      added.local++;
    } else if (!inBase && !inLocal && inRemote) {
      // Remote addition
      merged.push(remoteItem);
      added.remote++;
    } else if (!inBase && inLocal && inRemote) {
      // Both added same ID — prefer local
      merged.push(localItem);
      if (fingerprint(localItem) !== fingerprint(remoteItem)) {
        conflicts++;
      }
    } else if (inBase && inLocal && inRemote) {
      // Exists in all three — compare changes
      const localChanged = fingerprint(localItem) !== fingerprint(baseItem);
      const remoteChanged = fingerprint(remoteItem) !== fingerprint(baseItem);

      if (!localChanged && !remoteChanged) {
        merged.push(baseItem);
      } else if (localChanged && !remoteChanged) {
        merged.push(localItem);
        modified.local++;
      } else if (!localChanged && remoteChanged) {
        merged.push(remoteItem);
        modified.remote++;
      } else {
        // Both changed — prefer local
        merged.push(localItem);
        if (fingerprint(localItem) !== fingerprint(remoteItem)) {
          conflicts++;
        }
        modified.local++;
        modified.remote++;
      }
    } else if (inBase && !inLocal && inRemote) {
      // Local deleted
      const remoteChanged = fingerprint(remoteItem) !== fingerprint(baseItem);
      if (remoteChanged) {
        // Remote modified + local deleted → keep modification (safer)
        merged.push(remoteItem);
        conflicts++;
      } else if (options?.preserveDeletions) {
        // Non-destructive mode: the other side still has it and did not touch
        // it, so the absence is not trustworthy enough to delete it for
        // everyone. Carry it forward and still record the local deletion.
        merged.push(remoteItem);
        deleted.local++;
      } else {
        deleted.local++;
      }
    } else if (inBase && inLocal && !inRemote) {
      // Remote deleted
      const localChanged = fingerprint(localItem) !== fingerprint(baseItem);
      if (localChanged) {
        // Local modified + remote deleted → keep modification (safer)
        merged.push(localItem);
        conflicts++;
      } else if (options?.preserveDeletions) {
        merged.push(localItem);
        deleted.remote++;
      } else {
        deleted.remote++;
      }
    }
    // inBase && !inLocal && !inRemote → both deleted → gone (in every mode)
  }

  return { merged, conflicts, added, deleted, modified };
}

// ---------------------------------------------------------------------------
// AI session merge (messages are append-only)
// ---------------------------------------------------------------------------

/**
 * Strip inline attachment payloads before they enter a sync payload.
 * Base64 image/PDF blobs would multiply the encrypted vault size and can
 * carry data the user never intended to leave the device; only the metadata
 * (filename, media type, line count) is worth keeping for context.
 */
export function stripAiSessionPayloadForSync<T extends { messages?: unknown[] }>(
  sessions: T[] | undefined,
): T[] {
  if (!Array.isArray(sessions)) return [];
  return sessions.map((session) => {
    const messages = Array.isArray((session as { messages?: unknown[] }).messages)
      ? (session as { messages: Array<Record<string, unknown>> }).messages.map((message) => {
        if (!message || typeof message !== 'object') return message;
        const { attachments, images, ...rest } = message as Record<string, unknown> & {
          attachments?: unknown[];
          images?: unknown[];
        };
        if (attachments === undefined && images === undefined) return rest;
        return {
          ...rest,
          ...(attachments ? { attachments: stripAttachmentBlobs(attachments) } : {}),
          ...(images ? { images: stripAttachmentBlobs(images) } : {}),
        };
      })
      : [];
    return { ...session, messages } as T;
  });
}

function stripAttachmentBlobs(attachments: unknown[]): unknown[] {
  if (!Array.isArray(attachments)) return attachments;
  return attachments.map((attachment) => {
    if (!attachment || typeof attachment !== 'object') return attachment;
    const { base64Data: _base64Data, ...meta } = attachment as Record<string, unknown> & { base64Data?: string };
    return meta;
  });
}

/**
 * Three-way merge for AI sessions.
 *
 * Sessions are unioned by id. Inside a session the message list is
 * append-only: a message is identified by its id, and the merged transcript is
 * the union of all three sides sorted by timestamp. Two devices that appended
 * different turns to the same conversation therefore keep both — which is what
 * a plain last-writer-wins merge would silently throw away.
 */
function mergeAiSessionArrays<T extends { id: string; updatedAt?: number; messages?: Array<{ id?: string; timestamp?: number }> }>(
  base: T[],
  local: T[],
  remote: T[],
  options?: EntityMergeOptions,
): EntityMergeResult<T> {
  const baseMap = new Map(base.map((e) => [e.id, e]));
  const localMap = new Map(local.map((e) => [e.id, e]));
  const remoteMap = new Map(remote.map((e) => [e.id, e]));
  const allIds = new Set([...baseMap.keys(), ...localMap.keys(), ...remoteMap.keys()]);

  const merged: T[] = [];
  let conflicts = 0;
  const added = { local: 0, remote: 0 };
  const deleted = { local: 0, remote: 0 };
  const modified = { local: 0, remote: 0 };

  for (const id of allIds) {
    const baseItem = baseMap.get(id);
    const localItem = localMap.get(id);
    const remoteItem = remoteMap.get(id);
    const inBase = baseItem !== undefined;
    const inLocal = localItem !== undefined;
    const inRemote = remoteItem !== undefined;

    if (!inBase && inLocal && !inRemote) {
      merged.push(localItem as T);
      added.local++;
      continue;
    }
    if (!inBase && !inLocal && inRemote) {
      merged.push(remoteItem as T);
      added.remote++;
      continue;
    }
    if (!inBase && inLocal && inRemote) {
      merged.push(mergeAiSessionPair(localItem as T, remoteItem as T));
      conflicts++;
      continue;
    }
    if (inBase && inLocal && inRemote) {
      merged.push(mergeAiSessionPair(localItem as T, remoteItem as T));
      if (fingerprint(localItem) !== fingerprint(remoteItem)) {
        modified.local++;
        modified.remote++;
        conflicts++;
      }
      continue;
    }
    if (inBase && inLocal && !inRemote) {
      if (options?.preserveDeletions) {
        merged.push(localItem as T);
        deleted.remote++;
      } else {
        deleted.remote++;
      }
      continue;
    }
    if (inBase && !inLocal && inRemote) {
      if (options?.preserveDeletions) {
        merged.push(remoteItem as T);
        deleted.local++;
      } else {
        deleted.local++;
      }
      continue;
    }
    // absent everywhere → gone
  }

  return { merged, conflicts, added, deleted, modified };
}

/**
 * Merge an incoming session list into the local one (union by session id,
 * append-only messages). Used when applying a downloaded payload so a
 * cloud snapshot can never drop turns that only exist locally.
 */
export function mergeAiSessionLists<
  T extends { id: string; updatedAt?: number; messages?: Array<{ id?: string; timestamp?: number }> },
>(local: T[] | undefined, incoming: T[] | undefined): T[] {
  return mergeAiSessionArrays<T>([], local ?? [], incoming ?? []).merged;
}

function mergeAiSessionPair<T extends { id: string; updatedAt?: number; messages?: Array<{ id?: string; timestamp?: number }> }>(
  a: T,
  b: T,
): T {
  const newer = (b.updatedAt ?? 0) > (a.updatedAt ?? 0) ? b : a;
  const seen = new Map<string, (typeof a.messages extends Array<infer M> ? M : never)>();
  for (const session of [a, b, newer]) {
    for (const message of (session.messages ?? []) as Array<{ id?: string; timestamp?: number }>) {
      const key = message.id ?? `${message.timestamp ?? 0}:${fingerprint(message)}`;
      if (!seen.has(key)) seen.set(key, message);
    }
  }
  const messages = [...seen.values()].sort((x, y) => (x.timestamp ?? 0) - (y.timestamp ?? 0));
  return { ...newer, messages, updatedAt: Math.max(a.updatedAt ?? 0, b.updatedAt ?? 0) } as T;
}

// ---------------------------------------------------------------------------
// String-array merge (customGroups, snippetPackages)
// ---------------------------------------------------------------------------

function mergeStringArrays(
  base: string[],
  local: string[],
  remote: string[],
  tombstones?: { local: Set<string>; remote: Set<string> },
  options?: EntityMergeOptions,
): string[] {
  const baseSet = new Set(base);
  const localSet = new Set(local);
  const remoteSet = new Set(remote);

  const result = new Set<string>();

  // Start with base items, then apply additions/deletions
  const allValues = new Set([...baseSet, ...localSet, ...remoteSet]);

  for (const value of allValues) {
    const inBase = baseSet.has(value);
    const inLocal = localSet.has(value);
    const inRemote = remoteSet.has(value);

    if (!inBase && inLocal && !inRemote && tombstones?.remote.has(value)) {
      // Remote tombstone wins over a stale local value when no base exists.
    } else if (!inBase && !inLocal && inRemote && tombstones?.local.has(value)) {
      // Local tombstone wins over a stale remote value when no base exists.
    } else if (!inBase) {
      // Addition — keep if either side added it
      if (inLocal || inRemote) result.add(value);
    } else {
      // Was in base — keep unless both sides deleted
      const localDeleted = !inLocal;
      const remoteDeleted = !inRemote;
      if (localDeleted && remoteDeleted) {
        // Both deleted — gone
      } else if (localDeleted || remoteDeleted) {
        // Only one side dropped it. In non-destructive mode the surviving side
        // wins so a stale/partial vault cannot delete a group for everyone.
        if (!options?.preserveDeletions) {
          // Honour the deletion (existing behaviour)
        } else {
          result.add(value);
        }
      } else {
        result.add(value);
      }
    }
  }

  return [...result];
}

// ---------------------------------------------------------------------------
// Settings merge (flat key-value)
// ---------------------------------------------------------------------------

type SettingsObj = NonNullable<SyncPayload['settings']>;

/** Check if an array contains objects with `id` fields (for entity merge). */
function isIdArray(arr: unknown[]): boolean {
  return arr.length > 0 && typeof arr[0] === 'object' && arr[0] !== null && 'id' in arr[0];
}

/** Treat an explicit empty object as a reset marker during the first cloud merge. */
function isEmptyPlainObject(value: unknown): value is Record<string, never> {
  return value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0;
}

/** Recursively merge two plain objects against a base using three-way logic. */
function mergeSettingsDeep(
  base: Record<string, unknown>,
  local: Record<string, unknown>,
  remote: Record<string, unknown>,
  preferRemoteOnConflict: boolean,
): Record<string, unknown> {
  const allKeys = new Set([
    ...Object.keys(base),
    ...Object.keys(local),
    ...Object.keys(remote),
  ]);
  const merged: Record<string, unknown> = {};
  for (const key of allKeys) {
    const bVal = base[key];
    const lVal = local[key];
    const rVal = remote[key];
    const lChanged = fingerprint(lVal) !== fingerprint(bVal);
    const rChanged = fingerprint(rVal) !== fingerprint(bVal);

    if (!lChanged && !rChanged) {
      if (bVal !== undefined) merged[key] = bVal;
    } else if (lChanged && !rChanged) {
      if (lVal !== undefined) merged[key] = lVal;
    } else if (!lChanged && rChanged) {
      if (rVal !== undefined) merged[key] = rVal;
    } else {
      // Both changed — recurse if both are plain objects, else prefer local
      if (
        lVal && rVal &&
        typeof lVal === 'object' && !Array.isArray(lVal) &&
        typeof rVal === 'object' && !Array.isArray(rVal)
      ) {
        merged[key] = preferRemoteOnConflict && isEmptyPlainObject(rVal)
          ? rVal
          : mergeSettingsDeep(
            (bVal && typeof bVal === 'object' && !Array.isArray(bVal) ? bVal : {}) as Record<string, unknown>,
            lVal as Record<string, unknown>,
            rVal as Record<string, unknown>,
            preferRemoteOnConflict,
          );
      } else if (
        preferRemoteOnConflict &&
        Array.isArray(lVal) && Array.isArray(rVal) &&
        (isIdArray(lVal) || isIdArray(rVal) || isIdArray(Array.isArray(bVal) ? bVal as unknown[] : []))
      ) {
        const bArr = Array.isArray(bVal) ? bVal as Array<{ id: string }> : [];
        const result = mergeEntityArrays(
          bArr,
          rVal as Array<{ id: string }>,
          lVal as Array<{ id: string }>,
        );
        merged[key] = result.merged;
      } else if (preferRemoteOnConflict && rVal !== undefined) {
        merged[key] = rVal;
      } else if (lVal !== undefined) {
        merged[key] = lVal;
      }
    }
  }
  return merged;
}

function mergeSettings(
  base: SettingsObj | undefined,
  local: SettingsObj | undefined,
  remote: SettingsObj | undefined,
  preferRemoteOnConflict: boolean,
): SettingsObj | undefined {
  if (!local && !remote) return undefined;
  if (!local) return remote;
  if (!remote) return local;

  const b = base ?? {};
  const allKeys = new Set([
    ...Object.keys(b),
    ...Object.keys(local),
    ...Object.keys(remote),
  ]);

  const merged: Record<string, unknown> = {};

  for (const key of allKeys) {
    const bVal = (b as Record<string, unknown>)[key];
    const lVal = (local as Record<string, unknown>)[key];
    const rVal = (remote as Record<string, unknown>)[key];

    const lChanged = fingerprint(lVal) !== fingerprint(bVal);
    const rChanged = fingerprint(rVal) !== fingerprint(bVal);

    if (!lChanged && !rChanged) {
      if (bVal !== undefined) merged[key] = bVal;
    } else if (lChanged && !rChanged) {
      if (lVal !== undefined) merged[key] = lVal;
    } else if (!lChanged && rChanged) {
      if (rVal !== undefined) merged[key] = rVal;
    } else {
      // Both changed — deep merge if both are plain objects, else prefer local
      if (
        lVal && rVal &&
        typeof lVal === 'object' && !Array.isArray(lVal) &&
        typeof rVal === 'object' && !Array.isArray(rVal)
      ) {
        merged[key] = preferRemoteOnConflict && isEmptyPlainObject(rVal)
          ? rVal
          : mergeSettingsDeep(
            (bVal && typeof bVal === 'object' && !Array.isArray(bVal) ? bVal : {}) as Record<string, unknown>,
            lVal as Record<string, unknown>,
            rVal as Record<string, unknown>,
            preferRemoteOnConflict,
          );
      } else if (
        Array.isArray(lVal) && Array.isArray(rVal) &&
        (isIdArray(lVal) || isIdArray(rVal) || isIdArray(Array.isArray(bVal) ? bVal as unknown[] : []))
      ) {
        // Array of objects with `id` (e.g. customTerminalThemes) — entity merge
        const bArr = Array.isArray(bVal) ? bVal as Array<{ id: string }> : [];
        const preferred = preferRemoteOnConflict ? rVal : lVal;
        const other = preferRemoteOnConflict ? lVal : rVal;
        const result = mergeEntityArrays(
          bArr,
          preferred as Array<{ id: string }>,
          other as Array<{ id: string }>,
        );
        merged[key] = result.merged;
      } else if (preferRemoteOnConflict && rVal !== undefined) {
        merged[key] = rVal;
      } else if (lVal !== undefined) {
        merged[key] = lVal;
      }
    }
  }

  return Object.keys(merged).length > 0 ? (merged as SettingsObj) : undefined;
}

// ---------------------------------------------------------------------------
// Main merge function
// ---------------------------------------------------------------------------

/**
 * Three-way merge of sync payloads.
 *
 * @param base  - The last successfully synced payload (null if unavailable)
 * @param local - The current device's data
 * @param remote - The other device's data (downloaded from cloud)
 * @param options - see {@link MergeSyncPayloadsOptions}
 */
export function mergeSyncPayloads(
  base: SyncPayload | null,
  local: SyncPayload,
  remote: SyncPayload,
  options?: MergeSyncPayloadsOptions,
): MergeResult {
  const preserveDeletions = options?.preserveDeletions === true;
  const mergeOptions: EntityMergeOptions = { preserveDeletions };
  const emptyBase: SyncPayload = {
    hosts: [],
    keys: [],
    identities: [],
    proxyProfiles: [],
    snippets: [],
    customGroups: [],
    snippetPackages: [],
    notes: [],
    noteGroups: [],
    portForwardingRules: [],
    aiSessions: [],
    settings: undefined,
    syncedAt: 0,
  };
  const b = base ?? emptyBase;

  const summary: MergeSummary = {
    added: { local: 0, remote: 0 },
    deleted: { local: 0, remote: 0 },
    modified: { local: 0, remote: 0, conflicts: 0 },
  };
  const tombstones = (entityType: CloudSyncPayloadEntityKey) => ({
    local: getDeletedEntityIds(local, entityType),
    remote: getDeletedEntityIds(remote, entityType),
  });

  // Merge each entity type
  // Normalize host telemetry on all three sides (#2629): the stored base and
  // older remote payloads still carry `lastConnectedAt`, while upgraded local
  // payloads strip it. Without normalization an otherwise-unchanged host looks
  // locally modified, the merge prefers the sanitized local copy, and a real
  // remote edit to that host is silently overwritten on the round trip.
  const hosts = mergeEntityArrays(
    sanitizeHostsForSync(b.hosts) ?? [],
    sanitizeHostsForSync(local.hosts) ?? [],
    sanitizeHostsForSync(remote.hosts) ?? [],
    tombstones('hosts'),
    mergeOptions,
  );
  const keys = mergeEntityArrays(b.keys ?? [], local.keys ?? [], remote.keys ?? [], tombstones('keys'), mergeOptions);
  const baseIdentities = b.identities ?? [];
  const identities = mergeEntityArrays(
    baseIdentities,
    entityArray(local, 'identities', baseIdentities),
    entityArray(remote, 'identities', baseIdentities),
    tombstones('identities'),
    mergeOptions,
  );
  const baseProxyProfiles = b.proxyProfiles ?? [];
  const proxyProfiles = mergeEntityArrays(
    baseProxyProfiles,
    entityArray(local, 'proxyProfiles', baseProxyProfiles),
    entityArray(remote, 'proxyProfiles', baseProxyProfiles),
    tombstones('proxyProfiles'),
    mergeOptions,
  );
  const snippets = mergeEntityArrays(b.snippets ?? [], local.snippets ?? [], remote.snippets ?? [], tombstones('snippets'), mergeOptions);
  const baseNotes = b.notes ?? [];
  const notes = mergeEntityArrays(
    baseNotes,
    entityArray(local, 'notes', baseNotes),
    entityArray(remote, 'notes', baseNotes),
    tombstones('notes'),
    mergeOptions,
  );
  const basePortForwardingRules = b.portForwardingRules ?? [];
  const portForwardingRules = mergeEntityArrays(
    basePortForwardingRules,
    entityArray(local, 'portForwardingRules', basePortForwardingRules),
    entityArray(remote, 'portForwardingRules', basePortForwardingRules),
    tombstones('portForwardingRules'),
    mergeOptions,
  );

  // Merge group configs (keyed by path — wrap with virtual id for entity merge)
  type GCWithId = import('./models').GroupConfig & { id: string };
  const wrapGC = (arr: import('./models').GroupConfig[] | undefined): GCWithId[] =>
    (arr ?? []).map(gc => ({ ...gc, id: gc.path }));
  const unwrapGC = (arr: GCWithId[]): import('./models').GroupConfig[] =>
    arr.map(({ id: _id, ...rest }) => rest as import('./models').GroupConfig);
  const baseGroupConfigs = b.groupConfigs ?? [];
  const groupConfigsResult = mergeEntityArrays(
    wrapGC(baseGroupConfigs),
    wrapGC(entityArray(local, 'groupConfigs', baseGroupConfigs)),
    wrapGC(entityArray(remote, 'groupConfigs', baseGroupConfigs)),
    tombstones('groupConfigs'),
    mergeOptions,
  );

  const baseAiSessions = b.aiSessions ?? [];
  const aiSessions = mergeAiSessionArrays(
    baseAiSessions,
    entityArray(local, 'aiSessions', baseAiSessions),
    entityArray(remote, 'aiSessions', baseAiSessions),
    mergeOptions,
  );

  // Aggregate stats
  const entityResults: Pick<EntityMergeResult<unknown>, 'added' | 'deleted' | 'modified' | 'conflicts'>[] =
    [hosts, keys, identities, proxyProfiles, snippets, notes, portForwardingRules, groupConfigsResult, aiSessions];
  for (const r of entityResults) {
    summary.added.local += r.added.local;
    summary.added.remote += r.added.remote;
    summary.deleted.local += r.deleted.local;
    summary.deleted.remote += r.deleted.remote;
    summary.modified.local += r.modified.local;
    summary.modified.remote += r.modified.remote;
    summary.modified.conflicts += r.conflicts;
  }

  // Merge string arrays
  const customGroups = mergeStringArrays(
    b.customGroups ?? [],
    local.customGroups ?? [],
    remote.customGroups ?? [],
    tombstones('customGroups'),
    mergeOptions,
  );
  const baseSnippetPackages = b.snippetPackages ?? [];
  const snippetPackages = mergeStringArrays(
    baseSnippetPackages,
    entityArray<string>(local, 'snippetPackages', baseSnippetPackages),
    entityArray<string>(remote, 'snippetPackages', baseSnippetPackages),
    tombstones('snippetPackages'),
    mergeOptions,
  );
  const baseNoteGroups = b.noteGroups ?? [];
  const noteGroups = mergeStringArrays(
    baseNoteGroups,
    entityArray<string>(local, 'noteGroups', baseNoteGroups),
    entityArray<string>(remote, 'noteGroups', baseNoteGroups),
    tombstones('noteGroups'),
    mergeOptions,
  );

  // Merge settings
  // With no trusted base, the remote payload represents the established
  // cloud replica while a newly installed client has already persisted its
  // initial defaults. Treating both as additions and preferring local would
  // keep those defaults and make settings appear not to sync at all. Prefer
  // the cloud value only for same-field conflicts on this first merge; fields
  // present on just one side are still preserved. Once a base exists, retain
  // the existing local-wins three-way conflict policy.
  const settings = mergeSettings(
    b.settings,
    local.settings,
    remote.settings,
    base === null,
  );

  // Deduplicate global SFTP bookmarks by path (IDs are random per device)
  if (settings?.sftpGlobalBookmarks && settings.sftpGlobalBookmarks.length > 0) {
    const seenPaths = new Set<string>();
    settings.sftpGlobalBookmarks = settings.sftpGlobalBookmarks.filter((bm) => {
      if (seenPaths.has(bm.path)) return false;
      seenPaths.add(bm.path);
      return true;
    });
  }

  const groupConfigs = unwrapGC(groupConfigsResult.merged);

  // Plugin sidecars: three-way merge so local resets propagate and baselines
  // from missing plugins are preserved. An *omitted* pluginSidecars field means
  // legacy/unsupported (treat as base for that side). Explicit { entries: [] }
  // is an authoritative wipe.
  const baseHasSidecars = Object.prototype.hasOwnProperty.call(b, 'pluginSidecars');
  const localHasSidecars = Object.prototype.hasOwnProperty.call(local, 'pluginSidecars');
  const remoteHasSidecars = Object.prototype.hasOwnProperty.call(remote, 'pluginSidecars');
  const baseSidecars = Array.isArray(b.pluginSidecars?.entries) ? b.pluginSidecars.entries : [];
  const localSidecars = localHasSidecars
    ? (Array.isArray(local.pluginSidecars?.entries) ? local.pluginSidecars.entries : [])
    : baseSidecars;
  const remoteSidecars = remoteHasSidecars
    ? (Array.isArray(remote.pluginSidecars?.entries) ? remote.pluginSidecars.entries : [])
    : baseSidecars;
  const mergedSidecarEntries = mergePluginSyncSidecarsThreeWay({
    base: baseSidecars,
    local: localSidecars,
    remote: remoteSidecars,
  });
  // Emit the field when any side explicitly carried it (including empty reset).
  const anySideHadPluginSidecars = baseHasSidecars || localHasSidecars || remoteHasSidecars;

  const payload: SyncPayload = carryForwardSyncDeletions({
    hosts: hosts.merged,
    keys: keys.merged,
    identities: identities.merged,
    proxyProfiles: proxyProfiles.merged,
    snippets: snippets.merged,
    customGroups,
    snippetPackages,
    notes: notes.merged,
    noteGroups,
    portForwardingRules: portForwardingRules.merged,
    groupConfigs,
    aiSessions: aiSessions.merged,
    settings,
    ...(mergedSidecarEntries.length > 0 || anySideHadPluginSidecars
      ? { pluginSidecars: { version: 1 as const, entries: mergedSidecarEntries } }
      : {}),
    syncedAt: Date.now(),
  }, [local, remote]);

  return {
    payload,
    hadConflicts: summary.modified.conflicts > 0,
    summary,
  };
}
