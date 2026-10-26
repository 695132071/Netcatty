# Sandbox capability coverage

This matrix tracks expansion from Draft #3951 at
`e5bd294cddbf58dfe04c646b6291933d980498fd`. Each accepted item requires a
canonical schema, generated SDK, broker, permission policy, quota and audit,
host adapter, lifecycle cleanup, synthetic boundary tests, review, and exact-SHA
CI. Enumeration in a manifest is not a working API. Status `planned` does not
mean complete. Existing APIs remain available.

## Coverage matrix

| Subsystem | Working API at baseline | Enumeration or missing adapter | Accepted bounded entry | Data and action risk | Authorization resource | Revocation, audit, quota | Verification and disposition |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Authorization management | Engine `listGrants`, `revokeAll`, database audit | Manager shows declarations only | Host-only grant list, bounded audit summary, disable and revoke | Paths, session IDs, grant metadata are sensitive | Exact plugin ID, trusted app sender | Serialized manager mutation, disable before revoke, runtime teardown, retained audit | Batch 1 limited acceptance complete on ff3734d: independent review fixes, host/manager/UI tests, exact test/packaging CI, parent native own-views Application grant/revoke/disable/runtime-stop check. Visible view was manually closed beforehand. No plugin RPC for managing grants |
| Network and credential leases | `network.request`, `credentials.createLease`, single-use host redemption | SDK request omits lease and authorization fields | Canonical request types matching broker | Network mutation and credentials | Exact origin plus secret reference and operation | Existing timeout, redirects, byte quotas, runtime checks, lease TTL | Batch 1 contract/SDK consistency complete: canonical types, synthetic fixture/lease tests, feature discovery and exact CI. No live network or credential acceptance claimed. No plaintext secret API |
| Commands, menus, toolbar, status bar, views | `commands.execute`, settings, context keys, view state and messages, UI contributions | No editor or SFTP menu slots | Existing contribution system | Plugin text and arguments may be sensitive | Namespaced contributions and permissions | Existing lifecycle, rate and message limits | Existing tests. New context menu slots planned with bounded context DTOs |
| Terminal providers | Decorations, links, completion, snapshots through provider requests | Session change delivery follows prior provider request and non-once grant | Preserve providers. Standalone selected-session watch planned | Hostnames, session state, endpoint identity | Host-selected session, runtime identity | Session-close and revoke cleanup, bounded event rate | Existing provider tests. Ordinary views cannot independently subscribe today |
| Current context and host picker | Host context keys are boolean state | `vault.metadata` enumeration is not generic SDK | Selected host/session DTO from an explicit whitelist | Labels and endpoint metadata are sensitive | Host-owned user-action context, selected host/session | TTL, runtime and session invalidation, redacted audit | Planned. Never reuse agent `sanitizeHostForAgent` as plugin DTO |
| Terminal selection and input draft | Provider-supplied snapshots, completion suggestions | No explicit selection-share or draft API | User shares selection, plugin proposes a visible editable draft | Terminal plaintext, accidental execution | Host action token plus exact live session/endpoint | Single-use token, size cap, no plaintext audit, active identity before commit | Planned. Reject Enter/control characters for draft insertion. No full history or direct shell |
| Native interactions and clipboard | Native permission dialogs; new browser SDK host choice/input and explicit copy/share workflow | Progress/toast remain unimplemented | Host-owned prompts, two-phase clipboard snapshot/share, exact copy preview | Clipboard and input may contain secrets; UI discloses granted network capability; prompt spam | `ui.interact`, clipboard direction, host-signed window/runtime/version/phase/TTL action | Admission before permission prompt, byte/rate/concurrency limits, lock/blur/close/revoke cleanup, active guard, content-free audit | [Host interaction slice](./host-interactions.md) implemented and synthetic-tested. d4ca123 exact test/packaging CI and parent independent delta review passed; parent native rerun pending after the permission-modal focus fix. Progress/toast still planned. No background reads or trusted plugin `userGesture` boolean |
| Local filesystem | Read file, stat, overwrite existing regular file | Directory listing lacks same-handle native adapter | Keep current boundary, evaluate file picker handles | Arbitrary local file content and writes | Canonical exact path or selected file handle | Inode checks, no symlink alias, bounded bytes, active runtime | Existing filesystem tests. Directory enumeration and new arbitrary-path creation deferred until portable safe native adapter exists |
| SFTP and remote files | No generic plugin API | `sftp.read` and `sftp.write` enumerated only | Host-selected session/path/mode/TTL handles, read and explicit save/upload | Remote secrets and destructive overwrite | Live endpoint identity, exact path, read/write split | Cancel streams, byte quota, overwrite confirmation, close/revoke cleanup | Batch 2 planned. Never forward arbitrary MCP catalog or session ID alone |
| Editor and Notes | No plugin document API | No versioned snapshot or edit preview | Explicit snapshot and versioned proposed edit | Document secrets, lost updates, executable files | Selected document plus revision and action token | Version conflict check, preview, bounded bytes, revocation | Planned evaluation after shared action context. No unattended edits |
| Snippets and scripts | Provider import drafts only | No generic read/run API | Explicit selection and create draft | Script contents may contain secrets. Running executes commands | Selected item, read versus draft write | Preview, byte cap, no automatic execution | Planned evaluation. Script `run` and onConnect modification deferred |
| Connections and authentication | Connection/authentication providers, opaque credentials, streams | Generic host open/connect absent | Existing providers remain | Connect can execute saved onConnect scripts | Provider operation plus live endpoint and credential lease | Existing provider lifecycle, streams and quotas | Existing tests. Generic connect is a write/execution capability, deferred pending explicit execution design |
| Sync and storage | Local namespaced KV, encrypted-object sync providers, opt-in setting sidecars | No general KV cloud sync | Existing opt-in provider protocol | Conflicts, deletes, credential access | Provider/account/object, settings scope | Existing limits and lifecycle, non-cascade metadata | Existing sync tests. General KV sync deferred until conflict/delete/quota/migration policy is defined |
| Vault and keychain | Credential references and import preview/commit | Metadata/write enums do not grant a generic Vault SDK | Only user-selected whitelist DTOs and drafts | Notes, environmentVariables, startupCommand, keys and credentials | Selected object plus field/direction | Explicit preview, identity checks, redacted audit | Full Vault export and secret reads deferred indefinitely. No agent field-exclusion DTO reuse |
| System manager and Docker | No plugin system API | Agent/MCP adapters are separate authority | Typed read-only summaries excluding args/env/inspect | Process command lines and Docker inspect can expose secrets | Selected live session and summary kind | Bounded result, endpoint identity, cancellation | Planned evaluation. Arbitrary process/inspect forwarding deferred |
| Port forwarding | No generic plugin API | Existing agent start is write-sensitive | Selected rule status and open host form | Rule endpoints and local exposure | Selected rule plus host action | Bounded DTO, session close and revoke | Planned evaluation. Direct start deferred until binding/listener approval design |
| Themes, settings, appearance, i18n | Terminal theme/background Providers, isolated view CSS, scoped settings and environment updates | No host global theme contribution. Personal customCSS is not plugin authority | Accepted ThemePack stage: static palette registry, selector, local preview, revision-safe apply/cancel/reset, terminal linkage | Unreadable palettes and misleading security UI. Nineteen UiThemeTokens fields are not independent: accent derives primary/ring/foregrounds | User explicitly selects a theme; static contribution enablement separate from code permissions | Immutable version/hash, bounded JSON, contrast/security-surface gates, preview owner/revision and safe fallback | Planned independent implementation after current controlled workflow/navigation. No arbitrary DOM/CSS, remote assets, layout replacement or security UI customization |
| Transfer center | Host transfer queue exists, no plugin entry | No ownership-bound task API | Observe and cancel only plugin-created tasks | Paths and host endpoints reveal user data. Cancel may leave partial files | Own transfer handle plus source/destination authority | Shared backpressure, cancel/close cleanup, honest partial status | Planned with batch 2. Do not broadcast or cancel other tasks |
| AI, MCP, automation | Host agent catalog and harness exist separately | No generic plugin AI or tool forwarding | Selection-to-proposal workflow through the same controlled primitives | Content disclosure, account authority and model cost | Explicit content sharing plus service origin/budget | No inherited history, tools, account, or hidden cron | Controlled workflow planned. Generic host AI and visible schedules deferred to distinct product decision |
| Known hosts, app lock and global security | Host security management UI | No plugin management API | Future allowlisted security-page navigation | Host-key trust, unlock, keys and security policy affect all sessions | Host navigation action only | No mutation or sensitive DTO | Security policy mutation, private-key reads, auto-trust and unlocking deferred indefinitely |
| Plugin blob/cache | Local KV exists | No exclusive blob cache | Evaluate bounded plugin-owned cache when a real workflow needs it | Disk growth and lifecycle ambiguity | Plugin namespace, no arbitrary path | Size quota, eviction and uninstall policy required | Deferred until a concrete larger-than-KV workflow establishes value and retention policy |
| Vault and terminal navigation | `tab` mounts a sandbox page through TopTabs/QuickSwitcher; aside/panel are overlays | No Vault subpage registry or terminal side-panel plugin tool. `settings` is a detail entry, not a new settings category | Accepted independent slice: host-owned namespaced Vault pages in an Extensions group, mounted in the Vault content area through existing ViewHost; then terminal pane/split pages for the selected session | Navigation cannot disclose session contents or replace built-in/security navigation | Declared page contribution plus host selection. Content reads have independent permissions | Host order/when/focus, cancellation of late open, view cleanup on hide/update/disable/uninstall, safe invalid-link fallback | [Vault page slice](./vault-pages.md) implemented and synthetic-tested: actual Vault content slot, private Scratchpad, catalog withdrawal, host occlusion, reserved-open cancellation, owner/crash/lock cleanup. Exact CI/independent/native acceptance pending. Terminal pane/split pages remain the next separate stage. No arbitrary router/DOM API |
| Distribution and runtimes | Browser-only public catalog, immutable packages, advanced developer gate | Signing/trust and release remain separate phase | Retain existing boundary | Package execution and publisher trust | Pinned catalog selection, hash, engine/features | Existing install transaction, quarantine and cleanup | No merge/release. Do not extend to arbitrary Node, IPC, shell, or global capabilities |

