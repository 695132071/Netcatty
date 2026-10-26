# Unified plugin acceptance candidate

The dedicated branch is `integration/plugin-native-acceptance`. Its Draft PR
records the exact current head and CI runs. Native AI, database, Host/Vault, and
settings/logging checks use this candidate rather than separate feature trees.
The existing feature branches and their published heads remain frozen.

## Included source checkpoints

| Slice | Frozen checkpoint | Integration evidence |
| --- | --- | --- |
| Main | `f0897c3c1711f60350f8d613696d387bcac464ed` | Includes #3991, #3983, #3992, and #3995 |
| Byte streams, source identity, connected AI, examples | #3993 `37df67256e7eedc1050f186bcf401dc376cb5e71` | Ordinary merge; both transport P2 fixes retained |
| Host/Vault actions | #3990 `730fa643ba0589b8919368657dabc83428f577be` | Ordinary merge; metadata/action authority stays separate |
| Settings and logging UI | #3994 `dc6e645fab7cbd25e99b9cab7e87ab931926020e` | Ordinary merge; native Vite permission-helper alias fix and regression retained |
| Selected-terminal continuation | Task `01a1796d-29f4-7505-9746-444b929ab013` | Pending a separately published checkpoint; no uncommitted work imported |

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
| `com.netcatty.assistant` | 6 | `8ef162d13d0a16878fb817462759c9221352d0565dcefebeb102ea3575a918e8` |
| `com.netcatty.database-minimal` | 5 | `0d8189e98b535c0d73d9043862bb83b67c8cab2281985083c1096835285ed5bb` |
| `com.netcatty.database-rfam-readonly` | 5 | `434a7d506466f5b37f715436ada5707b48f4d6cbd0ef0fe9e71e8974f414b484` |
| `com.netcatty.host-actions` | 3 | `cf04f82dfe25ab5cda6f5f3dad0a8fb06c37bedf9924f556bee2b8402e542ef2` |

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
| Native settings UI | Parent's current run is on `dc6e645f`; its screenshots do not certify this integrated head |
| Native AI sample | Pending on this candidate; use the deterministic provider and synthetic Note in the existing recipe, with no paid model call |
| Native owned database | Pending a supported disposable fixture path; owned live regression remains opt-in and was not run here |
| Public Rfam | Prepared only; no service DNS lookup, connection, query, installation, or permission activation. Parent coordinates exact hash/endpoint authorization. Only protocol 4.1/native-password is supported; auth/TLS compatibility is unverified and no fallback is added |
| Native Host/Vault | Pending on this candidate; synthetic hosts only. Review transport/script warnings and cancel any connection that is not separately authorized |
| Selected-terminal continuation | Pending the separate task's published checkpoint and later integration checks |
| AI independent security review | Previously denied; not retried through another route |
| Main merge/release/deployment | Not authorized by this task; candidate remains Draft |

Native evidence records the exact candidate commit, package hashes, source and
permission prompts, denial/retry/cancel/revoke behavior, screenshots, and video.
The coding executor's Node/DOM harnesses and Vite probe are not native sandbox
certification. Database protocol and fixed query code remain in the examples.
