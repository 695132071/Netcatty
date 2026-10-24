# Error Handling

Read this when a Netcatty CLI call fails or returns a blocked state.

## Rules

- Treat Netcatty CLI errors as authoritative. Do not argue with them or try alternate launch methods.
- If Netcatty returns `COMMAND_ALREADY_RUNNING`, inspect/wait for the existing operation with a bounded recovery budget instead of retrying in parallel. See `control-commands.md`; do not wait indefinitely or assume the shell is stuck.
- For transient disconnect/startup failures, follow the bounded retry/backoff policy in `control-commands.md`. Authentication, permission, scope, and explicit user-cancellation failures are not signals for repeated reconnects or alternate entrypoints.
- After an execution timeout or lost response, command completion may be unknown. Do not replay a potentially mutating command without inspecting its outcome.
- Netcatty enforces scope, approvals, blocklists, and timeouts. Do not try to bypass those checks with wrappers or alternate shells.
- If a direct command fails and the failure suggests the task genuinely needs branching or parsing logic, then consider a small script. Otherwise keep commands simple.
