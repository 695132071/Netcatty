# Settings view handoff fixture

First-party synthetic native QA fixture, compatible with the manager-dialog
baseline `614b7c997a75afff2c64b796a9f11c3eec804b43`. This is not a marketplace
release. It declares only `views`, has an empty browser activation function and
one static `location: settings` HTML panel. It has no commands, host, terminal,
network, filesystem, secret or sync operation. Declarations are not grants.

```sh
node packages/plugin-cli/dist/cli.js validate examples/plugins/settings-view-fixture
node packages/plugin-cli/dist/cli.js pack examples/plugins/settings-view-fixture --out /tmp/settings-view-fixture.ncpkg
```

In a synthetic Electron profile, import disabled, inspect the manifest, then
Enable. In Installed, find **Static Settings View** and click its **Open** button
(the command palette is not this regression path). Review the normal permission
prompt; use only a specifically approved temporary grant. Denying must not open
a view. If allowed, the plugin manager must close before the external Settings
view appears. Verify its host-provided title/close button is clickable and can
receive focus; close it, then reopen plugin management. Do not use existing
Starter modal permission approval as authorization for this separate fixture.

Version 0.1.1 corrects the default-export entrypoint contract. It retains the same sole `views` declaration and static HTML. Version 0.1.0 failed before activation and must not be used for successful native acceptance.
