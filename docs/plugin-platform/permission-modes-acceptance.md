# Plugin Allow / Ask / Deny handoff

This change is stacked on frozen PR #3997 at
`677aac33b1eec9dbd4a367417a49c964cdea63e7`. Its source checkout and native QA
checkout were not changed. No merge, release, live database connection, native
activation or real user configuration change was performed here.

## Behavior and storage

- Declared supported capabilities default to Allow, with no installation
  checklist or required-permission preflight dialogs.
- Settings uses existing `SettingRow` and Select components. It shows each
  declaration's resource scope and effective Allow / Ask / Deny mode.
- Policies use `plugin_host_preferences`, keyed by host source owner and
  capability. They survive restart and updates within the same source, including
  reintroduced capabilities. New capabilities default to Allow. Existing grants
  still use the original package/declaration principal; they were not widened.
- Explicit source reset clears that source's policies and private plugin data.
  Another source receives independent defaults. Unrelated Vault, host, settings
  and user data are preserved. No plugin-policy migration was added.
- Policy edits clear grants, cancel pending/in-flight work and invalidate
  handles. Settings edits require the exact host-issued source/version/policy
  revision, so stale controls cannot change a replacement source or override a
  newer Deny.
- Ask decisions use the existing in-app Dialog/Button components, reached only
  through trusted main-window preload IPC. A one-use response token binds the
  request; close, cancel, lock, blur/hide, reload, renderer crash and shutdown
  invalidate it. Plugin DOM clicks confer no host gesture authority.
- Host selection, model/context selection and draft editing remain workflows.
  Ask is integrated into their existing host UI where applicable. Allow removes
  permission-only sharing and connection confirmations while retaining exact
  target validation and action tokens. Terminal drafts never send PTY input.
- AI start combines model permission and exact selected-content scopes into one
  Ask decision. Its receipt cannot cross an RPC operation. Broker-bound stream
  reads/stop/close do not ask per chunk. Same-origin network redirects reuse the
  current operation decision; different origins still require declared bounds
  and their own authorization.
- Policy edits, decisions, use/revoke and operation outcomes remain auditable.
  Audit records omit note/terminal bodies, model payloads, credentials and tokens.
  Optional local log persistence remains user-controlled.

See [the security boundary](security-and-permissions.md) for the storage and
update rules. The separate AI cold-start provider-sync fix is not included;
`configuredModel.ts`, `trustedHostRuntime.ts` and `usePluginAIContextHost.ts`
were left untouched for parent integration.

## Review corrections after the initial 643e71b checkpoint

The initial commit and its screenshots remain in history. Registered regressions
reproduce three concrete issues on that exact tree and pass with these repairs:

- Selected-summary Ask now delegates its decision to the existing host chooser.
  The first and only interaction is target selection; Allow uses that same
  necessary chooser, while Deny opens none and releases no summaries.
- The registry creates a fresh host-only operation identity for every RPC.
  Internal model contexts retain it when replacing a cancellation signal, so a
  combined model/content Ask receipt survives that derivation. Receipts also
  bind plugin, runtime, source, principal and policy revision, and cannot cross
  operations. Current declaration, policy and selection checks still run.
- Changing the privileged development-only `runtime.advanced` policy to Ask or
  Deny disables/stops the activation through the existing manager mutation queue
  before the policy IPC completes. A source-owner check inside that queue prevents
  an old source's teardown from disabling a replacement. Browser sandbox policy
  and development admission guards remain unchanged.

Ask now presents the current host-selected model label and Note title/scope.
Exact versions remain bound internally. Labels come from the checked broker chat
and owned selected summaries;
plugins cannot supply operation identities or display fields through RPC params.
Opaque selected handles remain internal, and display metadata is not added to
audit records. The chooser copy reflects Allow / Ask / Deny without claiming a
mandatory second text review. Spanish keys preserve the existing locale parity
contract. The quota and expiry regression now uses independent requests to avoid
its former 20ms timer race.

Updated component previews use a realistic opaque selected handle internally:

| Light Ask | Dark Ask |
| --- | --- |
| ![Model and Note labels in light Ask](evidence/permission-modes/plugin-permission-model-ask-light.png) | ![Model and Note labels in dark Ask](evidence/permission-modes/plugin-permission-model-ask-dark.png) |

