# Shared AI privacy and reversible masking

AI privacy masking is **off by default**. Enable it in Settings > AI > Tool Access >
AI privacy. This shared policy applies to Netcatty-managed context and tools used by
Catty, integrated agents and external MCP clients. It is independent of the External
MCP switch. External stdio and Streamable HTTP clients use the same policy, including
for the environment resource.

This is not a system-wide AI traffic filter. Third-party agents' native tools,
direct file access and other MCP servers are outside the Netcatty-managed boundary.
Local terminal display, saved terminal output and actual host data are not changed.

## Working loop

A recognized address or credential in managed context or a tool response becomes an
opaque token, for example `[NC_<session>_IP_1]`. The same exact value has the same token
within its managed conversation or external MCP connection. A later managed command
or file-write argument containing that token is restored locally before permission
checks and the approval dialog. The host receives the original value; the agent
receives masked managed results.

Mappings stay in memory and are isolated by managed conversation or external MCP
connection. No mapping is saved to disk or shared through the app-wide external chat
scope. New conversations and reconnects start a new mapping. Unknown, stale, or
other-session tokens are rejected rather than sent to the host.

After changing privacy settings, start a new managed conversation and reconnect
external MCP clients. Existing scopes fail closed instead of silently changing
their protection. Settings apply only after main-process validation succeeds. A
saved legacy External MCP privacy preference is used only if no shared AI privacy
preference exists; applying valid settings saves the shared preference. Corrupt
saved settings must be repaired rather than silently reverting to unprotected
operation.

## What is covered

- Recognized credential assignments, authorization bearer values, URL passwords,
  familiar API token forms, structured secret fields and complete private-key blocks.
- IPv4 and IPv6 addresses, with private/local ranges retained by default. Enable
  **Redact private IP addresses** to hide them too, or select additional CIDRs.
  Documentation/test addresses are also masked.
- Structured host names and user-supplied regular-expression matches.
- Netcatty-managed text context, tool results, nested structured results and errors.

Custom expressions match whole values and use the existing RE2 engine. Unsupported
expressions, malformed CIDRs, or empty matches are rejected. Rules and mapping
sizes are bounded; exhaustion blocks the response instead of evicting active tokens.

Binary/base64 tool attachments are blocked while masking is enabled. This feature
does not scan images, archives, encoded/encrypted content, files accessed directly
by third-party agents, or other MCP servers' results. It cannot guarantee detection
of arbitrary credentials, all hostnames, or intentionally obfuscated data. It is an
accidental-disclosure safeguard, not a DLP system or a substitute for the normal
tool permission policy.

## Verification

Keep External MCP disabled and enable AI privacy. Use synthetic values in a new
Catty conversation and a new integrated-agent conversation, then repeat through
external stdio and HTTP clients after enabling External MCP: read `192.0.2.10`, read
`198.51.100.7`, then read the first again. Tokens should be different for different
values and stable for repeated reads within the same scope. Write a returned token
back through a managed tool or use it in a managed terminal command; the actual
file/terminal should contain the original value, never the token. A token from
another conversation/client or an earlier scope must fail without dispatching a
command. No protection should be implied for third-party native tool/file access.
