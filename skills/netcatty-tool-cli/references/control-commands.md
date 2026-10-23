# Control Commands

Read this when you need diagnostics, cancellation, or to re-enable a cancelled chat scope.

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
