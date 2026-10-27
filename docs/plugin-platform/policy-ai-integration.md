# Permission-policy and AI acceptance candidate

Use the dedicated `integration/plugin-policy-ai-acceptance` branch. Its Draft PR
records the exact published head and aggregate CI. Frozen #3997 at
`677aac33b1eec9dbd4a367417a49c964cdea63e7` remains the historical native baseline;
neither that branch nor main is changed by this integration.

This is a candidate for parent-coordinated acceptance. It is not a claim of
completed native acceptance, deployment readiness or permission activation.

## Preserved inputs

| Input | Exact checkpoint | Integration |
| --- | --- | --- |
| Frozen integration | `677aac33b1eec9dbd4a367417a49c964cdea63e7` | Starting point; includes stream/source/Host/settings and prior terminal history |
| Permission policy #4000 | `2eee56184793feedd850bd2600dbdf2f3f17e09a` | Ordinary merge `9aa899059`; default Allow and host-owned Allow/Ask/Deny, receipts, audit and advanced-runtime teardown |
| AI #3986 | `d33c0193ccaedc1a10aed9da495f040250121bef` | Ordinary merge `5d2ff1cb8`; cold-start wiring, themed sample and Node 22 warning-drain test correction |
| Terminal production | #3996 `8e7c28fe1bdbcdd76816d33ec926ba8e60eefe64` | Preserve the prior renderer eligibility/publication path; policy-owned interaction changes remain from #4000 |

Diagnostic #3999 and its tests/docs-only `3fdaa357` continuation are not merged.
No terminal runtime fix is required by the fixture-classification finding.
Database protocol and fixed SQL remain solely in the minimal examples.

## Direct integration decisions

The only merge conflict was `components/PluginAIContextHost.test.tsx`. The
combined test keeps policy's absence of a second native content-sharing review
and AI's actual main allowlist, two-provider synchronization, streamed result,
Stop/lock cleanup and empty SDK-error assertion. The Node 22 warning drain is
retained. The obsolete forced-review cancellation branch is superseded by the
current in-app Ask/cancellation tests; no transport assertion is dropped.

No production file needed a manual conflict resolution. Policy production files
remain identical to the policy input; the three AI startup wiring files and
sample assets remain identical to d33c0193. The stream service/router and prior
terminal renderer eligibility/publication files are unchanged from frozen 677.

Integration commit `7d8a354404d68071d0924532ffe74c713ace6cb9` updates two stale
disclosure assertions in `PluginPackageManager.test.tsx` and
`PluginMarketplace.interaction.test.tsx`. They expected the old words
`not a grant`; the new assertions require default Allow, Ask/Deny controls and
retained host validation/resource scope. Existing escaping, advanced-authority,
source and README-failure assertions remain intact. Production copy is unchanged.

## Checks and retained failures

| Local check | Result |
| --- | --- |
| Registered runtime | 695 tests: 694 passed, one native skip, zero failed/cancelled |
| Contract/SDK/CLI | 91 passed |
| Offline examples | Five passed, one explicit Docker opt-in skip |
| Serial mounted AI/permission/selected-summary/Host/provider/panel group | 31 passed |
| Settings and terminal interaction group after disclosure test correction | 36 passed |
| Contract/capability/Codex generation and drift | Passed |
| Full lint | Zero errors, seven existing warnings |
| Production build | Passed; Vite 37.19 seconds |
| Five sample archives | Validated; repeat builds byte-identical |

The initial settings group records 34 passes and two failures on the stale copy
assertions. That run is retained separately from the corrected 36/36 result.

