# Host and Vault actions

Feature: `vault.host-actions`. The SDK registers three methods under
`context.vault`. Netcatty owns the picker, field-diff review, and connection
confirmation. Plugin business logic stays in the offline browser sandbox.

Base: source integration #3981 at
`4213d8e6726c44e7a479418ece3adf16ea494782`.
The published stream/AI branch point `c4433d496` is preserved through an ordinary
merge. Its owner was still completing integration checks when it was published.

## Reusable boundaries

| Concern | Existing contract | Reuse |
| --- | --- | --- |
| Host picker | `components/SelectHostPanelContent.tsx` | Controlled `selectedHostIds` and `onSelectionChange`; group toggles resolve to explicit host IDs. |
| Typed drafts | `ImporterHostDraft` in `packages/plugin-contract/schema/plugin-contract.schema.json` | Create allowlist: label, hostname, username, port, group, tags. Edit allowlist: label, group, tags. |
| Validation and preview | `normalizePluginImporterRecords`, `buildVaultHostFromDraft` | Validate the raw address, normalize the importer draft, validate the normalized result, and show the normalized field diff. |
| Vault writes | `useVaultState.commitVaultImportTransaction` | Existing shared Vault lock, expected host snapshot, encryption, stale-write checks, and journaled persistence. Optional authorization guard runs after encryption. |
| Connection | `AppSideEffects.handleConnectToHost` | Existing saved-settings, group defaults, authentication, logging, and session creation flow. |
| Script disclosure | `applyGroupDefaults`, `hasHostConnectAutomation`, `snippetAppliesToOutputTrigger` | Boolean disclosure covers inherited startup commands, global/group/host connect scripts, unresolved bindings, host output triggers, and applicable global output scripts. Script contents remain host-owned. |
| Lifecycle | `PluginHostInteractionService`, `PluginPermissionEngine`, runtime route `assertActive` | Existing window ownership, focus, lock, signed replies, cancellation, and revocation patterns. |
| Source identity | `PluginDatabase` | `getActivePlugin`, `getRetainedPluginSource`, `privateOwner`, and `publicPluginId`; no caller-supplied owner or bare-ID fallback. |

## Public methods

| Method | Parameters | Result |
| --- | --- | --- |
| `vault.selectHosts` | `{ title: string }` | `{ cancelled: true }`, or `{ cancelled: false, hosts, groups }`. |
| `vault.requestHostDraft` | Create: `{ draft: { label?, hostname, username?, port?, group?, tags? } }`. Edit: `{ target, expectedRevision, draft: { label?, group?, tags? } }`. | Cancelled, or `{ cancelled: false, status: "saved" }`. |
| `vault.requestConnect` | `{ target, expectedRevision }` | Cancelled, or `{ cancelled: false, status: "requested" }`; no session identifier or content. |

Selected metadata contains label, hostname, username, optional port, protocol,
group path, and tags. Each host result contains `{ target, metadata }`. Host IDs
remain behind the typed target reference; its revision is the expected revision.
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

Bounds reuse `HostInteractionLimits`: one pending request per runtime,
eight total, ten per minute, a 60-second confirmation deadline, and a 64-KiB
request ceiling. Selection adds a maximum of 50 current hosts. Titles use the
existing 128-character single-line limit. Draft field lengths use
`ImporterHostDraft`. Unknown properties are rejected by the shared schema.

Creates produce saved SSH drafts. An empty group clears the saved group. Edits
preserve connection endpoints and credentials. Changing a group can change
inherited authentication, proxies, and scripts; the draft review states this.

The API excludes Vault and renderer stores, the internal MCP catalog, plaintext
credentials, private keys, TOTP configuration, startup scripts, and arbitrary
execution. Host selection and action UI live in Netcatty. Plugin business logic
stays in the sandboxed plugin.

## Typed target and action authority

`VaultHostRef` is a signed `host.selection` reference with `scope: "metadata"`,
an opaque handle, a revision, and an expiry. It identifies an exact chosen host.
It does not authorize editing, connecting, terminal input, or terminal output.

References bind source, private owner, plugin version, runtime, window owner and
generation, exact host ID, revision, and expiry. They live for five minutes at
most, with at most 500 retained references. Another selection replaces that
runtime's previous references. Lock, revoke, window replacement, and runtime stop
invalidate the affected references. Removal or replacement of a host makes its
renderer revision stale, even if its visible fields are identical.

`PluginAISourceBinding` supplies the existing host-only source identity primitive.
It revalidates after asynchronous authentication. AI selected-context handles are
text-disclosure handles and cannot target these actions.

The permission engine gates selection with `vault.metadata`, drafts with
`vault.write`, and connection requests with `ui.interact`. Every save or connection
also requires a separate host-owned confirmation and a signed one-use action
claim. A stored permission grant cannot bypass this review.

After review, the renderer prepares the existing transaction or connection
request. It claims action authority after the final asynchronous preparation,
immediately before persistence or dispatch. This claim is the action's commit
point. Completion only acknowledges the committed action. Automation changes
during connection review require fresh confirmation.

## Sample and validation

`examples/plugins/host-actions` adds four commands through the existing command
palette slot. Its create draft uses `synthetic.invalid`; it requests no network,
filesystem, terminal-content, or credential permissions.

`components/PluginHostActions.entrypoint.test.tsx` installs that sample and drives
its actual entrypoint, SDK, RPC registry, source binding, signed replies,
production React dialog, and renderer execution adapter. It covers explicit
selection, cancel, stale revisions, locked Vault, host removal and replacement,
revoke, source replacement, runtime removal, and connection confirmation. Registry
checks reject text handles, tampered references, caller owners, and mismatched
expected revisions. Only synthetic resources are used. The Node transport fixture
does not certify the operating-system sandbox.

Native screenshots and video run on the parent's existing cloud GUI. This branch
does not change Electron sandbox or helper permissions. Tests use synthetic hosts
and credentials. No real host connection or credential access is authorized.
