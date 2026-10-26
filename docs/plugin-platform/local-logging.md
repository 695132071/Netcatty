# Local plugin logging

Local file persistence defaults to off. The existing permission panel keeps its
bounded security history independently. Changing or clearing local log files does
not clear that history, grant permissions, or change a plugin's source.

## Saved records

`PluginLogService` extends the existing `PluginLogger`. It owns one shared sink at
`<userData>/plugins/logs/host-v1`, outside plugin storage. Files contain JSON Lines.
They stay on the device. No cloud upload or sync path includes these files or the
local preference at `<userData>/plugins/local-logging.json`.

Host audit records contain these facts:

- Host-assigned plugin ID, installed version, archive SHA-256, runtime ID and kind.
- Source ID, source kind, and namespace from an injected host provenance resolver.
  Missing provenance is `null`. Manifest claims never imply an official source.
- Registered host RPC operation, authorization outcome, result, numeric error code,
  elapsed milliseconds, and available input/output `data` field byte counts.
- Target identifiers from host authorization descriptors, replaced with a keyed
  SHA-256 digest. The random key stays in memory, so target correlation lasts only
  for the current app process.
- Cumulative dropped-record and write-error counts at enqueue time.

Runtime start, running, stop, failure, protocol rejection, and permission revocation
produce separate host facts. The registry records known RPC attempts even when
validation or authorization fails. Authorization has separate `allowed`, `denied`,
`not-required`, and `not-reached` states. A handler error after approval preserves
`allowed` and records the failed result. Unknown values remain explicit.

The byte counts measure UTF-8 bytes in a string `data` field, or byte length for a
binary `data` field. They are not total wire traffic or decoded base64 size.
Missing measurements are `null`. Streaming traffic outside these calls does not
become a complete per-byte trace. Host facts describe what the host observed;
plugin-returned success cannot prove an external side effect occurred.

Host audit records never copy request bodies, response bodies, error messages,
credentials, API keys, passwords, prompts, Notes, SQL, query results, or terminal
content. Error codes come from the host RPC error set. No audit field accepts
plugin-supplied source identity.

## Optional plugin text

Verbose diagnostics require a separate confirmation and turn off after app
restart. Console messages, utility stdout/stderr, and `logger.write` text use
`recordType: plugin-diagnostic` and `trust: plugin-authored-unverified`. The host
adds identity outside the nested `diagnostic` object. Plugin fields named
`pluginId`, `sourceId`, or `recordType` cannot replace reserved metadata.

Text and structured fields have traversal, length, depth and total-record limits.
Control characters are removed and known sensitive field names are replaced.
These bounds do **not** make arbitrary plugin text safe. A plugin can put a secret
under an unexpected key or inside a sentence. Review files before sharing them.
No plugin text is persisted when verbose diagnostics are off.

## Limits and lifecycle

The shared sink retains at most three files of 1 MiB each, for at most seven days.
Retention runs on startup, writes and hourly while the app runs, including after
saving is disabled. The app cannot delete expired files while it is closed.
The asynchronous queue accepts at most 256 KiB and records drops when full.
Plugin text can occupy only a quarter of that queue, leaving capacity for host
facts. Diagnostics also reuse the existing per-runtime log token bucket (240
records per minute, with a 240-record initial burst), including console output. Each
record is limited to 16 KiB. Oversized records are dropped. Write failures increase
both drop and error counts and never fail the plugin operation.

Turning saving off stops ingress, discards queued records that have not started,
and waits for any current write. Runtime cleanup closes its diagnostic logger.
App shutdown drains accepted writes through the existing manager shutdown path.
Clearing pauses ingress, discards queued records, waits for a current write and
removes only the sink's known files. Cancellation leaves them intact. Export takes
a bounded snapshot on the write queue and uses the native Save dialog.

Files use mode 0600 and the directory uses 0700 on systems that support them.
The host filesystem broker rejects writes to the audit directory and preferences,
including canonical paths reached through symlinks. Plugin views cannot invoke
log management IPC. No plugin API exposes audit mutation. These local files are
not a tamper-evident ledger against the OS account or the development-only utility
runtime, which already has full Node and filesystem authority.

## Integration boundaries

`PluginLogSettings` is a standalone compact component, mounted by a single import
and element in `SettingsPluginsTab`. It adds no marketplace tab and changes no
Installed, Official, Third-party, or source-database implementation. When merging
with the marketplace branch, preserve this element in the host settings surface.

`createPluginHostService({ resolvePluginProvenance })` accepts a synchronous,
host-owned resolver with this input:

```js
({ pluginId, pluginVersion, archiveSha256, securityPrincipal }) => ({
	sourceId,
	sourceKind,
	namespace,
})
```

Return canonical source IDs, not URLs, display names, or plugin claims. Source
keys accept only 1-128 ASCII letters, digits, periods, underscores, colons and
hyphens. Values outside that grammar remain `null`. The source
branch owns this resolver and must inject its authoritative source catalog. A
runtime snapshots the resolver's result at activation. Until it is wired, source
fields remain `null`; identity is never guessed from a manifest or package name.

## Native QA with synthetic data

Use a fresh isolated profile and an ordinary browser plugin with synthetic data.
Do not open real logs or credentials. Capture screenshots of the settings card,
verbose disclosure, and native Clear confirmation. Record a short flow:

1. Open Plugins settings. Confirm both options are off and no host-v1 files exist.
2. Enable local saving. Invoke a synthetic plugin host operation and deny another.
3. Open the folder and export to a synthetic destination. Inspect parsed JSONL for
   host identity, outcomes, target digests, and absence of synthetic secret bodies.
4. Open verbose disclosure and cancel. Confirm no plugin text is saved. Confirm
   the disclosure, write synthetic text, and verify the unverified record type.
5. Disable/revoke the plugin. Confirm its later text cannot append. Restart the
   app and verify that local saving remains selected but verbose text is off.
6. Cancel Clear, then confirm it. Confirm the files are removed and the permission
   panel's separate security history remains. Turn local saving off.

The execution environment for this change could not launch Electron: its SUID
sandbox helper is not root-owned with mode 4755. Electron aborted before opening
any profile. No sandbox-disable retry or system-permission change was attempted.
`npm run pack:dir` also failed while rebuilding the serialport native dependency:
node-gyp tried to create `/home/agent/.electron-gyp` and received ENOENT. No
system-directory change or packaging retry was attempted.

Native screenshots and recording therefore remain pending in the parent desktop
QA queue. Component interaction tests are separate evidence and do not replace
that acceptance.