These remain synthetic Chromium component previews, not native QA or a recording.
No Library item was created. The original four screenshots below are retained as
initial-checkpoint evidence.

## Latest checks and remaining environment blockers

- Registered runtime recheck: **695 tests, 694 passed, zero failed/cancelled, one
  native skip**. Separate final registered receipt/authority group: **21 passed**.
- Serial mounted renderer/Host/selected-summary/panel/locale group: **35 passed**.
  A preceding concurrent run timed out during build/lint load; its failure log is
  retained. No timeout result is reclassified as a pass.
- Advanced-runtime manager/source lifecycle and AI group: **35 passed**.
  Receipt/declaration group: **32 passed**. Final engine/registry/manager/host
  boundary group: **71 passed**. Final registered AI audit/receipt check: **one
  passed**; an earlier 15-second timeout while the preview was active is retained.
  The serial rerun passed in five seconds. Contract/SDK/CLI: **91 passed**.
- Final production build passed in **45 seconds**. Full lint has zero errors/seven
  existing warnings. Full TypeScript remains **774 diagnostics**, identical to
  frozen 677 after path normalization, with zero added/removed diagnostics.
- The normal official Electron installer succeeded using its documented proxy
  support and a task-local cache. Exact **42.11.12** executes in Node mode; no
  shared libraries are missing. This is not native GUI acceptance.
- Exact-header setup via the installed node-gyp 12.4.0 and the unchanged rebuild
  tool's official URL failed. The proxy returns **403 Forbidden** for
  `https://www.electronjs.org/headers/v42.11.12/node-v42.11.12-headers.tar.gz`.
  That download stopped; no mirror, alternate host, checksum bypass, dependency
  shim, native-rebuild skip, HOME change or sandbox change was used. Normal
  postinstall/native rebuild and desktop packaging remain incomplete.
- A private task-local `TMPDIR` uses Netcatty's existing safe-temp resolution to
  its normal `Netcatty` subdirectory; HOME remains unchanged. This fixes the
  earlier fallback-to-unwritable-home prerequisite without changing app code.
- A **diagnostic full-suite run on the evolving worktree**, after those environment
  repairs, reported **15,059 tests: 14,922 passed, 92 failed, two cancelled, 43
  skipped**. A stuck FIDO child was terminated after its timeout; this is not a
  successful completed exact-head aggregate. Frozen-baseline focused runs
  reproduce its FIDO timeout and **28 failures** across native imports, Cursor
  fixtures and repository postinstall patch checks, plus the earlier six
  Markdown comparison assertions. Other failures remain unclassified. The
  permission locale parity and obsolete forced-review expectations found by that
  run were corrected and pass focused checks. Original failed/incomplete runs
  below are preserved.

The independent AI cold-start production files remain untouched. This branch
updates only policy expectations in `components/PluginAIContextHost.test.tsx`;
parent integration must retain the AI owner's actual-main-allowlist and provider
sync assertions when merging that test file.

## Local evidence

These are local code/test results, not native acceptance:

| Check | Result |
| --- | --- |
| Registered runtime aggregate, concurrency 2 | 693 tests: 691 passed, one failed, one native skip; no cancellations. Sole failure imports the missing Electron binary on real worker reconnect. |
| Engine, policy matrix, trusted prompt and policy IPC group | 79 passed; subsequent shutdown guard test: 9 passed. |
| Mounted in-app permission controls and Host/terminal workflows | 22 passed. Includes Host Allow/Ask/Deny, policy change during save preparation, exact targets and stale replies. |
| Registered AI/context + policy group | 7 passed, including normal Allow, combined Ask, Deny and revocation. |
| Source/version/revision edit guards and registered byte-stream group | 47 passed. |
| Contract/SDK/CLI suite | 91 passed. Four prepared sample archives validate. |
| Lint | Zero errors, seven existing warnings. |
| Production build | Passed; final `pack:dir` build also passed in 76 seconds. |
| Contract/capability/Codex generation | Regenerated/checks clean; no capability-tool diff. |
| Full TypeScript check | Frozen baseline and implementation each have 774 diagnostics; zero added/removed after normalizing worktree paths. |
| Full `npm test` | Incomplete: stopped after three unchanged bridge child processes remained pending. Reported 9,891 tests, 9,359 passed, 40 failed, 478 cancelled, 14 skipped. This is not a passing aggregate. |
| Desktop `pack:dir` | Unpassed: native rebuild attempts `/home/agent/.electron-gyp`, outside this workspace's writable roots. Earlier pinned Electron installation failed with `fetch failed`. No shim, alternate runtime or sandbox change was used. |

