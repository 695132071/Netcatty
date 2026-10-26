# Host and Vault action contract checkpoint

Status: the domain helpers and draft review body exist. The plugin RPC methods,
SDK methods, resource authority, renderer bridge, and connection action are not
registered. This branch does not expose host access to plugins yet.

Base: source integration #3981 at
`4213d8e6726c44e7a479418ece3adf16ea494782`.

## Reusable boundaries

| Concern | Existing contract | Reuse |
| --- | --- | --- |
| Host picker | `components/SelectHostPanelContent.tsx` | Controlled `selectedHostIds` and `onSelectionChange`; group toggles resolve to explicit host IDs. |
| Typed drafts | `ImporterHostDraft` in `packages/plugin-contract/schema/plugin-contract.schema.json` | Create allowlist: label, hostname, username, port, group, tags. Edit allowlist: label, group, tags. |
| Validation and preview | `normalizePluginImporterRecords`, `buildVaultHostFromDraft` | Validate the raw address, normalize the importer draft, validate the normalized result, and show the normalized field diff. |
| Vault writes | `useVaultState.commitVaultImportTransaction` | Existing shared Vault lock, expected host snapshot, encryption, stale-write checks, and journaled persistence. Optional authorization guard runs after encryption. |
| Connection | `AppSideEffects.handleConnectToHost` | Existing saved-settings, group defaults, authentication, logging, and session creation flow. |
| Script disclosure | `applyGroupDefaults`, `hasHostConnectAutomation` | Boolean disclosure covers startup commands, global/group/host connect scripts, unresolved bindings, and output triggers. Script contents remain host-owned. |
| Lifecycle | `PluginHostInteractionService`, `PluginPermissionEngine`, runtime route `assertActive` | Existing window ownership, focus, lock, signed replies, cancellation, and revocation patterns. |
| Source identity | `PluginDatabase` | `getActivePlugin`, `getRetainedPluginSource`, `privateOwner`, and `publicPluginId`; no caller-supplied owner or bare-ID fallback. |

## Proposed public methods

The selected-context owner supplies the final shared handle type and issuance
interface. These names describe the proposed RPC methods. They are not exports.

| Method | Parameters | Result |
| --- | --- | --- |
| `vault.selectHosts` | `{ title: string }` | Cancelled, or selected host metadata with shared resource handles and expected revisions. |
| `vault.requestHostDraft` | Create: `{ draft: { label?, hostname, username?, port?, group?, tags? } }`. Edit: `{ target, expectedRevision, draft: { label?, group?, tags? } }`. | Cancelled, or host-owned save acknowledgement. |
| `vault.requestConnect` | `{ target, expectedRevision }` | Cancelled, or connection-request acknowledgement; no session identifier or session content. |

Selected metadata contains label, hostname, username, optional port, protocol,
group path, tags, and revision. Host IDs remain behind the shared resource handle.
Group metadata describes the explicitly selected current member handles. The
grant never expands when another host joins a group.

Selection grants metadata access only. Each draft save and each connection
requires its own host-owned confirmation. A connection confirmation displays the
saved target and whether saved scripts can run. It does not grant terminal input,
terminal output, or session access.

All requests are bounded and cancel on runtime stop, source replacement, revoke,
Vault lock, owner window replacement, expiry, or user cancellation. The host
revalidates authority and expected revision after asynchronous work and before
the Vault write or connection dispatch.

Proposed bounds reuse `HostInteractionLimits`: one pending request per runtime,
eight total, ten per minute, a 60-second confirmation deadline, and a 64-KiB
request ceiling. Selection adds a maximum of 50 current hosts. Titles use the
existing 128-character single-line limit. Draft field lengths use
`ImporterHostDraft`. Unknown properties are rejected by the shared schema.

The API excludes Vault and renderer stores, the internal MCP catalog, plaintext
credentials, private keys, TOTP configuration, startup scripts, and arbitrary
execution. Host selection and action UI live in Netcatty. Plugin business logic
stays in the sandboxed plugin.

## Shared edit coordination

Task `01a17883-8e8a-71b5-96bc-b0ed0ff05014` owns shared registration changes for
streams and AI. Task `01a17885-57b8-717d-a6fb-8a3ce78c5022` owns selected-context
authority. This branch awaits their handle contract and edit allocation before
changing these files:

- `packages/plugin-contract/schema/plugin-contract.schema.json` and generated outputs.
- `packages/plugin-sdk/src/index.ts`.
- `electron/plugins/runtime/runtimePeer.mjs`.
- `electron/plugins/hostService.cjs`.

Host action work then adds `electron/plugins/hostVaultService.cjs`, its synthetic
entrypoint tests, `application/state/usePluginHostActions.ts`,
`components/plugins/PluginHostActionHost.tsx`, and an example under
`examples/plugins/host-actions/`. Renderer wiring uses `pluginBridge.cjs`,
`electron/preload/api.cjs`, `global.d.ts`, and `App.tsx`.

## Remaining acceptance

Actual-entrypoint tests must cover explicit selection, cancel, stale revision,
locked Vault, host removal and replacement, source/runtime replacement, revoke,
and connection confirmation. The entrypoint suite must verify that selection
alone cannot connect and that script disclosure precedes dispatch.

Native screenshots and video run on the parent's existing cloud GUI. This branch
does not change Electron sandbox or helper permissions. Tests use synthetic hosts
and credentials. No real host connection or credential access is authorized.
