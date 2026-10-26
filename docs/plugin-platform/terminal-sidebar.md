# Terminal sidebar pages

The `terminal-sidebar` view location requires `views.terminal-sidebar` and the
existing `views` permission. This adds navigation and plugin-owned content to
the existing terminal pane/split system. It is not a session-data capability,
Provider subscription, terminal history reader or command execution API.

## Host-owned navigation

An Extension pages menu in the normal terminal toolbar lists visible pages
with their plugin source. Selecting one switches the existing focused pane;
selecting an already-open tool focuses that pane. Existing split menus include
the same contributions and enforce unique tools and the eight-pane limit.
Host-generated `plugin-view:<namespaced-view-id>` keys cannot replace built-in
tools. Declared order and ID determine listing order; existing host docking,
split resizing, magnification and close controls remain authoritative.

The manager's internal Open event can select a page only when an open terminal
is already selected. Otherwise the host asks the user to select a terminal; it
does not connect or open a saved host. Launcher events target the session from
the actual host terminal toolbar and are rechecked against current selection.
These are internal host UI events, not public SDK router methods or trusted
plugin `userGesture` flags.

## Session ownership without data sharing

The renderer binds each page to the actual terminal tab/workspace and current
focused child session. It passes only `netcatty.surface: terminal-sidebar` as
the view context. Internal ownership IDs are used for host state scoping, not
returned to the page or treated as resource grants. A future selected-session
data API must establish its own live endpoint authority and permissions.

Changing terminal tabs or workspace focus closes the old native view before
the new one can receive focus. Session removal, pane close, withdrawal of a
visible contribution, disable/update/uninstall and runtime loss remove the
affected page. Unknown saved routes are pruned without opening them; restoring
a layout never grants the page or any session-data permission. State buckets
are for the plugin's own UI data, not an isolation boundary against that same
plugin's already-authorized own-state API. Ordinary KV does not become synced.

PersistentSidePanelPortal moves a stable mount between the actual pane,
magnification host and hidden parking host. There is no fallback native view
over the entire terminal layer. Native geometry follows host DOM relocation,
resize and scrolling; duplicate geometry updates are suppressed. Hidden/inert
or parked mounts cannot reveal a native view.

## Focus and security surfaces

The existing sandbox ViewHost, immutable package/protocol checks, own-command
and view-state boundaries are reused. Embedded pages start hidden. Host
dialogs and overlapping portals hide them, and main-process App Lock closes
them. Escape is host-owned and closes the plugin pane.

Native WebContents focus is reported only to its actual owner's trusted
renderer using a canonical instance-ID event. It updates the selected pane;
it does not expose an Electron object to the plugin. Revealing multiple panes
does not focus all of them: only the host-selected pane can request focus.
The main process verifies actual owner, visibility, foreground and unlocked
state before honoring that request. A plugin has no SDK method to invoke the
host focus bridge. No session or page text is added to focus/audit logs.

## Example and evidence

`com.netcatty.session-scratchpad` 0.1.0 asks only for its own `views`. It saves,
reopens and clears explicitly typed synthetic text. Package instructions and
minimal native actions are in its README. Repository tests use real split
tree, layout state, persistent portal, launcher and embedded-view components;
host tests cover owner-bound focus, hidden/locked refusal and withdrawal.
Feature and permission admission, limits, old APIs and previous Vault/command
fixes are checked on the same stack. Independent review, exact-SHA CI and
parent native QA remain separate acceptance gates recorded on the Draft PR.

ThemePack, selected context/terminal drafts and SFTP handles remain subsequent
bounded stages. Adding a sidebar page does not count as implementing them.
