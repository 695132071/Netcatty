# Plugin Starter

A minimal first-party browser plugin for learning import, settings and lifecycle.
It requests only `commands` and `settings.read`: no terminal text, host credentials,
network, files, secrets or advanced Node access. It works without OS key storage.
Permission declarations are not grants; follow the app's normal mediation.

From the repository root:

```sh
npm run build:plugin-packages
node packages/plugin-cli/dist/cli.js validate examples/plugins/starter-netcatty
node packages/plugin-cli/dist/cli.js pack examples/plugins/starter-netcatty --out /tmp/starter-netcatty.ncpkg
```

Start the actual app normally with a fresh test profile; no development flag is
needed. Open **Settings > Plugins > Installed**, import the package, inspect its
permissions and enable it. Change **Greeting**, then find **Starter: Read Greeting**
in the command palette. The command reads the preference and records it in the
plugin's local log; it does not write to a terminal or connect to a host.

Disable, restart and re-enable to verify the preference persists. Re-importing
the same package leaves it disabled for review. Uninstall removes code and local
KV; user-owned settings remain. The greeting is local only, not cloud-synced.

The separate Hello Netcatty example demonstrates terminal providers and requests
terminal permissions. Use this Starter for the default no-sensitive-access demo.