Frozen-baseline focused runs reproduce the two large-history SFTP recovery
failures, six Markdown comparison failures, and missing-Electron adapter/serial
failures observed in the broad run. Other broad-run failures remain unclassified;
unchanged code alone does not prove a baseline failure. One earlier runtime
aggregate hit the existing 15-second byte-stream fixture timeout during concurrent
builds; its focused run and the final aggregate above pass that case.

Logs and archives are in `/workspace/permission-evidence/` in this execution
environment. The final task report identifies any remaining blockers and checks.
Exact-head CI and native acceptance remain pending parent coordination.

## Component screenshots

Chromium rendered the actual React components with built-in light/dark tokens
and synthetic host bridge data. These images demonstrate layout and state only;
they do not certify Electron behavior.

| Controls | Ask |
| --- | --- |
| ![Light controls](evidence/permission-modes/plugin-permission-controls-light.png) | ![Light Ask](evidence/permission-modes/plugin-permission-ask-light.png) |
| ![Dark controls](evidence/permission-modes/plugin-permission-controls-dark.png) | ![Dark Ask](evidence/permission-modes/plugin-permission-ask-dark.png) |

## Prepared sample packages

All packages were built locally; none was activated in a native app. No owned or
public database service was contacted. The owned database package is scoped to
the previously specified disposable fixture endpoint `tcp://10.77.0.20:3306`.

| Archive | SHA-256 |
| --- | --- |
| assistant.ncpkg | `c7d784d5c3bd2feb463afd58eae3a9594615395b168174cb8a3d0677584ae395` |
| host-actions.ncpkg | `cf04f82dfe25ab5cda6f5f3dad0a8fb06c37bedf9924f556bee2b8402e542ef2` |
| terminal-selection-draft.ncpkg | `4c9c2388b7f891156192a0b5ab7b23291beba3555e7ec8cf24fbe2dfe1242d5e` |
| database-owned.ncpkg | `f01c6a24382897d4b0bf4130941274abacb9a9a963f9b56ecaceb2c020f36874` |

Reproduction uses the unchanged sample build tools:

```sh
node examples/plugins/assistant/build.mjs
node packages/plugin-cli/dist/cli.js pack examples/plugins/assistant/.package --out /tmp/assistant.ncpkg
node packages/plugin-cli/dist/cli.js pack examples/plugins/host-actions --out /tmp/host-actions.ncpkg
node examples/plugins/terminal-selection-draft/prepare.mjs /tmp/terminal-selection-draft.ncpkg
node examples/plugins/database-minimal/prepare.mjs tcp://10.77.0.20:3306 /tmp/database-owned.ncpkg
```

## Parent-serialized native recheck

1. Use a fresh isolated app profile and the exact next integrated head. Import and
   enable a sample: no installation permission ceremony should appear.
2. In Allow, select hosts in the host chooser, create/edit via the normal draft
   editor, and connect using a current selected reference without a separate
   plugin confirmation. Ordinary SSH authentication and host-key checks remain.
3. Select a Note/context and model, start and read a turn in Allow. Then switch
   AI/content to Ask: one scoped decision covers the turn and exact references,
   with no per-chunk or second content-sharing dialog.
4. Check terminal Allow sharing and the editable inert draft; Ask shows one share
   preview; Deny releases no selection and cannot reopen old handles.
5. Check network Allow/Ask/Deny at the declared endpoint. Preserve all endpoint,
   DNS, redirect, private-network and control-plane rejection checks.
6. Flip policy while a chooser, draft, model read or network operation awaits.
   Old results/tokens must fail. Switch back to Allow and start a fresh operation.
7. Restart/update the same source with an explicit Deny; it must remain Deny.
   Check distinct plugins and sources, stale settings edits and explicit source
   reset. Review bounded audit events and optional local logging for redaction.

No merge, release or native acceptance is authorized by this handoff.
