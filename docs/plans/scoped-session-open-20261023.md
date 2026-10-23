# Scoped host opening and shell readiness

## Goal and baseline

Initial base: upstream main 695fd2768, fetched 2026-10-23. Final integration base: e9818a619 (latest upstream at the pre-submission synchronization). Future PRs must fetch upstream first and use its latest main as the base. The old experimental branch and patch are retained outside the maintained repository. Existing changes in the maintained repository remain untouched.

Preserve upstream reuse-first behavior and original session ownership. Add explicit workspace placement for newly created sessions, report failed scope registration, and wait for a live shell prompt before sending a command into a tracked PTY. Raw network/serial terminals and independent SSH exec channels keep their existing paths.

## Sequence

1. Plan and run regressions against current upstream.
2. Port only missing functionality, retaining upstream diagnostics and reuse semantics.
3. Run focused tests, full lint/test/build, and isolated Electron validation.
4. Review diff, commit, push to fork, create PR against upstream main.

## Evidence and state

- Stage: implementation and validation after upstream synchronization.
- New readiness, placement, and scope-reporting regressions failed on upstream before implementation (netcatty-scoped-sessions-upstream-red.log).
- Initial adapted focused run: only the old workspace options expectation needed updating; upstream handles newTab in its existing reuse decision instead of forwarding it to the renderer creation callback.
- Dependency lock differs from the old branch; final checks must use the current lock.
- Previous branch test/build results are historical only, not evidence for this PR.

## Boundaries

current resolves the active main-window workspace at execution time. Reused sessions retain their current placement; request newTab true for a separate pane. This change does not add moving, reconnecting, or replacing existing sessions.

Live prompt matching is a conservative heuristic. Unknown prompts and busy/waiting programs fail without delivery when no recognized prompt is visible. It does not prove exclusive ownership of every manually launched process. Waiting is bounded, cancellation sends no interrupt before delivery, and no delayed command is sent after cancellation.

Trial runtime and output stay under D:/Temp/CodeTemp. No automatic fixture creation on application startup; only explicitly invoked tests may create local sessions. No production profile or remote authentication state changes.

## Validation update

- npm ci --ignore-scripts installed the current lock, followed by repository patch-package/xterm patches and Electron 42.11.12 installation.
- Targeted regression suite: 212 tests passed, no failures (netcatty-upstream-targeted.log).
- Full npm run lint passed; npm run build passed.
- Full TypeScript baseline has 769 diagnostics. Before a small explicit-false narrowing fix, the changed tree had the same diagnostics; the only text difference was the extended host-open success type. Final comparison remains pending.
- Isolated Electron renderer: current workspace placement, scopeBound true, connected sessions, installed-launcher CLI session/exec (NC_CLI_READY), missing-workspace rejection without a leaked session, and foreign-scope rejection passed.
- The trial launcher initially inherited the production CLI discovery path. Corrected the isolated launcher to use a dedicated profile discovery path and clear inherited chat identity. These are uncommitted test harness changes outside the repository.
- The first expanded trial expected a two-pane workspace to survive closing one pane; upstream intentionally collapses it to a standalone tab. Adjust the trial rather than changing product behavior.
- Full suite is running with concurrency 4 and a 180-second test limit to bound hangs. Windows permissions, POSIX shell and SFTP timeout failures must be reported, not counted as passing. The strict-mode source-contract failure also occurs on the clean upstream baseline.

## Final live trial and full-suite outcome

- Isolated Electron 42.11.12 + Vite trial passed all nine checks: workspace/scope binding; installed CLI session/exec; invalid target without leaks; foreign scope rejection; close then fresh standalone open; busy PowerShell waits for its prompt (about 3 seconds); Read-Host rejects an injected command without consuming or interrupting input; UI close revokes ownership; CLI standalone open/close. All fixture sessions were then closed.
- Full suite attempt: 14,907 tests, 14,489 passed, 313 failed, 2 cancelled, 103 skipped. It is not green. The pluginRuntime aggregate retained a live process after its tests and was terminated after several minutes so the runner could finish. A clean upstream isolated reproduction is being checked with an outer deadline.
- Failures include POSIX shell/history on Windows, permissions/symlinks, existing source-text contracts, SFTP timeouts, and timing-sensitive cleanup assertions. Only the focused suite and explicitly compared baseline failures may be described as verified; do not claim every full-suite failure is pre-existing.
- Packaging/install replacement is outside this PR. Existing production binaries, credentials, and maintained-repository working changes remain untouched.

## Submission state

Implementation and validation are complete; upstream review/CI remains pending. The branch is fix/scoped-session-open-upstream-20261023.

- Rebased onto e9818a619, preserving the newly merged single-channel SSH/SFTP changes and vault-note query correction. Final serial regressions including those upstream additions: 272 passed, zero failures.
- Final full production build passed after the rebase.
- Final TypeScript comparison on e9818a619: clean baseline 769 diagnostics, changed tree 768, zero added diagnostics after normalizing checkout paths and line numbers. The explicit-false host-open check removes one existing diagnostic. Full typecheck remains non-green.
- Clean upstream pluginRuntime reproduction hit the 45-second outer deadline after its utility-runtime cases; no unrelated plugin-runtime changes were added here.
- Broader PTY comparison: both trees 73 passed, 48 failed, 14 skipped; identical failure names.
- Parallel regression rerun exposed the existing 20 ms SFTP cleanup timing assertion under scheduling load. Isolated baseline passed and final serial 272-test run passed; it is not represented as a product regression or silently deleted.
- Verified private trial cleanup: zero sessions and restorePreviousSession=false. Closed the trial Electron/Vite processes. Production CLI environment lookup succeeded after isolation cleanup.
- Existing maintained-repository dirty files are unchanged. No installed app or remote authentication/provider configuration was modified by this development task.
