# Global Agent plugin bridge (work in progress)

This stack starts from `integration/plugin-ask-routing-acceptance` at
`2433cf0130d1c3274c56c39e5765349c2945de01`. The parent confirmed this dependency;
its native Ask acceptance and integrated CI are still pending. This branch does
not modify the frozen candidate, #3986, #3998, or #4002.

The user approved a global conversation independent of a terminal or workspace,
with a plugin-provided chat UI and selectable existing Agent backends. Core owns
Agent execution, history, target authority, native approvals, credentials and
audit. Global is not unrestricted inventory access or a background service.

## Stage 1: dispatch authority

`electron/plugins/agent/delegatedScope.cjs` is a host-only authority. It does not
register plugin APIs, start an Agent or implement an orchestration loop.

- `issue(context, hostSnapshot)` authenticates with the existing source binding.
  Host snapshots contain backend identity/revision, target kind/id/owner/revision,
  synchronous current-owner checks, and a supported capability subset. The public
  result contains only an opaque handle and expiry. Plugin parameters must never
  be used as `hostSnapshot`.
- `begin(handle, context)` returns an internal turn ticket and AbortController.
- `dispatch(ticket, context, resolvedAction, execute)` runs the common host policy
  adapter once, checks current target revisions after any approval wait, invokes
  the real dispatcher, and rejects late results. `resolvedAction` must come from
  canonical host capability/argument resolution, not an unchecked plugin object.
- `assertTurn` guards outgoing events. `finish` and `stop` invalidate the exact
  ticket. Runtime/plugin release, lock/hide invalidation and shutdown abort work.
- Handles expire in five minutes. There are at most eight per runtime owner and
  64 overall, with at most 32 explicit resources per scope. Expiry never silently
  refreshes a selection or revives an old turn.

The focused tests use the actual `PluginAISourceBinding` with synthetic host
registries, two terminal owners representing different workspaces, controlled
time, and deferred approval/native completion. They cover source/runtime/target
substitution, focus changes, revision changes across approval, policy denial,
Stop, release, lock, late completion and bounds. They do not yet prove actual MCP
or AgentRuntime dispatch; those remain integration gates.

Initial execution failed before test discovery because the new worktree has no
dependencies (`ajv/dist/2020` missing). Running with the existing local worktree's
read-only CommonJS dependency path passes all 12 cases. No provider, CLI Agent,
paid credentials or GUI was used.

The adjacent run then passed 49 tests and failed one installed-entrypoint test
because ESM could not resolve `@netcatty/plugin-cli` from the new worktree. Standard
`npm ci --ignore-scripts` and `build:plugin-runtime-deps` repaired the setup. These
failures are setup evidence, not failed-before product regressions.

The core conversation repository stores the existing global `AISession` document
shape in a host-only directory, namespaced by the hash of source/private-owner.
Native session identity and compaction remain private. Commits serialize a cloned
snapshot, revalidate provenance before atomic rename, and retain previous history
when that check fails. Files use mode 0600 and no-follow reads. The repository
does not register a plugin storage API or change the source database schema.

The canonical schema and SDK now declare the proposed session interface and
permissions. Runtime methods and the supported-feature advertisement are not yet
registered. This stage must not be described as an installable working Agent
bridge. Focused scope/history/wire and permission-copy tests pass 20 cases;
contract/SDK/CLI tests pass 91. Focused lint and generated drift checks pass.

## Independent stage-1 correction

The independent review of exact `056164157f34ea779ed6cf51199909082345eca4`
confirmed two helper defects before any runtime acceptance claim: source failure
during the initial owner check rejected late work without aborting the active
native signal; Stop could acquire a replacement turn after awaiting identity.

Both reproduce against that exact helper using the real `PluginAISourceBinding`:
the focused before run is 13 passed / 2 failed. The correction revokes the captured
scope when its own host-authenticated identity fails, and captures the intended
turn before Stop's first await. A foreign runtime cannot use a failed lookup to
revoke another caller's scope. Focused after: 15 passed / 0 failed. The complete
foundation/permission group passes 23 on Node 24.19.0 and Node 22.23.3; focused lint
and diff checks pass. Logs: `/tmp/netcatty-global-agent-review-before.log`,
`/tmp/netcatty-global-agent-review-after.log`,
`/tmp/netcatty-global-agent-review-node22.log`.

The first CI run at 0561641, test `40459522087`, Linux job `122040565759`, failed
after an explicit runner shutdown and operation cancellation, with no assertion
failure in its log and no complete repository test total. Package workflow
`40459521971` and both Windows jobs passed. The parent authorized one job rerun;
it was requested once, producing Linux job `122048349748`, still running at this
checkpoint. Original runner failure remains historical evidence. Neither that
rerun nor the helper fix establishes runtime, native or independent-review
acceptance; the correction still needs reviewer recheck.

### Follow-up: cancellation is not source revocation

The independent recheck confirmed the first two repairs and found a remaining
Stop race: an aborted Stop(A) RPC could enter the generic owner-failure cleanup
after B had started, revoking B's scope. The same failure was reproduced at both
owner-validation await paths using the actual source binding. Exact-18377 source
with the new 18-case scope suite yields 16 passed / 2 failed; evidence is retained
in `/tmp/netcatty-global-agent-stop-rpc-exact183-before.log`.

The minimal follow-up distinguishes this request's abort/deadline from verified
owner or resource failure, rethrows the access failure, and leaves the existing
turn-capture rule intact. Cancellation of Stop(A) cannot revoke B. A separate
regression confirms that a verified source mismatch still aborts native work
even when the RPC is concurrently cancelled. Foreign caller protections remain.
The full foundation/permission group passes 26 tests on Node 22.23.3 and Node
24.19.0; focused lint and diff checks pass. Logs:
`/tmp/netcatty-global-agent-stop-rpc-final.log` and
`/tmp/netcatty-global-agent-stop-rpc-node22.log`. Independent recheck is pending.

