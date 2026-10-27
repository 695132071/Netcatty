# Plugin model transport cold start

Commit `092438803bed96753bfe68cb78da9ca1137dee25` removes an independent startup
dependency on the internal AI sidebar. It does not establish the cause or outcome
of the original native failure; that still requires an authorized native retest.

## Reproduced boundary

At native candidate `677aac33b1eec9dbd4a367417a49c964cdea63e7`, the plugin model
selector reads the saved host provider, while main's provider registry starts
empty. The existing sidebar synchronizes that registry when visible or sending.
The plugin startup path did not. A nondefault configured loopback port can
therefore fail main's provider allowlist before HTTP transport starts.

The revised `components/PluginAIContextHost.test.tsx` installs the browser sample,
mounts the trusted host component, uses the real application preload, and routes
model requests through `registerProviderHandlers` and its actual allowlist. It
does not mount the internal sidebar or manually alter the allowlist. Credential
injection uses synthetic fixture markers; the HTTP edge and deterministic local
fixture use the existing transport. No paid service, real key, Note, or host is
used. This remains DOM/in-process evidence, not native sandbox acceptance.

Failed-before evidence is `/tmp/netcatty-ai-cold-provider-before-final.log`:

```text
ok: false
allowlistRejected: true
statusCode: undefined
```

The corrected regression passes and preserves both the selected fixture provider
and a second host-configured synthetic provider. It checks that provider markers
and configuration do not enter plugin-facing model/context envelopes. Expected
SDK error output is suppressed during this diagnostic so request payloads and
headers are not logged.

## Correction

Before publishing a selected model handle, the trusted renderer synchronizes the
current host-owned provider settings through the existing `aiSyncProviders`
application API. It checks that the selected model revision matches the snapshot
being synchronized. The runtime rechecks activity, cancellation, model revision,
and pending-selection ownership after the await. Pending selections count toward
the model-handle cap; release and shutdown invalidate late results.

Plugin requests supply no URL, credential, or provider configuration. The existing
main sender validation, endpoint allowlist, source binding, and model invocation
budgets are unchanged. No new schema feature, plugin permission, or consent
dialog is added. The assistant package is unchanged and retains SHA-256
`c7d784d5c3bd2feb463afd58eae3a9594615395b168174cb8a3d0677584ae395`.

Production integration touches `configuredModel.ts`, `trustedHostRuntime.ts`, and
`usePluginAIContextHost.ts`. The hook's import and `prepareModel` option may
overlap host-selection work; preserve both when integrating the separate policy
task. Permission-engine, consent-dialog, and sample-UI changes are outside this
correction.

## Native and policy status

The native open/close sidebar comparison was incomplete. Execution auto-review
denied the Application-scope `context.selected.list` grant; that action did not
execute. No post-sidebar inference was performed, the prompt expired, and the
sample was disabled while the worker cleaned up. This is not native confirmation
of the startup cause. The original `677aac33` app remains frozen for comparison;
this fix does not authorize retrying the denied execution action.

In the earlier permission engine, **Application** grants are memory-only for the
application lifetime; **Always** grants are persisted. An explicitly authorized
Application grant can fit bounded temporary QA. A one-use prompt on every stream
read is not an unavoidable target UX. The separate policy task implements the
new direction: default Allow for declared supported capabilities, per-plugin
Allow/Ask/Deny settings, audit, and in-app Ask dialogs. That product change is
separate from execution-tool authorization and must not be used to evade a tool
denial. This transport correction does not redesign that policy.

Native outcome, independent verification, and the sample's light-theme appearance
follow-up remain separate acceptance work. No GUI launch, sandbox bypass, paid
model invocation, main merge, or release was performed for this correction.
