# Plugin AI and selected context: implementation checkpoint

Base: ThemePack #3978, `91b8927c56314e68c06e2c008e84559ddfb96d78`.
Branch: `feat/plugin-ai-context`.
Status: isolated host internals and fixture-tested transport reuse. Public contract,
production adapters, installable example, independent review, and native acceptance
are pending. This source is not ready to merge or release.

## Proposed public boundaries

The proposed optional features are `ai.model-invocation` and
`context.selected-read`. The parent has not confirmed these names. No canonical
schema, generated contract, SDK, runtime peer, hostService, or installer changes
are included in this checkpoint.

The model API uses a host-selected configured model. Plugins receive a chat
handle, a display label, an expiry, turn handles, text chunks, and usage totals.
Plugins do not supply provider IDs, URLs, credentials, tools, or Agent policies.
The internal operations are `open`, `start`, `read`, `stop`, and `close`.
`read` pulls one chunk with one pending read per turn. The parent can map this
iterator onto the existing stream router after the canonical contract is agreed.

Context summary enumeration returns only references explicitly shared with the
current runtime and source owner. Content reads require an opaque handle and an
expected version. Summary enumeration never calls the content reader. Supported
selected scopes are workspace, tab, session, host, and Note. There is no inventory
or arbitrary entity-ID lookup.

## File ownership

| Owner | Files or responsibility |
| --- | --- |
| This task | `electron/plugins/ai/`, `electron/plugins/context/`, `infrastructure/ai/plugin/`, `examples/plugins/assistant/`, this document |
| This task | Opt-in `requireBridge` and `maxStreamBytes` request context in `infrastructure/ai/sdk/providers.ts` |
| Parent coordination | Canonical schema, generated files, SDK, runtime forwarding, hostService registration, trusted renderer adapters |
| Market task | Source identity, private data-owner namespace, installer database, marketplace UI |
| Transport task | Generic TCP and TLS streams |
| Logging task | Optional local plugin logs |

The existing `feat/plugin-terminal-sharing` commit
`3cdc97782ef3262969eee9d540e03ebe6fdee210` is preserved. Its
`terminal-sharing-wip.md` describes incomplete selection publication and review.
This branch does not claim that workflow is complete.

## Implemented authority

`ModelInvocationBroker` requires host-provided `resolveDataOwner` and
`selectModel` adapters. It keeps chats and turns in memory. It stores no chat
history and makes no database changes. Data owners are opaque host identities;
no private storage is keyed by `pluginId`.

Each handle is bound to a data owner, a runtime ID, and a plugin version.
Every read rechecks runtime authority, the current model, handle lifetime, and
selected context versions. Revocation aborts pending turns. Late provider results
are discarded. Another source with the same plugin ID cannot read, cancel, or
close the original source's handles.

`SelectedContextAuthority.share` is a trusted host operation. A plugin must never
call it directly. Its descriptor accepts only a scope, a title, a version, a text
reader, and a current-selection guard. Unknown Host fields are rejected. Content
has a 16 KiB cap, excludes NUL, and rejects PEM private keys. The production host
reader must project safe fields explicitly and exclude passwords, private keys,
TOTP values, identity credentials, startup commands, and environment variables.
Free-form Notes can contain secrets that field projection cannot detect. The
trusted sharing UI must preview the selected text before sharing it.

`createPluginModelAdapter` calls the existing `createModelFromConfig` and
`streamText`, through the existing host provider transport. Credential injection
stays in Netcatty. Direct-fetch fallback is disabled for this adapter. Incoming
SSE payloads have an aggregate 128 KiB cap before SDK buffering. SDK retries are
disabled. Only text and allowlisted token totals reach the broker. Provider
errors, raw chunks, reasoning, headers, and tool payloads do not cross it.

No AgentRuntime, internal prompt, full MCP catalog, tool executor, Node runtime,
raw host IPC, or global renderer store is exposed to plugins. A model tool request
ends the turn without executing an action. Notes edits and terminal input are
outside this checkpoint. No command is written to a terminal or followed by Enter.

The default broker limits are defined in `MODEL_INVOCATION_LIMITS` and
`SELECTED_CONTEXT_LIMITS`. They include concurrent handles, turn and chat lifetime,
input and output bytes, output token caps, event count, requests per minute, and
reserved tokens per minute. Input token reservation uses UTF-8 bytes plus 1,024
bytes for framing and the output token cap. This is a conservative estimate, not
a tokenizer or a monetary billing cap. Provider usage is reported separately.
Reservations are not refunded after cancellation. Rate limits survive runtime
restart within the broker's lifetime. Host shutdown clears this in-memory state.

## Required host adapters

Production integration is blocked on these parent-owned contracts:

1. `resolveDataOwner(context)` must return the current private source owner from
   host provenance. A plugin-supplied source value or plugin ID is insufficient.
2. `selectModel(context)` must return a trusted invocation adapter for the model
   explicitly selected in the main UI. No provider configuration crosses RPC.
3. The renderer adapter must validate the current window, selected resource,
   lifecycle generation, version, and owner before and after asynchronous reads.
   Reconnect, tab or session close, navigation, lock, disable, and permission
   revocation must invalidate handles and abort turns.
4. Summary enumeration, content reads, and model invocation need separate
   permissions. Only the canonical schema can define their wire format.
   Model invocation permission does not grant context or action permissions.
5. Host review must show selected content before it becomes model input.
   A command-palette or menu ID is never resource authority.
6. The shared hostService adapter must register teardown and permission-revoke
   hooks, and discard results if its renderer owner changes.

## QA evidence

The domain suites and transport suite use synthetic data only. The transport
suite starts a deterministic OpenAI-compatible HTTP server on loopback and
checks this path:

`ModelInvocationBroker` -> `createPluginModelAdapter` -> `createModelFromConfig`
-> `createBridgeFetchForSDK` -> existing `_streamRequestForTests` main transport
-> local fixture -> text and usage.

This is not real model inference or paid API testing. It uses no paid keys, real
Notes, hosts, or chat history. The credential value is a fixed synthetic marker;
the existing model factory replaces it with its IPC placeholder. The test does
not exercise native credential storage or production credential injection.

The tests cover source, runtime, and version denial; separate summaries and
content reads; context invalidation; provider cancellation and late results;
deadlines; request, token, event, input, output, and stream-byte limits; and
allowlisted response serialization. Raw provider diagnostics remain inside the
host.

Commands:

```sh
node --test electron/plugins/modelInvocation.test.cjs
node --test --import tsx infrastructure/ai/plugin/modelInvocationAdapter.test.ts
npx eslint infrastructure/ai/plugin/*.ts infrastructure/ai/sdk/providers.ts examples/plugins/assistant/panel.js
```

The final focused domain run passes 16 tests. The transport suite passes three
tests, including the actual assistant panel's Send, streaming, usage, and Stop
handlers in JSDOM. The test bridge uses structured clones to model the existing
view command boundary. It does not replace installed-plugin or native coverage.
The wider plugin runtime run passes 556 tests with one skipped. The existing
provider regression suites pass 34 tests.

The full repository typecheck fails in existing code, including provider tool-call
inference and plugin CLI test manifest literals. No new adapter type errors were
reported. The focused lint passes.

Native Electron launch aborts because the bundled `chrome-sandbox` is not owned
by root with mode 4755. No sandbox bypass was attempted. Native screenshots,
video, installed-plugin UI tests, packaged builds, and independent review are
pending on the parent's working desktop after shared integration. The panel
source alone is not evidence of native acceptance.
