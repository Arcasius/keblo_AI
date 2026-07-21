"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const cacheRecord = require("../../core/hippocampus/embedding-cache/EmbeddingCacheRecord");

const {
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
} = cacheRecord;

const PRIVATE_USER_ID = "synthetic-private-user";
const CONTENT_HASH = createHash("sha256").update("synthetic-content", "utf8").digest("hex");
const IDENTITY_KEYS = [
  "schemaVersion", "logicalKeyHash", "userIdHash", "memoryId",
  "contentHash", "model", "revision"
];
const PAYLOAD_KEYS = [
  "schema_version", "logical_key_hash", "user_id_hash", "memory_id",
  "content_hash", "embedding_model", "embedding_revision", "normalized",
  "vector_fingerprint"
];

function identityInput(overrides = {}) {
  return {
    userId: PRIVATE_USER_ID,
    memoryId: "mem-synthetic-1",
    contentHash: CONTENT_HASH,
    model: EMBEDDING_CACHE_MODEL,
    revision: EMBEDDING_CACHE_REVISION,
    ...overrides
  };
}

function vector(position = 0) {
  const value = new Array(EMBEDDING_CACHE_DIMENSION).fill(0);
  value[position] = 1;
  return value;
}

function lengthPrefix(value) {
  const bytes = Buffer.from(value, "utf8");
  return Buffer.concat([Buffer.from(`${bytes.length}:`, "ascii"), bytes]);
}

