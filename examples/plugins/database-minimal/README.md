# Run the disposable database example

Use the Linux cloud GUI machine assigned by the parent. Keep the existing
Chromium sandbox settings. Use a fresh, isolated Netcatty QA profile. This
example does not use saved SSH or AI credentials.

## Prepare the fixture and package

1. Check out the exact transport PR head and run `npm ci` followed by
   `npm run build:plugin-runtime-deps`.
2. Create a dedicated internal Docker network. Do not alter an existing
   network if this subnet is already in use.

   ```sh
   docker network create --internal --subnet 172.30.247.0/24 netcatty-plugin-db-qa
   docker run --detach --rm --name netcatty-plugin-db-qa \
     --network netcatty-plugin-db-qa --ip 172.30.247.2 \
     --env MARIADB_ALLOW_EMPTY_ROOT_PASSWORD=1 \
     mariadb:11.4@sha256:250e1609e93c0e6aecf64bfbab2d84d5e89d2481540fe77447ff6c855c3b1873
   ```

3. Wait for `docker exec netcatty-plugin-db-qa mariadb-admin --host=127.0.0.1 ping --silent`
   to succeed. The container publishes no host ports and has no external route.
   The empty administrative password exists only in this disposable container.
4. Open its local client with
   `docker exec -it netcatty-plugin-db-qa mariadb --protocol=socket --user=root`.
   Create the fixture below. Replace the password placeholder with a new
   synthetic session password. Do not put a real password in this example.

   ```sql
   CREATE DATABASE plugin_demo;
   CREATE TABLE plugin_demo.example_result (value VARCHAR(64));
   INSERT INTO plugin_demo.example_result VALUES ('synthetic stream result');
   CREATE USER 'plugin_demo'@'%' IDENTIFIED BY '<new-synthetic-session-password>';
   GRANT SELECT ON plugin_demo.example_result TO 'plugin_demo'@'%';
   ```

5. Build the normal browser package for this exact endpoint:

   ```sh
   node examples/plugins/database-minimal/prepare.mjs \
     tcp://172.30.247.2:3306 /tmp/database-minimal.ncpkg
   ```

   The tool prints the package hash, not credentials. Its temporary staging
   directory is removed. Only the manifest, browser bundle, and three view
   assets enter the five-file package. No Node preparation tool, server setup,
   dependency tree, or credential file enters the package.

If a different private subnet is needed, prepare a new package for its exact
fixture IP. Record the new package hash and review its endpoint permission.
The example page does not accept arbitrary hosts or SQL.

## Run automated entrypoint acceptance

From the repository root, run:

```sh
NETCATTY_BYTE_STREAM_DATABASE_TEST=1 node --test examples/plugins/database-minimal/protocol.live.test.cjs
```

The test creates its own isolated server, random session password, and temporary
package. It exercises both the transport core and the installed example entry
through the registered SDK/RPC path. It removes the container, network, package
and profile afterward. The in-process runtime harness does not prove native
browser sandbox behavior.

## Record native acceptance

1. Start the exact build with the existing sandbox settings and isolated
   profile. Install the `.ncpkg` through the ordinary plugin manager. Its source
   is a local import, not a claim of official maintenance.
2. Enable the plugin and open **Disposable database example** from its view
   action. Record the plugin detail screen, source, version, and exact endpoint
   resource. The plugin has a browser entry only.
3. Enter `plugin_demo` and the synthetic session password. The password input
   is masked and clears before dispatch. Click **Connect and read** and deny
   the endpoint prompt. The page must show a bounded failure and remain usable.
4. Retry and allow only `tcp://172.30.247.2:3306`. Record the permission prompt
   and the result `{"columns":["value"],"rows":[["synthetic stream result"]]}`.
   Do not record the password or administrative client session.
5. Revoke the stream grant in the manager, retry, and deny. Check that no
   connection remains. Test **Cancel**, close/reopen the view, and disable the
   plugin during a pending request. Restart with the same QA profile: the
   plugin must require the session password again.
6. Inspect generic connection audit records. Record endpoint, open/close and
   byte counts; verify that neither the password, SQL nor result body appears.
   Verify the account's server-side write denial in the disposable server.

Save screenshots of install/details, denial, endpoint approval and the result,
plus a short recording of denial/retry/query/revoke/disable. This recipe does
not claim that native QA has run. The automated Node entrypoint harness is not
a BrowserWindow sandbox test.

The example database connection is plaintext only inside the disposable
network. It does not test MySQL STARTTLS. Generic TLS transport has separate
real-socket certificate and hostname validation tests. Do not use this example
with real data or an existing database.

## Remove the fixture

Disable and uninstall the example, then remove the temporary container and
network:

```sh
docker rm --force netcatty-plugin-db-qa
docker network rm netcatty-plugin-db-qa
```

The container, its synthetic credential hashes, and data disappear. Remove the
prepared package and isolated QA profile after retaining the required evidence.
