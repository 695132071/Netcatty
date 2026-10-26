# Local logging validation

Base: PR #3978 at `91b8927c56314e68c06e2c008e84559ddfb96d78`.
All data used in these checks is synthetic and each persistence test creates its
own temporary profile. No real logs or credentials were opened.

| Check | Result |
| --- | --- |
| `node --test electron/plugins/*.test.cjs` | 551 passed, 1 skipped (the Electron live test) |
| New logging settings, existing settings and permission-panel interaction tests | 4 passed |
| `npm run build` | Passed; existing large-chunk warning |
| `npm run lint` | No errors, 7 existing warnings; final changed-source lint also passed |
| `npm run check:plugin-contract` | Passed, no generated drift |
| `npx tsc --noEmit` against this change and the exact base | 773 diagnostics in each, zero added or removed after normalizing worktree paths |
| `git diff --check` | Passed |

Coverage includes disabled and enabled persistence, opt-in plugin text, sensitive
field exclusion, host source attribution, unknown-source fallback, URL rejection,
spoofed metadata, cyclic/accessor/proxy input, noisy writers, shared queue and disk
limits, rotation, expiration, drop/error counts, export, clear confirmation,
disable/revoke, stale runtime callbacks, and manager shutdown. The filesystem
regressions cover direct paths, symlink aliases, a symlinked profile directory,
and revocation during the final protected-storage check.

## Remaining native checks

Electron launch failed before application/profile startup. The executable at
`node_modules/electron/dist/electron --version` aborted with:

> The SUID sandbox helper binary was found, but is not configured correctly.

Its message requires `chrome-sandbox` to be root-owned with mode 4755. No sandbox
switch, privilege escalation, permission repair, or native retry followed. Native
smoke execution, screenshots, and a short recording remain pending. The acceptance
flow is in [Local plugin logging](local-logging.md#native-qa-with-synthetic-data).

`npm run pack:dir` completed its production build, then failed during serialport
native rebuilding: node-gyp returned ENOENT for mkdir
`/home/agent/.electron-gyp`. No system-directory change or packaging retry followed.
A native package was not produced.

## Parent integration

The only shared settings-page change is one import and one `<PluginLogSettings />`
element. Preserve that element when integrating the marketplace task's page.
There are no Installed, Official, Third-party, source-database, or unrelated host
data changes.

The source owner must inject `resolvePluginProvenance` into
`createPluginHostService`; its canonical source catalog stays authoritative.
Until that wiring lands, source and namespace fields are explicit `null` values.
No package or manifest claim is promoted into source identity.
