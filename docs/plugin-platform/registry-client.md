# Official registry client

The Community page refreshes the fixed endpoint
`https://raw.githubusercontent.com/binaricat/netcatty-plugins/main/catalog.json`
in the main process. The renderer cannot choose a registry URL. This endpoint
must be published separately; client implementation and synthetic tests do not
prove the repository or an online artifact is available.

## Catalog contract

`catalog.json` is an array of at most 1,000 current entries. Each entry supplies
`id`, `version`, `name`, `description`, `author`, `repository` (`owner/repository`),
`commit` (full 40-character SHA), `license`, `readme` (relative Markdown path),
and `manifest`. Optional `artifact` contains `url` and SHA-256 `sha256`.
The existing manifest schema, browser-only distribution policy, identity/version
and license checks apply. Source-only entries remain build-and-import examples.
No download counts, ratings, or timestamps are invented. Brand previews remain
bundled and reviewed; arbitrary author image URLs are never loaded.

Reads are anonymous HTTPS, redirect-free for the registry, bounded to 2 MiB,
and time out after 30 seconds. All entries must validate before replacing the
current snapshot. Invalid JSON/schema, network failure, and oversized responses
leave the previous good snapshot intact. Errors and Retry remain visible.
The last good catalog is retained **in memory for this application session**;
a fresh offline launch uses bundled examples. There is no new disk cache,
database migration, cloud sync record, or credential requirement.

## Selection and installation

Each returned entry has a host-generated `selectionToken` covering its complete
JSON contents. This is a concurrency check, **not a signature or trust proof**.
README requests must still match that selection and fetch its pinned source
commit. A changed entry requires refresh and renewed review.

A manual install must first refresh the official catalog successfully and match
the selected token again. Failed refresh is browse-only, even if the cached
entry has an artifact. Withdrawal, version changes, permission changes, README
changes, or artifact hash changes cannot silently replace the selected package.
Archive download then uses the existing approved-host, size, exact SHA-256,
manifest and package validation pipeline. Installation leaves the plugin disabled;
existing authorization gates still apply on activation/use.

`index.json` release history and withdrawal records are not consumed by this
first client. Removing an entry does **not** disable, uninstall, update, or delete
data from an already installed plugin. There are no background code updates.

## Verification boundary

Service regressions use synthetic network responses and package bytes; the
existing package manager tests cover archive admission. No third-party plugin,
real credential, real sync account, or live registry write is used. Native QA
must separately verify the visible offline/retry state and eventual real catalog
availability once the repository is published.