## Delivery order and stopping rule

1. Batch 1: actual authorization management plus network contract consistency.
   Keep the existing manager layout. Add one independent permission panel.
2. Batch 1b: the host text interaction slice, then selected context and terminal
   sharing/drafts. A plugin-supplied gesture is never authority.
3. A separate navigation slice mounts actual Vault extension pages, then terminal
   sidebar panes, reusing the isolated ViewHost and keeping content permissions separate.
4. Deliver the declarative ThemePack stage with security appearance and contrast gates.
5. Batch 2: SFTP selected-file handles and explicit transfer destinations.
6. Reassess editor, Notes, snippets, menus, system summaries, and port forwarding
   using the tested host-action and resource primitives.

Stop only when every row is implemented and tested, reasonably deferred with a
specific boundary and rationale, or awaiting a concrete user decision. A
planned row remains unfinished. Native screenshots and recordings belong to
the parent thread. Real credentials, hosts, or transfers require approval for a
specific target there. Synthetic checks do not establish native acceptance.

## Batch 1 evidence and next workflow

The independent permission panel adds only an import and a detail mount to
`components/settings/tabs/PluginPackageManager.tsx`. It uses the manager hook's
new `refresh()` after host revocation. Marketplace layout remains owned by the
parallel UI layer. Five locale files contain the panel strings.

