# Vault extension pages

`views.vault-pages` adds the `vault-page` view location. A package must require
the feature and declare the existing `views` permission. Hosts without the
feature reject the package deterministically. Existing view locations and API
versions keep their behavior; there is no public plugin router or new Vault
read/write permission.

## User workflow

Visible, enabled contributions appear in Vault's **Extensions** group. The
host generates a namespaced route from the declared view ID, orders by declared
order and ID, localizes the label, and resolves the declared icon through the
existing safe icon pipeline. Built-in navigation and security entry points
remain host-owned. Collapsed navigation retains source-labelled accessible
buttons.

Selecting a page mounts its existing sandbox WebContentsView in the Vault main
content area. It does not create a top tab, use an aside overlay, open a
connection, or share host/session/Vault records. The trusted host context
contains only `netcatty.surface: vault-page`. The manager's existing Open action
can select the same page through an internal host event; this is not exposed
as a generic SDK navigation capability.

The `vault-scratchpad` browser example lets the user type synthetic text, save
it in the plugin's own view state, return to Hosts, reopen, and clear it. It
does not create a Vault Note or enable automatic cloud sync. The fixture asks
for only `views`; granting it does not approve another plugin or data access.

## Ownership and lifecycle

The host owns the route and validates the selected contribution against the
current visible catalog. Missing IDs, disable/uninstall/update, a false `when`,
failed activation or a host close return to Hosts. Focus restoration checks
the current section and active tab so an old fallback cannot steal focus after
a newer selection. Catalog listing does not activate a plugin.

The embedded host reuses PluginViewHost, its ephemeral session, CSP, no-Node
preload, protocol validation, own-command checks, and bounded own view state.
No DOM or Electron object enters the SDK. A window-route-and-slot scope separates
this page's state from other view placements; actual BrowserWindow ownership is
validated separately and does not rely on that state key. This initial embedded slice
closes on navigation away even if `retainContextWhenHidden` is declared.

Each opening reserves an instance ID owned by its actual BrowserWindow before
asynchronous activation. Close can cancel that reservation before native
construction. Owner closure, shutdown and renderer cleanup prevent a late open
from attaching; late responses are also closed by the renderer lifecycle
controller. Current plugin version/runtime and `when` are checked before
attachment and on subsequent contribution changes. Existing owner checks apply
to bounds, visibility, close and view-state IPC.

Host reload/renderer exit and a view renderer crash close the associated native
page. Plain Escape in a Vault page is handled by the host and returns to Hosts;
it does not dispatch a plugin command or expose a general navigation API.

Native child views sit above React portals. A Vault page starts hidden; the
trusted renderer reveals it only after checking the mount and host dialogs,
menus, popovers, overlay panels and lock surfaces. Overlapping host surfaces
hide the page. App Lock additionally closes all hosted plugin views and
cancels pending opens in the main process; showing a view while locked fails.

The shared manifest bound remains 128 views per package. Only one Vault page is
mounted per owner; listing and routing do not create a background view queue.
View-state JSON size limits and existing runtime/permission quotas remain in
force. No page text or state is added to audit logs by this adapter.

## Validation status

Source tests cover normal catalog selection, the actual embedded content slot,
host-modal occlusion, synchronous tab-away cleanup, withdrawn and invalid
routes, internal host selection, delayed open cancellation, feature/permission
admission, host ownership, `when` withdrawal and App Lock. Production build,
aggregate host tests and precise-SHA CI are reported on the accompanying Draft
PR. Parent native acceptance must use the packed browser example through
normal Settings and record its exact source SHA/package hash. Unit tests do
not substitute for that native acceptance.

Terminal sidebar pages and selected-session DTOs remain separate stages. This
page location does not make those capabilities available.
