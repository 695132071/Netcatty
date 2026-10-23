# MCP file operations on single-channel SSH servers

Servers identified as single-channel (for example, `TERM-SSHD`) must not
receive an SFTP subsystem request on the interactive terminal transport.
Session-backed MCP file operations instead open a dedicated file connection
using the original terminal dial profile, with transport reuse disabled.

The profile stays in a non-enumerable session closure. It is not returned by
host discovery or written to the vault. The dedicated connection uses the
same hostname, username, proxy/jump route, credentials and host-key policy.
Normal authentication prompts may be shown again for the new connection.
The host's Auto/SFTP/SCP preference is preserved.

Closing the source terminal or cancelling an open aborts pending login and
authentication prompts. Late connections are closed before registration.
The normal MCP operation cleanup closes the dedicated file connection after
the operation. Sessions created before this support was loaded retain the
protective error and must be reconnected.

This changes connection selection, not file contents or transfer algorithms.
For integrity-sensitive transfers, compare the source, remote and downloaded
file sizes and SHA-256 digests. A successful tool response alone is not an
integrity check.
