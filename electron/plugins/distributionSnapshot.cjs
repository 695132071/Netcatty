"use strict";

const { createHash } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const Ajv2020 = require("ajv/dist/2020").default;
const addFormats = require("ajv-formats").default;
const { assertPluginJsonValue } = require("./jsonBoundary.cjs");
const { fetchBounded, validateCatalog, DISTRIBUTION_ORIGIN, MAX_CATALOG_BYTES } = require("./catalogService.cjs");
const { formatValidationErrors } = require("./contractValidator.cjs");
const REGISTRY_URL = `${DISTRIBUTION_ORIGIN}/v1/snapshot.json`;
const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: true });
addFormats(ajv);
ajv.addSchema(require("./generated/plugin-contract.schema.json"));
const validateIndex = ajv.compile(require("./distribution/index.schema.json"));
const validateDelivery = ajv.compile(require("./distribution/delivery.schema.json"));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const tuple = (entry) => JSON.stringify([entry.id, entry.version, entry.repository, entry.commit]);

function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function assertReference(ref, path, limit) {
  if (!exactKeys(ref, ["path", "sha256", "size"]) || typeof ref.sha256 !== "string" || !SHA256.test(ref.sha256)
    || ref.path !== path || !Number.isSafeInteger(ref.size) || ref.size < 0 || ref.size > limit) {
    throw new Error("Invalid static snapshot resource reference");
  }
}
function parseJson(bytes, label, limit = MAX_CATALOG_BYTES) {
  const value = JSON.parse(bytes.toString("utf8"));
  assertPluginJsonValue(value, { maxBytes: limit });
  if (!value || typeof value !== "object") throw new Error(`Invalid ${label}`);
  return value;
}
function assertPointer(pointer) {
  if (!exactKeys(pointer, ["schemaVersion", "registryCommit", "snapshotId", "catalog", "index", "delivery"])
    || pointer.schemaVersion !== 1 || typeof pointer.registryCommit !== "string" || !COMMIT.test(pointer.registryCommit)
    || typeof pointer.snapshotId !== "string" || !SHA256.test(pointer.snapshotId)) {
    throw new Error("Invalid static snapshot pointer");
  }
  for (const name of ["catalog", "index", "delivery"]) {
    assertReference(pointer[name], `/snapshots/${pointer.snapshotId}/${name}.json`, MAX_CATALOG_BYTES);
  }
  if (pointer.snapshotId !== pointer.delivery.sha256) throw new Error("Snapshot identity does not match delivery hash");
}
function assertAsset(ref, extensions) {
  if (!ref || typeof ref.path !== "string" || !extensions.some((extension) => ref.path === `/assets/${ref.sha256}.${extension}`)) {
    throw new Error("Invalid static asset path or format");
  }
  assertReference(ref, ref.path, 256 * 1024);
}
async function fetchVerified(ref, fetchImpl) {
  const bytes = await fetchBounded(`${DISTRIBUTION_ORIGIN}${ref.path}`, ref.size, fetchImpl);
  if (bytes.byteLength !== ref.size || digest(bytes) !== ref.sha256) throw new Error("Static resource size or SHA-256 mismatch");
  return bytes;
}
function validateSet(pointer, entries, index, delivery) {
  validateCatalog(entries);
  if (!validateIndex(index)) throw new Error(`Invalid distribution index: ${formatValidationErrors(validateIndex.errors)}`);
  if (!validateDelivery(delivery)) throw new Error(`Invalid static delivery: ${formatValidationErrors(validateDelivery.errors)}`);
  if (delivery.registryCommit !== pointer.registryCommit || delivery.catalogSha256 !== pointer.catalog.sha256
    || delivery.indexSha256 !== pointer.index.sha256) throw new Error("Static snapshot documents do not match");
  // v1 publishing deliberately refuses packages and avatars. Do not extend this
  // consumer ahead of the reviewed publishing schema or invent installable code.
  if (entries.some((entry) => entry.artifact)) throw new Error("Static delivery v1 is source-only");
  const current = new Map();
  const indexIds = new Set();
  for (const plugin of index.plugins) {
    if (indexIds.has(plugin.id)) throw new Error("Duplicate distribution index plugin");
    indexIds.add(plugin.id);
    const versions = new Map();
    for (const version of plugin.versions) {
      if (version.entry.id !== plugin.id || versions.has(version.entry.version)) throw new Error("Invalid distribution version identity");
      versions.set(version.entry.version, version);
    }
    if (plugin.current !== null) {
      const version = versions.get(plugin.current);
      if (!version || version.withdrawal !== null || version.distribution !== "source-only") throw new Error("Current distribution version is missing or withdrawn");
      current.set(plugin.id, version.entry);
    }
  }
  if (current.size !== entries.length || entries.some((entry) => !isDeepStrictEqual(current.get(entry.id), entry))) {
    throw new Error("Catalog does not match the current non-withdrawn index");
  }
  const resources = new Map();
  const catalogTuples = new Set(entries.map(tuple));
  for (const plugin of delivery.plugins) {
    const key = tuple(plugin);
    if (!catalogTuples.has(key) || resources.has(key)) throw new Error("Delivery identity does not match catalog tuple");
    assertAsset(plugin.readme, ["md"]);
    for (const icon of [plugin.iconLight, plugin.iconDark]) if (icon !== null) assertAsset(icon, ["png", "webp"]);
    resources.set(key, plugin);
  }
  if (resources.size !== entries.length) throw new Error("Missing delivery entry for catalog plugin");
  return resources;
}
async function fetchDistribution(fetchImpl) {
  const pointer = parseJson(await fetchBounded(REGISTRY_URL, 16 * 1024, fetchImpl), "snapshot pointer", 16 * 1024);
  assertPointer(pointer);
  const documents = await Promise.all(["catalog", "index", "delivery"].map(async (name) => parseJson(await fetchVerified(pointer[name], fetchImpl), name)));
  const [entries, index, delivery] = documents;
  const resources = validateSet(pointer, entries, index, delivery);
  return { entries, resources, pointer };
}
module.exports = { REGISTRY_URL, fetchDistribution, fetchVerified, tuple, validateSet, assertPointer, assertAsset };
