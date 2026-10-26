# Test integrated byte streams on the native desktop

Use `integration/plugin-byte-stream-handoff` from its integration PR. Record the
exact commit with `git rev-parse HEAD`. The branch preserves transport #3988
(`c4433d4961ecf4a81bea92b0a14f47b4ec12f679`), AI integration #3986
(`173ef5abbb1f8cea4e2c409c5791186926b778e1`), and source identity #3981
(`4213d8e6726c44e7a479418ece3adf16ea494782`) through ordinary merges.

## Prepare the desktop and fixture

Wait until the approved native GUI machine is free from SSH acceptance work.
Use a fresh disposable app profile, a working display, and the platform's normal
Electron sandbox. Keep the existing endpoint policy and system security settings.

The database pass requires a disposable MariaDB fixture at a reachable private
IPv4 address. The address must not belong to the GUI machine. The current native
GUI machine lacks Docker, so fixture provisioning is a prerequisite. Use an
already approved separate Docker host or disposable database machine with an
existing permitted network path. Do not install new software or create local
forwarding exceptions as part of this recipe. If no fixture is available, record
the database pass as pending.

The registered automated fixture uses
`mariadb:11.4@sha256:250e1609e93c0e6aecf64bfbab2d84d5e89d2481540fe77447ff6c855c3b1873`.
It runs on an internal Docker network, publishes no host ports, generates a
disposable password, and removes its container and network. On a prepared Linux
executor with that recognized image, run:

```sh
NETCATTY_BYTE_STREAM_DATABASE_TEST=1 node --test electron/plugins/byteStreamDatabase.live.test.cjs
```

That test exercises the protocol and broker. It does not install the plugin or
prove native GUI behavior. For the GUI fixture, have its operator create only
synthetic data and a dedicated SELECT-only account. Run this SQL using the
fixture's administration channel, replacing the password placeholder with a
fresh disposable password that is never included in screenshots or logs:

```sql
CREATE DATABASE plugin_demo;
CREATE TABLE plugin_demo.example_result (value VARCHAR(64));
INSERT INTO plugin_demo.example_result VALUES ('synthetic stream result');
CREATE USER 'plugin_demo'@'%' IDENTIFIED BY '<fresh-disposable-password>';
GRANT SELECT ON plugin_demo.example_result TO 'plugin_demo'@'%';
```

Use protocol 4.1 with `mysql_native_password`. The example uses plain TCP only
within the approved isolated fixture network. Verify INSERT denial independently
through the fixture's client. The plugin intentionally offers only its fixed read.

## Build and identify the packages

Use Node 22 or later and the lockfile. Run these commands in sequence:

```sh
npm ci
npm run test:plugin-runtime
npm run test:plugin-contract
npm run generate:plugin-contract
npm run check:plugin-contract
npm run generate:capability-tools
npm run check:codex-app-server-schema
npm run lint
npm run build
git diff --exit-code
```

For the reproducible packaging-only example, use the fixed synthetic endpoint:

```sh
node examples/plugins/database-minimal/prepare.mjs tcp://10.77.0.20:3306 /tmp/database-example.ncpkg
node examples/plugins/database-minimal/prepare.mjs tcp://10.77.0.20:3306 /tmp/database-example-repeat.ncpkg
cmp /tmp/database-example.ncpkg /tmp/database-example-repeat.ncpkg
node packages/plugin-cli/dist/cli.js validate /tmp/database-example.ncpkg
sha256sum /tmp/database-example.ncpkg
```

The two five-file packages built on Node 24.19.0 with the locked dependencies
match byte for byte. Their SHA-256 is
`88c1428343ef724b42a3b867a2d7645fb2b02c26e815ba5b9890e4c30dbc1af4`.
The six-file assistant package retains SHA-256
`8ef162d13d0a16878fb817462759c9221352d0565dcefebeb102ea3575a918e8`.

The preparation tool removes temporary build paths from its minified browser
bundle. Rebuild with the actual fixture endpoint before native testing. Validate
and record that package's new hash. Preparation does not dial the endpoint.

Build the assistant and follow its existing
[native QA recipe](assistant-native-qa.md). Use its deterministic local provider,
synthetic credential marker, and synthetic Note. No paid model call is required.
The AI internals were integrated without another independent review. The earlier
review denial remains in effect and is not replaced by these tests.

## Record the installed browser path

1. Launch the integrated app on the approved desktop with a new disposable
   `--user-data-dir`. Capture the full app window and record the exact commit.
2. In Settings > Plugins, import the database package. Capture its ID, version,
   package hash, source identity, browser entry, and exact endpoint permission.
   The import must leave the plugin disabled and optional access ungranted.
3. Enable it and open **Disposable database example**. Deny the first endpoint
   request. Capture the failure and verify the runtime remains usable.
4. Retry with only the disposable fixture credentials and allow the exact
   endpoint. Capture the one-row result and the source-aware permission prompt.
   The password field must clear when the request starts.
5. Record a video of a delayed fixture operation followed by **Cancel**. Use a
   delay offered by the fixture operator. Do not add a host protocol scheduler
   or change the query. Confirm the request stops and a fresh read still works.
6. Revoke `network.stream` while a connection is active. Confirm the panel reports
   failure and a new request prompts again. Disable, re-enable, close the view,
   and restart the app. No old connection or result may resume.
7. Record the assistant's denial, exact-text review, streamed result, usage,
   Stop, and post-revocation recovery through its linked recipe. Use the same
   integrated head and preserve its separate permission descriptions.
8. Remove only the synthetic plugins and profile. Have the fixture operator
   remove the disposable account, data, container, and network. Stop the synthetic
   model provider.

## Record the remaining evidence

Save the exact head, app platform/version, package hashes, ordered commands and
exit codes, screenshots, and video paths. Distinguish a skipped Docker test,
synthetic Node runtime integration, and actual native sandbox acceptance.

The address regression uses a mocked `os.networkInterfaces()` result and a fake
dialer. It never retries the reviewer's EPERM interface lookup. The cancellation
regression uses the registered package, host service, SDK, RPC, and real loopback
echo fixture under the existing test-only override. This override is unavailable
through the production service constructor. Neither test certifies the native
BrowserWindow sandbox or a live database pass on the GUI machine.

The integration executor completed these checks in order on 2026-10-26:

| Check | Result |
| --- | --- |
| `npm run test:plugin-runtime` | 624 tests: 622 passed, 2 skipped, 0 failed |
| `npm run test:plugin-contract` | 88 passed, 0 skipped, 0 failed |
| Plugin contract generate and drift check | Passed, no generated changes |
| Capability tool generation and drift check | Passed, no generated changes |
| Codex App Server schema check | Passed |
| `npm run lint` | Passed, 0 errors and 7 warnings outside the transport changes |
| `npm run build` | Passed, Vite production build completed in 32 seconds |
| Database repeat packaging and both package validations | Passed |

The skipped runtime tests are the opt-in Docker database fixture and native
Electron runtime suite. This executor has Docker, but the pinned MariaDB image
is not cached. No image was installed and no new live database run is claimed.
Native GUI acceptance remains pending on the occupied desktop. Full repository
tests and platform packages run in the integration PR's exact-head CI. Record
their final workflow conclusions separately from these local results.