Policy input [test CI 40443396430](https://github.com/binaricat/Netcatty/actions/runs/40443396430)
first received an explicit runner shutdown. The parent requested one retry;
this integration task did not duplicate it. Retry Linux job `121992430185`
passed registered runtime (694/one skip) and examples (five/one skip), then
failed those same two `not a grant` assertions: settings group 33 passed/two
failed. It did not reach the full suite. The candidate includes the isolated
test correction above; do not relabel the input CI as passing. Both input Windows
jobs and [policy package CI](https://github.com/binaricat/Netcatty/actions/runs/40443396402)
passed. Parent reports the independent policy correction reviews scoped clean,
including both P2s and the three UI findings, with 71 focused/synthetic checks.

AI input [test CI](https://github.com/binaricat/Netcatty/actions/runs/40439111241)
and [package CI](https://github.com/binaricat/Netcatty/actions/runs/40439111215)
passed. Parent reports its three isolated changes scoped clean. Its prior 9ca
Node 22 warning-observer failure remains documented in `ai-provider-startup.md`;
the warning drain does not ignore errors or remove the empty-error assertion.
Frozen 677's earlier unexplained MCP assertion remains separate history.

This executor used locked dependencies with install scripts disabled, then the
standard repository dependency patches. The official pinned Electron binary
installed through its documented proxy support and executes in Node mode.
No native-header download, alternate mirror, native shim, HOME change or
sandbox change was used. Normal native postinstall/rebuild, local full-suite
success and local desktop packaging are not claimed. Exact candidate CI is the
aggregate full-suite and platform-packaging verification surface.

## Exact packages and provenance

The machine-readable [package record](policy-ai-packages.json) contains complete
IDs, versions, required features, permission/resource declarations, archive and
content hashes, and frozen-baseline comparisons. All five versions are 0.1.0.

| Sample | SHA-256 | Comparison with frozen 677 |
| --- | --- | --- |
| Assistant | `7943d4c3800914fe0acd3d0f3a3d7f7c1910c212a5dc58a044871a6a82485274` | Matches the AI owner's new themed archive; only README.md, panel.css and panel.js differ from 677 |
| Owned database | `f01c6a24382897d4b0bf4130941274abacb9a9a963f9b56ecaceb2c020f36874` | Byte-identical |
| Rfam | `aaca586669db454e91d61487e576ed524d1b7190eed182bc2cd0035e59caa0d3` | Byte-identical |
| Host actions | `cf04f82dfe25ab5cda6f5f3dad0a8fb06c37bedf9924f556bee2b8402e542ef2` | Byte-identical |
| Terminal draft | `4c9c2388b7f891156192a0b5ab7b23291beba3555e7ec8cf24fbe2dfe1242d5e` | Byte-identical |

No sample permission/resource declaration changed. The host's new policy changes
effective authorization behavior; identical package bytes do not certify that
new host behavior. The old Assistant c7d784d5 archive remains historical evidence,
not the themed archive. No handoff archive was activated by this coding executor.
The owner-identical Assistant README retains earlier permission-review wording;
use this candidate's Allow/Ask/Deny procedure below for acceptance. That packaged
copy is a documentation limitation, not a requirement for repeated dialogs.

## Native preparation and remaining gates

Use the exact candidate head from its Draft PR in a separate disposable native
checkout/profile. Keep normal platform sandbox/helper settings. Build and hash:

```sh
npm ci
npm run build
node examples/plugins/assistant/build.mjs
node packages/plugin-cli/dist/cli.js pack examples/plugins/assistant/.package --out /tmp/assistant.ncpkg
node examples/plugins/database-minimal/prepare.mjs tcp://10.77.0.20:3306 /tmp/database-owned.ncpkg
node examples/plugins/database-rfam-readonly/prepare.mjs tcp://mysql-rfam-public.ebi.ac.uk:4497 /tmp/database-rfam-readonly.ncpkg
node packages/plugin-cli/dist/cli.js pack examples/plugins/host-actions --out /tmp/host-actions.ncpkg
node examples/plugins/terminal-selection-draft/prepare.mjs /tmp/terminal-selection-draft.ncpkg
```

Validate each archive with the plugin CLI and compare against the machine record.
The owned DB address is packaging-only. A different approved fixture endpoint
requires a new archive and hash. Preparation does not dial either endpoint.

- Verify default Allow for declared supported capabilities without a mandatory
  first-install permission checklist or repeated permission-only dialogs. Verify
  per-plugin Ask/Deny, one scoped Ask receipt, readable host-selected labels,
  lifecycle invalidation and redacted audit. Preserve necessary target selection
  and inert draft editing, exact resources, source isolation and sandboxing.
- Verify the assistant's cold startup through the normal host without opening
  the AI sidebar. Native inference on frozen 677 returned unavailable; the
  independent startup regression did not establish that native error's cause.
  Use only the deterministic synthetic provider and Note recipe, with current
  policy semantics. Native success is not claimed before that recheck.
- Frozen 677 Host core passed per parent; old consent recordings describe the
  prior policy. They do not certify the new permission implementation.
- Terminal's source-level finding is fixture-sensitive-input fail-closed:
  `fixture-A> ` is untrusted; `fixture@owned-A:~$ ` is confirmed shell. Corrected
  fixture solo reached exact Preview/Share/inert draft with zero input on
  unmodified 677; split/Focus rechecks were ongoing at handoff. Do not import
  diagnostic instrumentation or treat those old-policy results as new-policy
  acceptance. Preserve zero PTY dispatch from draft review.
- Native Rfam's single baseline run failed with sanitized -32014 socket error
  before connect resolved. Auth/SELECT were not reached; transport causality and
  auth/TLS compatibility remain unverified. No probe/fallback or restriction
  change is authorized by this coding task. Owned DB fixture prerequisites and
  parent coordination remain separate.
- Record exact head, hashes, ordered prompt/operation outcomes, screenshots and
  video for the new candidate. Hosting/distribution/deployment remain pending;
  no main merge, Ready transition or release is part of this handoff.
