# Official registry client

The Community page refreshes the fixed endpoint
`https://plugins.netcatty.app/catalog.json`
in the main process. The renderer cannot choose a registry URL. This endpoint
must be published separately; client implementation and synthetic tests do not
prove the repository or an online artifact is available.

## Catalog contract

`catalog.json` is an array of at most 1,000 current entries. Each entry supplies
`id`, `version`, `name`, `description`, `author`, `repository` (`owner/repository`),
`commit` (full 40-character SHA), `license`, `readme` (relative Markdown path),
and `manifest`. Optional `artifact` and `readmeAsset` each contain `url` and SHA-256 `sha256`.
`readme` remains source provenance only. `readmeAsset` identifies the reviewed
Markdown snapshot copied from that repository/commit into the static distribution.
An entry without it remains browseable, but README retrieval reports that no
snapshot is published; it never falls back to GitHub.
Unknown catalog-entry and asset fields are rejected. The whole JSON value,
including manifest defaults, uses the existing 128-level / 100,000-value budget
and finite-number validation. The existing manifest schema, browser-only distribution policy, identity/version
and license checks apply. Source-only entries remain build-and-import examples.
No download counts, ratings, or timestamps are invented. Brand previews remain
bundled and reviewed; arbitrary author image URLs are never loaded.

All automatic catalog, README and artifact reads use only the exact
`https://plugins.netcatty.app` origin. Reads are anonymous HTTPS and redirect-free, bounded to 2 MiB,
and time out after 30 seconds. All entries must validate, safely clone, and generate every selection token before
atomically replacing the current snapshot. Invalid JSON/schema, network failure, and oversized responses
leave the previous good snapshot intact. Errors and Retry remain visible. The Community header also has Refresh, including
when the last refresh succeeded; it is disabled while a request is pending.
The last good catalog is retained **in memory for this application session**;
a fresh offline launch uses bundled examples. There is no new disk cache,
database migration, cloud sync record, or credential requirement.

## Selection and installation

Each returned entry has a host-generated `selectionToken` covering its complete
JSON contents. This is a concurrency check, **not a signature or trust proof**.
README requests must still match that selection and verify the published
static snapshot SHA-256. A changed entry requires refresh and renewed review.

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
must separately verify the visible offline/retry state and eventual real static-distribution availability.


## Network path inventory

| Path | Automatic source | Failure behavior |
| --- | --- | --- |
| Catalog / manual refresh | Fixed official `/catalog.json` | Session last-known-good snapshot, or bundled source-only entries on first offline launch |
| README details | Entry `readmeAsset.url`, same official origin, 256 KiB limit and exact digest | Visible error/Retry; no GitHub source fallback |
| Package installation | Entry `artifact.url`, same official origin, 32 MiB limit and exact digest | Abort, retain current installation; no release/latest fallback |
| Uninstalled brand icons | Reviewed bundled raster previews | Default icon; no remote image request |
| Installed brand icons | Existing host-owned package resource decoder | Default icon; no activation or network request |
| Author avatars | Not implemented in this baseline | No GitHub avatar lookup |
| `index.json` history | Not consumed by this client | No request or automatic installed-plugin disable |
| Repository / README links | Explicit user-opened HTTPS external links | May open GitHub in the user's browser; not an automatic marketplace dependency |

The distribution is static, not a GitHub proxy. The publishing pipeline, rather
than each user's application, prepares reviewed snapshots. An optional future
avatar/icon asset contract must preserve host-side size/hash/format validation;
arbitrary remote image fields are currently rejected. README HTML and remote
images remain inert in the existing renderer.

The static catalog can add `readmeAsset` without changing plugin manifests or SDK
API versions. Older clients have strict catalog fields and must keep their legacy
feed unchanged; publish the new metadata only to this distribution endpoint.
Missing README snapshots are tolerated for bundled/legacy entries so offline
startup still lists examples. Their source links remain explicit actions.

No successful CDN request, mainland reachability guarantee, real package artifact,
or new plugin permission is implied by synthetic service tests. Source-only
examples stay source-only until an actual reviewed package is published.
