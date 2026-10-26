# Host text interactions

Status: internal preview. This layer builds on the grant management in Draft
#3955. It adds `host.interactions` feature discovery, a generated request/result
contract, and an ordinary browser SDK workflow. Native acceptance remains a
separate parent-owned gate.

## SDK and authorization

| SDK call | Permission | Result |
| --- | --- | --- |
| `ui.quickPick(title, items)` | `ui.interact` | Approved item ID or `undefined` on cancel |
| `ui.input(title, initialValue?)` | `ui.interact` | Approved text or `undefined` on cancel |
| `clipboard.readText(title)` | `clipboard.read` | Explicitly shared snapshot or `undefined` on cancel |
| `clipboard.writeText(text, title)` | `clipboard.write` | `true` after copy, `false` on cancel |

All calls use the canonical `ui.interact` RPC. No host DOM, native object,
router, general command ID, or arbitrary IPC channel enters the SDK. Existing
API versions remain offered. A plugin requiring the new workflow declares
`features.required: ["host.interactions"]`; old hosts reject unsupported
required features. Old plugins keep their existing APIs and permissions.

Clipboard prompts restrict new permission decisions to once. Required or
previously saved grants never skip the host action confirmation. Input and
choice dialogs need their own declaration; a `views` or `menus` declaration is
not permission to open them. Direction-specific clipboard permissions remain
separate. The normal sample uses no network, host/session, filesystem, secret,
Node, or shell capability.

## User action and text sharing

The host always displays plugin ID/version and a fixed source heading. Titles,
choices, and text render as plain text. No plugin-supplied `userGesture` flag is
accepted. The host creates an HMAC action token bound to request ID, runtime,
plugin version, owner window, action kind, phase, nonce, and expiry. It sends
that token only to the trusted host renderer. A response must come from the
same WebContents and present the current token. Tokens are consumed before the
first asynchronous action guard, so old-phase and duplicate responses cannot
commit an action.

Clipboard reading has two steps. **Preview clipboard** authorizes a host read
into a bounded in-memory snapshot. The plugin receives nothing yet. **Share
with plugin** sends exactly that snapshot after another active-identity check.
Changes to the system clipboard after preview do not replace it. Cancel, lock,
window loss, or revoke discards the snapshot. Copy shows the exact replacement
text and requires its own confirmation before a native write.

Shared text can be sensitive. The host explains that it becomes available to
the plugin and its granted capabilities, including network access. Reading
text does not approve a new network destination. This UI does not claim to
prevent a plugin from transmitting derived text through an already granted
capability. The example avoids network permission entirely.

## Availability, limits, and cleanup

The first slice supports the focused, visible, unlocked main window only.
The host renderer registers readiness before any prompt can be presented.
Other or unready windows return unavailable instead of inheriting an owner's
authority. One interaction occupies an owner window at a time; there is no
hidden prompt queue.

`HostInteractionLimits` is the shared canonical source for 4,096 UTF-8 text
bytes, 100 choices, 64 KiB serialized requests, one pending request per runtime,
eight total, ten attempts per minute per runtime, and a 60-second lifetime.
The current main-window-only adapter is narrower than the total pending bound.
Admission runs before the permission prompt. The generic capability quotas and
byte windows still apply. Text exceeding its cap is rejected without silent
truncation. RPC uses the same generated deadline.

Input cancellation, timeout, disable/update/crash/revoke, owner blur/hide/close,
main-document reload, renderer exit, and app lock invalidate pending tokens.
Same-document or subframe navigation does not permanently unregister a live
host UI. Runtime teardown clears rate accounting. The broker checks runtime
activity, owner readiness/focus, and app lock again immediately before native
read/write or disclosure. A revoked operation cannot resume from a late reply.

Audit records contain only fixed event/action/kind fields. They contain no
prompt, choices, user text, clipboard bytes, action tokens, or hashes derived
from those values. A failed consent-audit write prevents the native action;
no successful operation is reported for that failure.

## Verification and native acceptance

The [browser fixture](../../examples/plugins/host-interactions/README.md)
exercises choice, input, copy, and clipboard transformation without a plugin
view. Tests cover the actual runtime/SDK RPC path through permission middleware,
actual host React dialog events against service-signed actions, denial, cancel,
quota before prompt, overlong text, duplicate/forged actions, wrong owners,
stale runtime, revoke during an asynchronous guard, audit failure, deadline,
lock, blur, document navigation, and renderer teardown.

Parent native acceptance uses a separately approved temporary example-plugin
session and synthetic clipboard text. It needs no real hosts, credentials,
network destination, shell, or persistent grant. Check both complete workflows,
cancel before reading, cancel after preview, cancel copy, and disable/revoke
with a pending dialog. Record the exact SHA and restore the test clipboard.
Unit tests are not evidence of native Electron acceptance.

Progress/toast, selected context and terminal sharing/drafts remain later slices.
Navigation uses the existing sandbox ViewHost and adds no content permission.
ThemePack and SFTP remain separate stages. This layer alone does not finish the
capability coverage matrix.
