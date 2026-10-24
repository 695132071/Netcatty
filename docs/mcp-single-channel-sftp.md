# MCP file operations on single-channel SSH servers

Servers identified as single-channel (for example, `TERM-SSHD`) must not
receive an SFTP subsystem request on the interactive terminal transport.
Session-backed MCP file operations instead open a dedicated file connection
using the original terminal dial profile, with transport reuse disabled.

The profile stays in a non-enumerable session closure. It is not returned by
host discovery or written to the vault. The dedicated connection uses the
same hostname, username, proxy/jump route, credentials and host-key policy.
Normal authentication prompts may be shown again for the new connection.
Host-key verification pins the keys actually accepted for the live terminal
and its jump hosts, including a first-time or updated key accepted during
login. A different key on the dedicated connection fails closed immediately;
reconnect the terminal to verify it before retrying the file operation.
The host's Auto/SFTP/SCP preference is preserved.

Closing the source terminal or cancelling an open aborts pending login and
authentication prompts. Late connections are closed before registration.
The normal MCP operation cleanup closes the dedicated file connection after
the operation. Sessions created before this support was loaded retain the
protective error and must be reconnected.

The GUI's explicit-session and vault reconnect paths validate the endpoint
before selecting this dial. Endpoint identity matching must not treat the
single-channel restriction as a route mismatch: that restriction prohibits
borrowing a channel, not opening an independent connection from a matching
profile. Only sessions that own a dedicated dial capability use this identity
lookup; host/profile, authentication, jump/proxy route and forwarding checks
remain enforced. Vault reconnects without a live pane id can select this
capability too. Actual transport reuse rules remain unchanged.

## TERM-SSHD file semantics

The tested TERM-SSHD gateway acknowledges pipelined writes but produces a
same-sized corrupt file. Repositioning a READ on a consumed handle returns
EOF; opening another handle before closing the first returns General failure.
These observations are consistent with a sequential, cursor-based backend
that does not implement SFTP positioned I/O correctly.

For exactly the TERM-SSHD software identification, range transfers use one
in-flight request and restart checkpoints at zero. Downloads close the body
handle, reopen the file at zero, and compare every byte sequentially with the
local output. Uploads hash the local file and sequentially reread the complete
remote stage before promotion. A size-only acknowledgement is insufficient.
Other SSH software retains its existing concurrency and chunk sizes.
Transfers sharing one TERM-SSHD channel, including pooled aliases, serialize
their complete body and verification phases across uploads and downloads.
Restored transfers serialize remote source fingerprints and checkpoint-prefix
checks too, acquiring the relevant source or target channel before each check.
Cancelling a queued transfer does not close the shared channel. Active transfer
cleanup waits for CLOSE; a failed or timed-out CLOSE discards all aliases of
the uncertain channel before another transfer can use it.

This compatibility policy trades throughput and resume efficiency for correct
contents. Allow sufficient MCP command time for both the transfer and the
second full read. It is not a general promise that every TERM-SSHD version has
the same defect. An explicit SFTP host preference may be necessary when a
gateway advertises but cannot execute SCP. The saved preference is never
silently changed by this patch.

For live acceptance, compare source, remote and downloaded sizes and SHA-256
digests, and confirm the interactive terminal remains usable. A successful
tool response alone is not a substitute for this three-way check.
