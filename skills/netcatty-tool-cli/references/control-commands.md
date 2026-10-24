# Control Commands

Read this for diagnostics, cancellation, or bounded recovery after a session cannot continue.

## Useful Commands

- Existing connected/connecting sessions are reused by default and keep their original placement and owner. Use `--new-tab` only when a separate connection is needed; workspace placement applies to the newly opened session.
- Open a fresh saved-host session and bind it to the authenticated chat scope:
  - `<netcatty-cli-prefix> vault host open --host-id <id> --new-tab --json`
- Open a fresh pane inside the main window's active workspace:
  - `<netcatty-cli-prefix> vault host open --host-id <id> --new-tab --workspace-id current --json`
  - A concrete workspace ID is also accepted. A missing workspace is an error; the tool does not silently open elsewhere. `current` means the active workspace at execution time, not an arbitrary workspace inferred from a terminal label.
  - Confirm `scopeBound: true`, then call `session --session <returned-id> --json` before using execution or SFTP. `status: connecting` is not proof of a ready connection.
  - Opening a new session does not stop processes in an old terminal. Reconnect/close/reopen recovery remains a separate operation.

- Runtime diagnostics:
  - `<netcatty-cli-prefix> status --json`
- Cancel outstanding Netcatty work for this chat scope:
  - `<netcatty-cli-prefix> cancel --json`
- Re-enable execution for that same chat scope:
  - `<netcatty-cli-prefix> resume --json`

## Rules

- Tracked shell-backed PTYs wait for the current idle prompt before sending commands or interactive shell probes (local and remote, exec and job-start). The wait is bounded to 30 seconds and cancellable. `SHELL_NOT_READY` means no command was sent; inspect startup, a running program, pending input, or an unrecognized/custom prompt before retrying. Do not blindly retry commands after an execution timeout: they may already have started.
- A connected transport is not proof that the shell is ready. Prompt tracking is a heuristic; it cannot prove that every manually launched interactive application is idle. Raw network-device/serial CLIs and independent SSH exec channels use their separate protocol behavior.

- `cancel` affects the current chat scope; it requests cancellation for in-flight `exec`, session-backed SFTP transfers, and running `job-start` work in that scope. Later `exec` calls in that scope stay blocked until `resume`.
- Do not issue control commands concurrently with other Netcatty CLI commands for the same chat session.

## Bounded Recovery

1. Keep the task context: target host/session/workspace, active job, and last command outcome. Inspect `session --session <id> --json`; use scoped `env` when discovery is needed. Distinguish a transport failure from a program returning a nonzero exit code, a busy job, or a program waiting for input.
2. Prefer a usable existing session or an already in-flight auto-reconnect. For a known job, inspect it with `job-poll` at the host's normal polling cadence instead of injecting another command. Do not send a shell probe into a password/input prompt or an unknown foreground application.
3. For a transient connection/startup failure, allow at most three recovery attempts including the first, with waits of 2 seconds and then 5 seconds before retrying, and a 120-second elapsed budget including connection/wait time. Do not start another call if its budget would exceed the remaining time. User/host limits can shorten this policy. Do not reset an incident's budget by changing tabs or chat turns.
4. Use explicit reconnect/restart/move tools only if the running build exposes them and the current grant permits them. This PR adds no such tools; `resume` only removes a chat cancellation block, and `host open` does not reconnect an inactive disconnected tab. Do not invent a command or switch identities to obtain a missing capability.
5. When an independent connection is needed and host opening is available, verify the saved host identity and request the intended workspace explicitly (prefer its concrete ID when known). Create at most one new recovery session per incident; inspect/reuse that result instead of repeatedly opening tabs. Require successful scope binding and confirm session metadata before using it. Visible workspace membership alone does not grant access or ownership. Close only sessions the current scope is permitted to manage.
6. `SHELL_NOT_READY` from the tracked PTY readiness gate means the command was not delivered. Diagnose startup/busy/input/custom-prompt state before a bounded retry. An execution timeout, dropped response, or disconnect after delivery can mean the command ran: inspect its job/marker/process or durable result before considering replay, especially for writes or deployments.
7. Stop automatic recovery on authentication rejection, missing permission, revoked scope, an invalid target, or an explicit user stop. Do not call `resume` or open another connection to undo the user's cancellation. Preserve existing authorization for recovery actions already granted; do not ask for the same permission repeatedly.
8. When the budget is exhausted, stop that recovery branch, continue independent authorized work, and report the affected session, observed state, attempt count, and whether command completion is unknown. Do not silently omit blocked work or claim success.

Opening or closing a terminal connection does not confirm that an old remote process stopped. If process termination is necessary, first verify the same host and a unique process target (marker/PID/PGID and command/start-time evidence). A forced cancellation result releases tooling locks; it is not process-exit evidence.

Independent jobs may run on separate permitted sessions through `job-start`; issue CLI calls serially as required by the host. Avoid concurrent input to the same shell. These limits guide the agent's decisions; future lifecycle tools still need backend deadlines, permission checks, and duplicate-request protection.