function referenceLogicalKeyHash(input) {
  const canonical = Buffer.concat([
    lengthPrefix("hippocampus-embedding-cache-identity-v1"),
    lengthPrefix("1"),
    lengthPrefix(input.userId.trim()),
    lengthPrefix(input.memoryId),
    lengthPrefix(input.contentHash),
    lengthPrefix(input.model),
    lengthPrefix(input.revision)
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

test("exports the closed EC-1 constants", () => {
  assert.equal(EMBEDDING_CACHE_SCHEMA_VERSION, 1);
  assert.equal(EMBEDDING_CACHE_COLLECTION, "memoria_orbitale_hippocampus_embedding_cache_v1");
  assert.equal(EMBEDDING_CACHE_MODEL, "BAAI/bge-m3");
  assert.equal(EMBEDDING_CACHE_REVISION, "5617a9f61b028005a4858fdac845db406aefb181");
  assert.equal(EMBEDDING_CACHE_DIMENSION, 1024);
  assert.equal(EMBEDDING_CACHE_NORMALIZED, true);
  assert.equal(EMBEDDING_CACHE_NORM_TOLERANCE, 1e-3);
});

test("identity is deterministic, length-prefixed and contains no clear userId", () => {
  const input = identityInput({ userId: `  ${PRIVATE_USER_ID}  ` });
  const first = createIdentity(input);
  const second = createIdentity({ ...input });
  assert.deepEqual(first, second);
  assert.equal(first.logicalKeyHash, referenceLogicalKeyHash(input));
  assert.equal(first.userIdHash, createHash("sha256").update(PRIVATE_USER_ID).digest("hex"));
  assert.deepEqual(Object.keys(first).sort(), [...IDENTITY_KEYS].sort());
  assert.equal(Object.isFrozen(first), true);
  assert.doesNotMatch(JSON.stringify(first), new RegExp(PRIVATE_USER_ID));

  const ambiguousLeft = createIdentity(identityInput({ memoryId: "a:1:b" }));
  const ambiguousRight = createIdentity(identityInput({ memoryId: "a", contentHash: createHash("sha256").update("1:b").digest("hex") }));
  assert.notEqual(ambiguousLeft.logicalKeyHash, ambiguousRight.logicalKeyHash);
});

test("user, memoryId and contentHash produce distinct identities and point IDs", () => {
  const base = createIdentity(identityInput());
  for (const override of [
    { userId: "another-synthetic-user" },
    { memoryId: "mem-synthetic-2" },
    { contentHash: "a".repeat(64) }
  ]) {
    const changed = createIdentity(identityInput(override));
    assert.notEqual(changed.logicalKeyHash, base.logicalKeyHash);
    assert.notEqual(createPointId(changed), createPointId(base));
  }
});

test("identity rejects unexpected properties and incompatible model or revision", () => {
  for (const input of [
    identityInput({ unexpected: true }),
    identityInput({ userId: "   " }),
    identityInput({ memoryId: "" }),
    identityInput({ contentHash: CONTENT_HASH.toUpperCase() }),
    identityInput({ contentHash: "a".repeat(63) }),
    identityInput({ model: "other/model" }),
    identityInput({ revision: "0".repeat(40) })
  ]) {
    assert.throws(() => createIdentity(input), { code: "INVALID_IDENTITY", category: "identity" });
  }
});

test("point ID is a stable RFC-variant version-5 UUID", () => {
  const identity = createIdentity(identityInput());
  const pointId = createPointId(identity);
  assert.equal(pointId, createPointId(identity));
  assert.match(pointId, /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
});

test("valid embedding is copied to canonical frozen float32", () => {
  const input = vector();
  const canonical = validateEmbedding(input);
  assert.equal(canonical.length, 1024);
  assert.notStrictEqual(canonical, input);
  assert.equal(Object.isFrozen(canonical), true);
  assert.deepEqual(input, vector());
});

test("invalid dimension, values, zero vector and norm are rejected", () => {
  const wrongDimension = new Array(1023).fill(0);
  wrongDimension[0] = 1;
  const nonNumeric = vector();
  nonNumeric[10] = "0";
  const nan = vector();
  nan[10] = NaN;
  const infinity = vector();
  infinity[10] = Infinity;
  const wrongNorm = vector();
  wrongNorm[0] = 1 + EMBEDDING_CACHE_NORM_TOLERANCE * 2;
  for (const invalid of [wrongDimension, nonNumeric, nan, infinity, new Array(1024).fill(0), wrongNorm]) {
    assert.throws(() => validateEmbedding(invalid), { code: "INVALID_VECTOR", category: "vector" });
  }
});

test("norm is checked before and after float32 canonicalization", () => {
  const accepted = vector();
  accepted[0] = 1 + EMBEDDING_CACHE_NORM_TOLERANCE / 2;
  assert.doesNotThrow(() => validateEmbedding(accepted));

  const overflow = vector();
  overflow[0] = Number.MAX_VALUE;
  assert.throws(() => validateEmbedding(overflow), { code: "INVALID_VECTOR" });
});

test("fingerprint is SHA-256 of canonical float32 little-endian bytes", () => {
  const input = vector();
  const bytes = Buffer.alloc(1024 * 4);
  for (let index = 0; index < input.length; index += 1) bytes.writeFloatLE(Math.fround(input[index]), index * 4);
  const expected = createHash("sha256").update(bytes).digest("hex");
  assert.equal(createVectorFingerprint(input), expected);
  assert.equal(createVectorFingerprint(input), createVectorFingerprint([...input]));
});

test("float64 differences lost by float32 share a fingerprint", () => {
  const left = vector();
  const right = vector();
  right[0] = 1 + Number.EPSILON;
  assert.notEqual(left[0], right[0]);
  assert.equal(Math.fround(left[0]), Math.fround(right[0]));
  assert.equal(createVectorFingerprint(left), createVectorFingerprint(right));
});

test("real float32 differences produce a distinct fingerprint", () => {
  const left = vector();
  const right = vector();
  right[0] = Math.fround(1 - 5e-4);
  assert.notEqual(Math.fround(left[0]), Math.fround(right[0]));
  assert.notEqual(createVectorFingerprint(left), createVectorFingerprint(right));
});

test("payload is exact, closed, frozen and contains no private text or userId", () => {
  const identity = createIdentity(identityInput());
  const payload = createPayload(identity, vector());
  assert.deepEqual(Object.keys(payload).sort(), [...PAYLOAD_KEYS].sort());
  assert.equal(Object.isFrozen(payload), true);
  assert.equal(validatePayload(payload, identity, vector()), true);
  const serialized = JSON.stringify(payload);
  assert.doesNotMatch(serialized, new RegExp(PRIVATE_USER_ID));
  assert.doesNotMatch(serialized, /text|content["_]?\s*:|snippet|tag|title|entities|timestamp|path|endpoint|api.?key|processing|orbital/i);
});

test("unexpected or malformed payload properties are rejected", () => {
  const identity = createIdentity(identityInput());
  const payload = createPayload(identity, vector());
  for (const changed of [
    { ...payload, text: "private synthetic text" },
    { ...payload, normalized: false },
    { ...payload, vector_fingerprint: "not-a-hash" }
  ]) {
    assert.throws(() => validatePayload(changed, identity, vector()), {
      code: "INVALID_PAYLOAD", category: "payload"
    });
  }
});

test("payload tampering and full-hash collision guard produce identity conflict", () => {
  const identity = createIdentity(identityInput());
  const payload = createPayload(identity, vector());
  const sameUuidPrefix = `${identity.logicalKeyHash.slice(0, 32)}${"f".repeat(32)}`;
  assert.equal(sameUuidPrefix.slice(0, 32), identity.logicalKeyHash.slice(0, 32));
  for (const changed of [
    { ...payload, logical_key_hash: sameUuidPrefix },
    { ...payload, user_id_hash: "b".repeat(64) },
    { ...payload, memory_id: "mem-other" },
    { ...payload, content_hash: "c".repeat(64) },
    { ...payload, embedding_model: "other/model" },
    { ...payload, embedding_revision: "0".repeat(40) },
    { ...payload, vector_fingerprint: createVectorFingerprint(vector(1)) }
  ]) {
    assert.throws(() => validatePayload(changed, identity, vector()), {
      code: "IDENTITY_CONFLICT", category: "conflict"
    });
  }
});

test("errors are stable and sanitized", () => {
  assert.throws(() => createIdentity(identityInput({ userId: "private-sentinel", unexpected: "secret" })), (error) => {
    assert.equal(error instanceof EmbeddingCacheRecordError, true);
    assert.equal(error.code, "INVALID_IDENTITY");
    assert.equal(error.message, "Embedding cache record validation failed");
    assert.doesNotMatch(JSON.stringify(error), /private-sentinel|secret/);
    return true;
  });
});

test("module is pure and has no network, Qdrant, BGE, storage or global configuration dependency", () => {
  const source = fs.readFileSync(path.join(
    __dirname, "../../core/hippocampus/embedding-cache/EmbeddingCacheRecord.js"
  ), "utf8");
  assert.doesNotMatch(source, /fetch\s*\(|node:http|node:https|Qdrant|BgeM3|JsonMemoryStorage|StorageCapability|HippocampusDaemon|process\.env|globalThis/);
  const imports = [...source.matchAll(/require\("([^"]+)"\)/g)].map((match) => match[1]);
  assert.deepEqual(imports, ["node:crypto"]);
});
