# Byte stream implementation checkpoint

This branch starts at plugin stack #3978, commit
`91b8927c56314e68c06e2c008e84559ddfb96d78`. It contains an unregistered,
host-only transport core and a limited example protocol. It does not yet expose
a capability to installed plugins. Shared contract changes await parent
coordination with the market/source-identity task.

## Implemented scope

`electron/plugins/byteStreamBroker.cjs` opens outgoing TCP or validated TLS.
The broker requires a host runtime context. Handles bind to both plugin ID and
runtime ID. No identity is accepted from plugin request parameters.

Endpoints have one canonical form: `tcp://host:port` or `tls://host:port`.
The proposed permission is `network.stream`, separate from existing HTTP
`network` grants. Authorization precedes DNS and socket creation. The broker
checks every DNS answer, pins one literal IP, and performs no second lookup,
redirect, proxy discovery, or reconnect.

Production defaults reject loopback, link-local, unspecified, multicast,
IPv4-mapped local addresses, and selected IPv6 tunnel address forms. A host
callback can reject additional application control endpoints. An explicit
host-only fixture option admits an exact local endpoint for transport tests.
No plugin request can supply that option. The real database test uses a private
address on its disposable internal Docker network and needs no such override.

Limits are four connections per runtime, 64 total connections, 64 KiB chunks
and socket buffer thresholds, and 8 MiB combined bytes per connection.
Existing runtime byte quotas also apply. There is one pending read and one
pending write per connection. Writes wait for the socket callback. Reads leave
the socket paused and consume bounded chunks.

Connection, idle, and lifetime limits are 10, 30, and 120 seconds respectively.
The connection timer includes DNS after permission approval. Revocation,
runtime release, shutdown, cancellation, EOF, and transport failure release the
socket and reservation. Late DNS results cannot create a socket.

TLS requires certificate trust, the original requested hostname, and TLS 1.2
or later. Plugins cannot supply a CA, disable validation, or change SNI. Tests
inject a fixture CA through a host test adapter. STARTTLS is not implemented.

Audit hooks record generic open/close operations, endpoint, runtime, handle,
and byte counts. They do not record payloads, credentials, or SQL semantics.
This branch does not modify the logging task's audit sink or retention UI.

## Shared interface requested from the parent

The following changes are proposed, not implemented:

- Add canonical `network.byte-streams` feature and `network.stream` permission.
  Reject wildcard stream resources in both required and optional declarations,
  grant decisions, and coverage checks. Existing HTTP grants confer no stream
  authority.
- Add `network.connect({ endpoint })` to the SDK. Return a host-owned
  connection with readable/writable byte streams and an idempotent close
  method. Define every control descriptor in the canonical schema.
- Use host-issued connection and stream IDs. After connect, the SDK prepares
  its readable waiter and writable stream, then an attach request starts the
  host producer. This avoids sending stream-open before the browser has a
  consumer. Do not send bulk bytes through JSON RPC or raise HTTP limits.
- Reuse `PluginStreamRouter` credit and transfer frames. The producer needs a
  close/cancel observation hook so cancellation closes the socket even when
  no read or write is pending. Release input credit only after the socket
  write completes. Await output credit before reading another socket chunk.
- Keep host-provided runtime identity and `securityPrincipal` unchanged.
  Confirm the market task's source-principal propagation and revoke semantics
  before wiring authorization. Do not add a parallel provenance format.
- Register runtime cleanup and host shutdown with the existing lifecycle.
  Production wiring must never pass the fixture local-endpoint override.

Requested shared-file scope: canonical schema and generated files,
`packages/plugin-contract/src/index.ts`, SDK `index.ts`, `runtimePeer.mjs`,
`permissionResources.cjs`, `hostService.cjs`, and the stream producer close
hook in `streamRouter.cjs` and its runtime adapters. This branch has not edited
those files. It does not require changes to installer DB, source namespaces,
secret storage, credential resolution, or AI brokers.

## Minimal database example

`examples/plugins/database-minimal/protocol.mjs` is browser-bundleable code.
It supports only the common protocol 4.1 handshake, `mysql_native_password`,
and one fixed query with one bounded text result. It rejects unsupported
authentication, sequence errors, oversized packets, extra result shapes, and
peer errors without displaying the peer's error text.

The query is `SELECT value FROM plugin_demo.example_result LIMIT 1`.
It has no query editor, SQL classifier, schema browser, pool, importer, file
access, host credential access, or persistent credential store. Passwords
belong to the disposable example session. Authentication uses browser Web
Crypto and the password challenge. Clearing local variables does not promise
JavaScript memory zeroization.

The fixed query is a demo constraint. Server-side grants enforce the fixture
account's read-only access. The host neither interprets SQL nor trusts an
example's claim that a query is read-only.

The normal manifest, SDK adapter, example view, and `.ncpkg` are still pending
the agreed public interface. This protocol module is not a finished installed
plugin. Native screenshots/video and exact-head independent review are also
pending parent assignment.

Driver investigation: mysql2 supports custom streams, but its documented
module dependencies include Node `net`, `events`, `stream`, and `tls`.
The limited browser implementation avoids introducing those host powers or
a general SQL subsystem. Sources: [mysql2 TypeScript documentation](https://sidorares.github.io/node-mysql2/docs/documentation/typescript-examples),
[MariaDB handshake protocol](https://mariadb.com/docs/server/reference/clientserver-protocol/1-connecting/connection),
and [MariaDB protocol differences](https://mariadb.com/docs/server/reference/clientserver-protocol/mariadb-protocol-differences-with-mysql).

## Evidence

On Node 24.19.0 in the delegated Linux workspace:

- `node --test electron/plugins/byteStreamBroker.test.cjs`: 14 passed.
  TCP and TLS sockets are real. Tests cover trust and hostname rejection,
  handle isolation, authorization denial, local/control targets, mixed DNS,
  revocation, runtime release, EOF, bounded receive buffering, byte quota,
  concurrent operation limits, and late DNS after cancellation. Connect and
  idle timeout tests use mock clocks around real sockets or pending DNS.
- `NETCATTY_BYTE_STREAM_DATABASE_TEST=1 node --test electron/plugins/byteStreamDatabase.live.test.cjs`:
  one passed. It creates a disposable internal network and MariaDB container,
  a random session password, a SELECT-only account, and one synthetic row.
  The real broker returns that row. The same account's INSERT is rejected by
  the server. The test publishes no host ports and removes its container and
  network. The image is pinned in the test by digest.
- Changed-source ESLint and `npm run check:plugin-contract` passed before
  this checkpoint. Generated schema files remain unchanged.
- `esbuild examples/plugins/database-minimal/protocol.mjs --bundle --platform=browser --format=esm`
  produced a 6.2 KiB browser bundle without Node polyfills or dependencies.

The database test uses plain TCP inside its disposable network. It is not a
database TLS test, a native BrowserWindow test, device testing, a full app
build, or a packaged app acceptance result. Full production checks remain
pending integration.
