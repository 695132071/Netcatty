# Unified plugin acceptance candidate

The dedicated branch is `integration/plugin-native-acceptance`. Its Draft PR
records the exact current head and CI runs. Native AI, database, Host/Vault, and
settings/logging checks use this candidate rather than separate feature trees.
The existing feature branches and their published heads remain frozen.

The previous candidate `174c525cd45bdc1152e9feb21839a288706d3bd1` passed
[test CI](https://github.com/binaricat/Netcatty/actions/runs/40381685282),
[four-platform packages](https://github.com/binaricat/Netcatty/actions/runs/40381685946),
and [ET CI](https://github.com/binaricat/Netcatty/actions/runs/40381684810).
No actionable CI regression was found. Its full test suite records 15,375 tests:
15,325 passed, 50 skipped, zero failed or cancelled.

The next candidate is provisional. It includes the published settings focus
correction and the first AI corrections. The AI budget repair has been
independently confirmed, but expired selected-Note handles still need an
explicit refresh/re-selection path. AI native activation remains held until
the owner publishes that follow-up and its verification completes. The real
terminal Solo/Focus selection-ownership correction also awaits an exact
published checkpoint. No uncommitted owner work is imported.

## Included source checkpoints

| Slice | Frozen checkpoint | Integration evidence |
| --- | --- | --- |
| Main | `f0897c3c1711f60350f8d613696d387bcac464ed` | Includes #3991, #3983, #3992, and #3995 |
| Byte streams, source identity, connected AI, examples | #3993 `37df67256e7eedc1050f186bcf401dc376cb5e71` | Ordinary merge; both transport P2 fixes retained |
| Host/Vault actions | #3990 `730fa643ba0589b8919368657dabc83428f577be` | Ordinary merge; metadata/action authority stays separate |
| Settings and logging UI | #3994 `823db94cf34503417e3b7c19c6daab379f60530f` | Ordinary merge; retains dc6 alias repair and adds the natively verified gear-to-settings focus path |
| AI corrections, provisional | #3986 `07eb68c5e7be5ed882f2c0daec75d3fa2792f880` | Ordinary merge; stable source budgets confirmed; model-chat recovery is not complete selected-Note expiry recovery |
| Selected-terminal continuation | Task `01a1796d-29f4-7505-9746-444b929ab013` | Owner is fixing real Solo/Focus selection ownership; exact published correction pending |

#3995 was squash-merged into main as `f0897c3c`. Its PR tip was rechecked at
`921f51756eca564cef3d30152807a4649c2a0d3b`; both contain the same TERM-SSHD test
blob `cdfc067e6ca3b4f6b7b3d6e78834072ed84837b4`. The candidate keeps main's
deterministic first/alias OPEN-order cases instead of the older plugin-branch
test-only repair. No production transfer cancellation change is introduced.

## Resolve the shared integration files

- Root package and lockfile retain both the plugin workspace versions and
  main's pinned `@noble/ciphers` dependency.
- The assistant retains its six-file staging build. The Host/Vault branch's
  older assistant preparation does not replace it.
- `hostService.cjs` retains byte-stream, AI/context, Host/Vault, and logging
  construction and registration. Shutdown cleans up the existing services and
  closes logs in `finally`. Constructor-failure cleanup retains each service.
- The AI host remains mounted in `application/app/AppView.tsx`. The Host action
  host remains inside the Vault/session providers in `App.tsx`. Trusted preload
  methods, source-bound authority, and canonical schema definitions are retained.
- Canonical contract generation produces no drift after merging the shared
  schema. This worktree's `@netcatty/plugin-contract` and `@netcatty/plugin-sdk`
  resolve to its own `packages/` directories, not an older worktree.
- The installed Host test fixture now supports multiple lock listeners, matching
  the production app-lock bridge's `Set` subscription contract. The old fixture
  stored one callback and timed out after both Host and AI services subscribed.
  Production lock behavior is unchanged.

## Local evidence

Checks use Node 24.19.0 and a private task temp root through the existing temp
bridge. HOME, endpoint policy, and sandbox settings are unchanged.

| Check | Local result |
| --- | --- |
| Registered plugin runtime | 654 tests: 653 passed, one native skip, zero failures |
| Contract/SDK/CLI | 90 passed, zero failures |
| Host installed entrypoint, action guards, draft UI/domain, production lock bridge | 82 passed, zero failures after correcting the subscription fixture |
| Plugin settings/market/logging UI | 28 passed, zero failures |
| Registered database examples | Four passed, one opt-in Docker skip |
| Vite lazy-settings HTTP/native-ESM probe | Passed; alias fix and test are byte-identical to `dc6e645f` |
| Main TERM-SSHD file | All 32 cases passed, including both controlled arrival orders |
| Contract/capability generation and drift, Codex schema | Passed |
| Full lint | Zero errors, seven existing warnings |
| Production build | Passed; Vite completed in 31.93 seconds |
| Four sample packages | Validated; two builds of each match byte for byte |

The initial connected group is retained as a failed run: 39 passed, nine failed,
and two cancelled. The mounted AI chooser test failed because this local
`--ignore-scripts` dependency installation lacks the Electron binary. The Host
lock case timed out because of the single-listener test fixture; later subtests
were cancelled. The corrected Host group passes as recorded above.

The combined Vite/main regression run records 33 passed and seven failed. Its
Vite probe and all TERM-SSHD cases passed. The SSH algorithm import and six
ChaCha/Electron cases could not load the same missing Electron binary. The
normal pinned Electron installer was attempted with a writable task-local cache
and failed with `TypeError: fetch failed`. No alternate download route, native
rebuild bypass, Electron shim, or sandbox change was used. These local failures
remain separate from the exact-head CI results recorded in the Draft PR.

## Reproducible packages and exact permissions

All package versions below are `0.1.0`. These hashes are for this candidate's
SDK and source tree. Older #3993 database archives have different hashes and
must not be substituted. The assistant and Host samples contain their READMEs;
the database packages contain only manifest, browser bundle, and three panel
assets. These handoff archives were not installed or activated in the native
GUI. The automated installed-entrypoint tests use temporary synthetic fixtures;
the Rfam candidate was not installed or granted permissions in any runtime.

| Package ID | Files | SHA-256 |
| --- | --- | --- |
| `com.netcatty.assistant` (provisional; native held) | 6 | `c0f733697b8f43a8591f39c02aeea5d8b7b4bd544b642ed87e758e62d98696a5` |
| `com.netcatty.database-minimal` | 5 | `0d8189e98b535c0d73d9043862bb83b67c8cab2281985083c1096835285ed5bb` |
| `com.netcatty.database-rfam-readonly` | 5 | `434a7d506466f5b37f715436ada5707b48f4d6cbd0ef0fe9e71e8974f414b484` |
| `com.netcatty.host-actions` | 3 | `cf04f82dfe25ab5cda6f5f3dad0a8fb06c37bedf9924f556bee2b8402e542ef2` |

The assistant archive above is the intermediate `07eb68c5` sample. It is not
approved for native activation or a claim of clean correction: expired
selected-Note handles are still unrecoverable. The owner's verified explicit
re-selection/refresh follow-up will require another package/hash record.
The database and Host archive hashes are unchanged; Host activation remains
blocked by the separate automatic-review denial.

| Package | Required feature | Required permissions | Optional permissions/resources |
| --- | --- | --- | --- |
| Assistant | `ai.model-invocation`, `context.selected-read` | `commands`, `views` | `ai.invoke`, `context.selected.list`, `context.selected.read` |
| Owned database | `network.byte-streams` | `commands`, `views` | `network.stream`: exactly `tcp://10.77.0.20:3306` |
| Public Rfam | `network.byte-streams` | `commands`, `views` | `network.stream`: exactly `tcp://mysql-rfam-public.ebi.ac.uk:4497` |
| Host actions | `vault.host-actions`, `commands.interactive` | `commands`, `menus` | `vault.metadata`, `vault.write`, `ui.interact` |

The owned database address is packaging-only. A different approved fixture
endpoint requires a new package and hash. No route from the GUI to the coding
container's private MariaDB is assumed. The GUI's missing Docker runtime remains
a fixture prerequisite, not a reason to change loopback/own-interface checks.

Reproduction commands after building the plugin packages:

```sh
node examples/plugins/assistant/build.mjs
node packages/plugin-cli/dist/cli.js pack examples/plugins/assistant/.package --out /tmp/assistant.ncpkg
node examples/plugins/database-minimal/prepare.mjs tcp://10.77.0.20:3306 /tmp/database-owned.ncpkg
node examples/plugins/database-rfam-readonly/prepare.mjs tcp://mysql-rfam-public.ebi.ac.uk:4497 /tmp/database-rfam-readonly.ncpkg
node packages/plugin-cli/dist/cli.js pack examples/plugins/host-actions --out /tmp/host-actions.ncpkg
```

## Native, review, and deployment gates

| Gate | Status and next evidence |
| --- | --- |
| Exact-head test/build CI | Recorded in the dedicated Draft PR; earlier feature-head CI is historical evidence |
| Native settings UI | Parent reports dc6 layout/controls and 823 gear-to-settings focus passed; those source-head results do not certify every flow on the integrated head |
| Native AI sample | Held: source budgets are confirmed repaired, but expired selected-Note references still need the owner's verified explicit refresh/re-selection follow-up. No silent re-share or inference retry is authorized |
| Native owned database | Pending a supported disposable fixture path; owned live regression remains opt-in and was not run here |
| Public Rfam | Prepared only; no service DNS lookup, connection, query, installation, or permission activation. Parent coordinates exact hash/endpoint authorization. Only protocol 4.1/native-password is supported; auth/TLS compatibility is unverified and no fallback is added |
| Native Host/Vault | Parent reports installation/details passed. Activation consent was denied by automatic review. Functional Host flows remain unrun pending specific user approval. Do not retry that activation or change permissions to bypass it |
| Selected-terminal continuation | Owner is fixing the actual Solo/Focus selection path; published correction and integration verification are pending |
| AI independent security review | The same worker reconsidered the earlier restriction once with newer maintainer evidence and completed review without recurrence. Fix verification is in progress; this integration task does not repeat the review |
| Main merge/release/deployment | Not authorized by this task; candidate remains Draft |

## Next-candidate checks while owner follow-ups are pending

The published settings correction passed all 36 local plugin settings UI tests,
the Vite HTTP/native-ESM probe, contract drift check, lint (zero errors, seven
existing warnings), and production build. The ordinary AI merge passed the 17
source-budget broker tests and four existing model-session recovery panel
tests. Two adapter tests passed; the connected transport test could not import
the same missing local Electron binary. No new download route was attempted.

Those passing panel tests do not cover the still-reproduced expired selected-
Note handle case. The budget correction is independently confirmed; selected-
Note recovery and the real Solo/Focus selection path remain owner follow-ups.
No native Host activation retry, automatic re-sharing, or inference retry is
part of this integration work.

Native evidence records the exact candidate commit, package hashes, source and
permission prompts, denial/retry/cancel/revoke behavior, screenshots, and video.
The coding executor's Node/DOM harnesses and Vite probe are not native sandbox
certification. Database protocol and fixed query code remain in the examples.
