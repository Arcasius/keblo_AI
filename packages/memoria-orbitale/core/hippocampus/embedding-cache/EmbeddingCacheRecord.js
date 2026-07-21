"use strict";

const { createHash } = require("node:crypto");

const EMBEDDING_CACHE_SCHEMA_VERSION = 1;
const EMBEDDING_CACHE_COLLECTION = "memoria_orbitale_hippocampus_embedding_cache_v1";
const EMBEDDING_CACHE_MODEL = "BAAI/bge-m3";
const EMBEDDING_CACHE_REVISION = "5617a9f61b028005a4858fdac845db406aefb181";
const EMBEDDING_CACHE_DIMENSION = 1024;
const EMBEDDING_CACHE_NORMALIZED = true;
const EMBEDDING_CACHE_NORM_TOLERANCE = 1e-3;

const HEX_64 = /^[a-f0-9]{64}$/;
const IDENTITY_INPUT_KEYS = Object.freeze([
  "userId", "memoryId", "contentHash", "model", "revision"
]);
const IDENTITY_KEYS = Object.freeze([
  "schemaVersion", "logicalKeyHash", "userIdHash", "memoryId",
  "contentHash", "model", "revision"
]);
const PAYLOAD_KEYS = Object.freeze([
  "schema_version", "logical_key_hash", "user_id_hash", "memory_id",
  "content_hash", "embedding_model", "embedding_revision", "normalized",
  "vector_fingerprint"
]);
const IDENTITY_DOMAIN = "hippocampus-embedding-cache-identity-v1";

class EmbeddingCacheRecordError extends Error {
  constructor(code, category) {
    super("Embedding cache record validation failed");
    this.name = "EmbeddingCacheRecordError";
    this.code = code;
    this.category = category;
  }
}

function fail(code, category) {
  throw new EmbeddingCacheRecordError(code, category);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, expected) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index]);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function lengthPrefix(value) {
  const encoded = Buffer.from(value, "utf8");
  return Buffer.concat([Buffer.from(`${encoded.length}:`, "ascii"), encoded]);
}

function canonicalIdentityBytes(input) {
  return Buffer.concat([
    lengthPrefix(IDENTITY_DOMAIN),
    lengthPrefix(String(EMBEDDING_CACHE_SCHEMA_VERSION)),
    lengthPrefix(input.userId.trim()),
    lengthPrefix(input.memoryId),
    lengthPrefix(input.contentHash),
    lengthPrefix(input.model),
    lengthPrefix(input.revision)
  ]);
}

function assertIdentityInput(input) {
  if (!hasExactKeys(input, IDENTITY_INPUT_KEYS) ||
      typeof input.userId !== "string" || input.userId.trim().length === 0 ||
      typeof input.memoryId !== "string" || input.memoryId.trim().length === 0 ||
      !HEX_64.test(input.contentHash || "") ||
      input.model !== EMBEDDING_CACHE_MODEL ||
      input.revision !== EMBEDDING_CACHE_REVISION) {
    fail("INVALID_IDENTITY", "identity");
  }
}

function assertIdentity(identity) {
  if (!hasExactKeys(identity, IDENTITY_KEYS) ||
      identity.schemaVersion !== EMBEDDING_CACHE_SCHEMA_VERSION ||
      !HEX_64.test(identity.logicalKeyHash || "") ||
      !HEX_64.test(identity.userIdHash || "") ||
      typeof identity.memoryId !== "string" || identity.memoryId.trim().length === 0 ||
      !HEX_64.test(identity.contentHash || "") ||
      identity.model !== EMBEDDING_CACHE_MODEL ||
      identity.revision !== EMBEDDING_CACHE_REVISION) {
    fail("INVALID_IDENTITY", "identity");
  }
}

function createIdentity(input) {
  assertIdentityInput(input);
  const normalizedUserId = input.userId.trim();
  return Object.freeze({
    schemaVersion: EMBEDDING_CACHE_SCHEMA_VERSION,
    logicalKeyHash: sha256(canonicalIdentityBytes(input)),
    userIdHash: sha256(Buffer.from(normalizedUserId, "utf8")),
    memoryId: input.memoryId,
    contentHash: input.contentHash,
    model: input.model,
    revision: input.revision
  });
}

