# Pinned static distribution schemas

`delivery.schema.json` and `index.schema.json` are unmodified UTF-8 files from
binaricat/netcatty-plugins commit 7bfe23e5627e16ba63806de6dded5b2667c02984
(PR 3). The host compiles them with the existing local plugin-contract schema;
no schema reference causes network access.

`../fixtures/static-distribution/` contains that commit's actual
`distribution/bootstrap/v1/snapshot.json`, snapshot catalog/index/delivery and
four referenced README/PNG assets. Raw-byte SHA-256 checks in
`staticDistribution.test.cjs` verify the publisher's supplied pointer and delivery
hashes; every document and asset is checked against the pointer/sidecar.
The fixture includes no executable plugin package, avatar or credentials.

Schema revisions must be coordinated with the registry publisher. In particular,
artifact/avatar are deliberately null in v1; do not expand this consumer alone.