The next usable workflow is a browser plugin that asks a host quick-pick/input
question, then explicitly copies its result or asks the user to share clipboard
text. The host displays the plugin source and action before reading or writing.
A canonical `HostInteractionRequest` and bounded result carry only text/choice
IDs. The host owns request IDs, requester webContents, runtime/version, TTL,
cancellation, and the consent result. The renderer cannot reply for another
window. Plugin `userGesture` values are ignored. Runtime/revoke shutdown aborts
all outstanding prompts and ignores late replies. A shared prompt primitive
then supports selected host/session context, selection share, and input drafts.

Before proceeding to the sensitive context/terminal and SFTP entries, the
native path must prove consent, cancellation, quota, and identity binding with
synthetic data. UI screenshots and real-resource approval remain parent-owned.

Baseline code references: `electron/plugins/hostService.cjs`,
`secureCapabilities.cjs`, `permissionEngine.cjs`, `terminalProviderService.cjs`,
`filesystemBroker.cjs`, `extensionProviderService.cjs`,
`packages/plugin-sdk/src/index.ts`, and
`packages/plugin-contract/schema/plugin-contract.schema.json`. Host business
implementations under `electron/capabilities/catalog/` are reference material,
not plugin authority. `infrastructure/ai/vaultAgentBridgeClient.ts` is not a
plugin DTO sanitizer.

## Navigation slice checkpoint

The Vault stage adds `views.vault-pages`, the `vault-page` location, and the
existing `views` permission. It grants no Vault/session data. The ordinary
browser Scratchpad example uses only its own bounded view-state API and
explicit user input. It is not a Notes API or automatic sync feature.

The independent integration base includes #3956 UI polish and #3960 d4ca fixes;
frozen evidence heads and prior PR bases are unchanged. Related UI changes in
this stage are limited to VaultView/VaultViewLayout, new independent plugin
components/hooks, and localized strings. PluginMarketplace/PluginPackageManager
layouts are not rewritten. Native acceptance belongs to the parent with a new
fixture-specific own-views approval. Sidebar, ThemePack, selected context and
SFTP remain unfinished; this checkpoint is not overall completion.
