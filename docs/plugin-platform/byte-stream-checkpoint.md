# Byte stream integration checkpoint

The branch starts at #3978 `91b8927c56314e68c06e2c008e84559ddfb96d78`.
It integrates source APIs from #3981 `ab8764a31752fd2d226c9d029c4d65498ba7b063`
and AI service/adapters from #3986 `264f1d983cd1ed83fe4873974a614fff2f47f989`.
No source database or sync implementation is changed by the transport delta.

## Registered transport

Canonical definitions are in `packages/plugin-contract/schema/plugin-contract.schema.json`.
`network.byte-streams` negotiates the capability. The separate `network.stream`
permission requires explicit `tcp://host:port` or `tls://host:port` resources.
Wildcard declarations and grants cannot authorize raw streams. HTTP grants and
payload limits are unchanged.

The SDK exposes `context.network.connect({ endpoint }, cancellationToken?)`.
The returned connection has `endpoint`, `readable`, `writable`, `close()`, and
`dispose()`. The control methods are `network.stream.connect`,
`network.stream.attach`, and `network.stream.close`. Descriptors, request
shapes, feature names, limits, generated SDK types, and host validators share
the canonical schema. Unknown request properties are rejected.

The registered service authenticates the host runtime before source lookup.
Runtime startup captures the existing opaque source owner. Every asynchronous
commit revalidates the runtime, active and retained source, and opaque owner
through the source task's APIs. Caller-supplied owner/source parameters are
rejected. Audit commits also verify the source binding.

Connection and stream IDs are host-issued and bound to that runtime and owner.
The SDK prepares its incoming waiter before attach starts the host producer.
Both directions reuse the existing binary stream router and credit windows.
Input credit returns after the socket write callback. Output backpressure
bounds the producer. The router has one optional producer `onClose` hook;
peer cancellation releases the socket even while it is idle.

The host validates all DNS answers and pins a literal IP. Production rejects
loopback, link-local, unspecified, multicast, mapped local addresses, selected
IPv6 tunnel forms, and the machine's own interface addresses. The production
host constructor never forwards the core's explicit local-test override.
There is no proxy discovery, reconnect, UDP, listen, generic IPC, shell, Node
plugin runtime, or filesystem escape.

Limits are four connections per runtime, 64 globally, 64 KiB chunks and socket
buffer thresholds, and 8 MiB combined bytes per connection, plus the existing
runtime byte quota. Connect, idle, and lifetime deadlines are 10, 30, and 120
seconds. Close tombstones are capped at 256 small identity records. Revocation,
runtime stop, disable, shutdown, and stream cancellation release resources.

TLS requires trust and original-hostname validation with TLS 1.2 or later.
Plugins cannot set custom CAs, SNI, or validation exceptions. STARTTLS is not
implemented. Generic audit records contain endpoint, runtime, handle, and byte
counts. The host does not inspect SQL or record payloads or credentials.

## Additive AI interface for the parallel owner

The same canonical schema defines the relayed `AI_CONTEXT_ROUTES` types.
The SDK/runtime expose `context.ai.openChat/startTurn/readTurn/stopTurn/closeChat`
and `context.selectedContext.list/read`. Host registration advertises
`ai.model-invocation` and `context.selected-read`, and wires runtime cleanup,
plugin disable, revocation through the service, and shutdown.

The trusted host adapter constructor option is `pluginAIHostAdapter`. It has
the service owner's `assertActive`, `selectModel`, `listSelected`, `reviewText`,
and optional lifecycle callbacks. These callbacks are never exposed to plugin
views. The default adapter rejects model invocation, returns no selected
resources, and refuses text review. The AI owner still owns real renderer
wiring and model/context UX. A registered synthetic adapter test is not proof
of that remaining production wiring.

## Database example

`examples/plugins/database-minimal` is an ordinary browser plugin. Its developer
preparation tool creates an `.ncpkg` for one exact disposable private IPv4
endpoint. The output contains a browser bundle, a normal manifest, and view
assets. The preparation tool and its Node dependencies are not in the plugin.

Only the example contains the database protocol: common protocol 4.1,
`mysql_native_password`, and
`SELECT value FROM plugin_demo.example_result LIMIT 1`.
The view accepts session-only fixture credentials and clears its password
field before dispatch. It does not save view state, settings, logs, or secrets.
The host never exposes SSH or AI credentials. JavaScript does not promise
memory zeroization. The account's server-side SELECT grant enforces read-only
access. The fixed query is not a SQL security classifier.

The example has no query editor, schema browser, pool, arbitrary SQL, or host
connection-management subsystem. See the example README for native setup.

## Evidence and limits

- Both source-reviewed races have executable real-loopback regressions here.
  Delayed final-byte consumption previously lost EOF after the socket closed.
  Double-microtask cancellation previously created an untracked late socket.
  Each regression failed before its respective fix and passed afterward.
- The broker tests use real TCP/TLS sockets, including trusted fixture CA,
  untrusted certificate and wrong-hostname denial. Connect and idle deadline
  cases use mock clocks around real sockets or delayed DNS.
- The installed entrypoint test builds and installs a normal package, executes
  its actual browser entry module through SDK/RPC/binary streams, and exercises
  grant denial, exact resources, unknown-field rejection, close, revoke, and
  disable. It also exercises registered AI/context SDK routes with a synthetic
  trusted adapter. Its runtime harness is Node and is explicitly not a browser
  sandbox or OS sandbox test.
- The disposable MariaDB test checks a synthetic SELECT result and server-side
  INSERT denial. It creates an internal network, publishes no host ports, and
  removes the container and network. Database transport is plain TCP inside
  that disposable network, not database TLS.

Normal native BrowserWindow, full app/package checks, exact-head independent
review, and screenshot/video acceptance remain separate required evidence.
Do not disable the Chromium sandbox to obtain that evidence.