function createPointId(identity) {
  assertIdentity(identity);
  const bytes = Buffer.from(identity.logicalKeyHash.slice(0, 32), "hex");
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const value = bytes.toString("hex");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-` +
    `${value.slice(16, 20)}-${value.slice(20, 32)}`;
}

function assertNormalizedNorm(normSquared) {
  const norm = Math.sqrt(normSquared);
  if (!Number.isFinite(norm) || norm === 0 ||
      Math.abs(norm - 1) > EMBEDDING_CACHE_NORM_TOLERANCE) {
    fail("INVALID_VECTOR", "vector");
  }
}

function validateEmbedding(vector) {
  if (!Array.isArray(vector) || vector.length !== EMBEDDING_CACHE_DIMENSION) {
    fail("INVALID_VECTOR", "vector");
  }
  let sourceNormSquared = 0;
  for (const value of vector) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      fail("INVALID_VECTOR", "vector");
    }
    sourceNormSquared += value * value;
  }
  assertNormalizedNorm(sourceNormSquared);

  const canonical = new Array(EMBEDDING_CACHE_DIMENSION);
  let canonicalNormSquared = 0;
  for (let index = 0; index < vector.length; index += 1) {
    const value = Math.fround(vector[index]);
    if (!Number.isFinite(value)) fail("INVALID_VECTOR", "vector");
    canonical[index] = value;
    canonicalNormSquared += value * value;
  }
  assertNormalizedNorm(canonicalNormSquared);
  return Object.freeze(canonical);
}

function createVectorFingerprint(vector) {
  const canonical = validateEmbedding(vector);
  const bytes = Buffer.allocUnsafe(EMBEDDING_CACHE_DIMENSION * Float32Array.BYTES_PER_ELEMENT);
  for (let index = 0; index < canonical.length; index += 1) {
    bytes.writeFloatLE(canonical[index], index * Float32Array.BYTES_PER_ELEMENT);
  }
  return sha256(bytes);
}

function createPayload(identity, vector) {
  assertIdentity(identity);
  return Object.freeze({
    schema_version: EMBEDDING_CACHE_SCHEMA_VERSION,
    logical_key_hash: identity.logicalKeyHash,
    user_id_hash: identity.userIdHash,
    memory_id: identity.memoryId,
    content_hash: identity.contentHash,
    embedding_model: identity.model,
    embedding_revision: identity.revision,
    normalized: EMBEDDING_CACHE_NORMALIZED,
    vector_fingerprint: createVectorFingerprint(vector)
  });
}

function validatePayload(payload, expectedIdentity, vector) {
  assertIdentity(expectedIdentity);
  if (!hasExactKeys(payload, PAYLOAD_KEYS) ||
      payload.schema_version !== EMBEDDING_CACHE_SCHEMA_VERSION ||
      !HEX_64.test(payload.logical_key_hash || "") ||
      !HEX_64.test(payload.user_id_hash || "") ||
      typeof payload.memory_id !== "string" || payload.memory_id.trim().length === 0 ||
      !HEX_64.test(payload.content_hash || "") ||
      typeof payload.embedding_model !== "string" || payload.embedding_model.length === 0 ||
      typeof payload.embedding_revision !== "string" || payload.embedding_revision.length === 0 ||
      payload.normalized !== EMBEDDING_CACHE_NORMALIZED ||
      !HEX_64.test(payload.vector_fingerprint || "")) {
    fail("INVALID_PAYLOAD", "payload");
  }

  const expectedFingerprint = createVectorFingerprint(vector);
  if (payload.logical_key_hash !== expectedIdentity.logicalKeyHash ||
      payload.user_id_hash !== expectedIdentity.userIdHash ||
      payload.memory_id !== expectedIdentity.memoryId ||
      payload.content_hash !== expectedIdentity.contentHash ||
      payload.embedding_model !== expectedIdentity.model ||
      payload.embedding_revision !== expectedIdentity.revision ||
      payload.vector_fingerprint !== expectedFingerprint) {
    fail("IDENTITY_CONFLICT", "conflict");
  }
  return true;
}

module.exports = {
  EMBEDDING_CACHE_SCHEMA_VERSION,
  EMBEDDING_CACHE_COLLECTION,
  EMBEDDING_CACHE_MODEL,
  EMBEDDING_CACHE_REVISION,
  EMBEDDING_CACHE_DIMENSION,
  EMBEDDING_CACHE_NORMALIZED,
  EMBEDDING_CACHE_NORM_TOLERANCE,
  EmbeddingCacheRecordError,
  createIdentity,
  createPointId,
  validateEmbedding,
  createVectorFingerprint,
  createPayload,
  validatePayload
};