The authorized original-head Linux rerun `122048349748` ended cancelled, with an
operation-cancelled log and no assertion failure. No second rerun was requested.
At 18377, test workflow `40462595842`, Linux job `122050816182`, also received an
explicit runner shutdown; `PluginLogSettings.test.tsx` was SIGKILLed immediately
afterward. That interrupted stage reports 34 passed / 1 failed, not a complete
repository total or an assertion failure. Both Windows jobs passed. No blind
rerun of that job was made. Package workflow `40462595846` was still running when
checked. These records are not substituted for exact-head green CI.

## Planned public contract and adapters

### Stage 2A: trusted native dispatch boundary

The independent bounded recheck of foundation `ba4d3fc` passed all 20 reviewer
cases. This resolves its reported helper findings; it does not establish full CI,
runtime, backend or native acceptance.

The additive transport slice gives managed subprocesses a separate per-turn MCP
credential, permanently binds their TCP connection to that turn, filters their
tool list, and routes actual tool execution through the source-bound host policy
adapter. Catty's trusted-app IPC enters the same dispatcher. Branded approval
contexts skip the legacy Agent approval only after that host adapter grants the
action; process-global permission mode is unchanged. Selected environment reads
return the scoped session metadata without querying global tunnel inventory.

Managed Claude is restricted to its existing MCP mode with builtin tools disabled,
strict MCP configuration and no inherited settings sources. The main native entry
rejects unverified backends and Skills mode for reserved delegated conversations.
Each model stream and native SDK request carries a main-owned turn tag; releasing
that lease aborts its HTTP/native work. Old credentials, cancellation requests and
disposers cannot acquire or cancel the next turn.

The focused boundary suite passes 116 cases, including an actual local TCP/main
handler with synthetic workers, plus two new actual-HTTP/renderer-transport lease
tests. These are deterministic transport tests, not real model inference or
authenticated Claude service/CLI acceptance. Public runtime registration, core
conversation integration and the custom chat sample are still separate work in
progress; this transport slice alone is not a usable plugin Agent feature.

At exact `ba4d3fc`, package CI `40464058910` passed; test workflow `40464058908`
is red. Linux job `122055141575` failed a real assertion in
`PluginManagementDialog.interaction.test.tsx:71`: the external view handoff had
not run when asserted. That stage reports 34 passed / 1 failed; earlier runtime
and contract groups passed 720 and 5. Both Windows jobs passed. No blind rerun was
requested. This unresolved assertion must not be classified as runner shutdown.

The wider initial local transport run reports 697 passed / 10 failed / 3 skipped.
All ten failures are Cursor discovery expectations after `npm ci --ignore-scripts`
left SQLite's native binding absent, making the bundled Cursor SDK import fail.
The standard rebuild first failed using unwritable default caches; rebuilding
with task-local npm/node-gyp cache paths succeeded. The failed totals are retained
in `/tmp/netcatty-global-agent-transport-expanded.log`; the after-setup run is
recorded separately. No GUI or provider credentials were used.

After the dependency repair, the expanded transport/native-handler/preload/SDK
suite passes 709 tests, 0 failures, 3 skips. Log:
`/tmp/netcatty-global-agent-transport-expanded-after-setup.log`. Focused lint passes.

The proposed feature is `ai.agent-sessions`, with `ai.agent.use` for conversation
operations and `ai.agent.actions` for actual Agent tool actions. Permission mode
comes from the existing source-bound Allow/Ask/Deny engine. These are additive
names, separate from the existing tools-disabled `ai.invoke` broker.

The API will provide backend listing, explicit target selection, owned chat
listing/opening, sending, bounded event reads, history, Stop and close. Backend
references are opaque host-issued configuration revisions. Conversation references
identify only histories owned by the calling source/private-owner; runtime handles
are separate and cannot substitute builtin chat IDs or native SDK resume IDs.
Messages cannot supply permissionMode, CLI/env/MCP configuration or owner fields.

Core will reuse `AISession`, `AgentRuntime`, both existing turn drivers, event and
compaction handling, SDK resume identity validation, and `stopAgentTurn`. The first
eligible backends are Catty and configured Claude Code in MCP mode. Other backend
entries must return explicit unsupported/unconfigured status until their native
tool and approval boundaries are verified. Codex SDK's current unrestricted native
configuration must not be treated as eligible merely because it has a driver.

The terminal worker already exposes a suitable main-owned resource binding:
`getPluginSessionBinding(sessionId, ownerWebContentsId)` returns worker epoch and
session generation. Use this for dispatch-time targets; do not use menu IDs,
focused tab, display labels, or a renderer-provided session ID as authority.

The MCP dispatcher and Catty direct execution route need the same delegated
session guard. A delegated call must not update process-global permission mode,
or request both an Agent approval and a plugin approval for the same action.
Policy changes, disable/restart/source replacement, lock and host disconnection
must cancel scoped native work and invalidate outgoing event tickets. Existing
Agent trace and plugin audit/log facilities will receive redacted correlation
metadata, not credentials, provider diagnostics or full unreviewed tool payloads.

## Remaining acceptance gates

- Canonical schema/SDK/runtime registration and the installed default host path.
- Host-owned durable history and backend references, including backend switching.
- Actual Catty and Claude MCP dispatch, policy and worker lifecycle regressions.
- Synthetic streaming/cancellation fixtures; these are not real inference or
  actual authenticated Claude service acceptance.
- Installable minimal chat UI with backend and explicit target choice.
- Standard CI, independent review and parent-scheduled native evidence. No GUI
  ownership, merge or release is granted to this executor.
