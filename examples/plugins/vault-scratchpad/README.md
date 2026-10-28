# Vault Scratchpad

Browser-only example of an actual Vault extension page. It needs only `views`
and the required `views.vault-pages` feature. No host/session/Vault data,
clipboard, network, filesystem, credentials or shell permission is requested.
Text explicitly typed here is stored in this plugin's own bounded view state;
it is not a Netcatty Note and is not automatically cloud-synced.

```sh
node packages/plugin-cli/dist/cli.js pack examples/plugins/vault-scratchpad --out /tmp/vault-scratchpad.ncpkg
```

Import disabled through normal Settings, inspect and enable it. Under Vault's
**Extensions** group choose **Scratchpad**. The sandbox must fill Vault's main
content area, retaining the built-in sidebar and top tabs. Opening its detail
entry must navigate to this same Vault page, without creating a top plugin tab.

For native QA, a separate explicit approval for this fixture's own `views`
permission is required; earlier fixtures' grants do not cover this ID. With
synthetic text, save, return to Hosts and reopen; verify the draft. Clear and
reopen to verify deletion. Cancel the first permission prompt to verify that no
page attaches. Switch away during opening, then disable/revoke and verify the
page/entry disappear. Closing or withdrawing a page returns to Hosts. A host
modal or overlapping menu must hide the native view while it is present.

This source example is not independent/native acceptance evidence. Parent QA
records the precise tested commit and package hash separately.

The page subscribes to `window.netcattyView.onDidChangeEnvironment()` in `theme.js`. It follows the seven public HSL theme variables, including accent changes, without reading host settings or DOM. The subscription is disposed on page hide.
