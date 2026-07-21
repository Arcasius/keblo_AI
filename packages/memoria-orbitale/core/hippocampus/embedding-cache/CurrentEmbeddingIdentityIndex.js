"use strict";

const { createHash } = require("node:crypto");
const {
  EMBEDDING_CACHE_MODEL,
  EMBEDDING_CACHE_REVISION,
  EmbeddingCacheRecordError,
  createIdentity,
  createPointId
} = require("./EmbeddingCacheRecord");

const BUILD_KEYS = Object.freeze(["userId", "items"]);
const ITEM_KEYS = Object.freeze(["memoryId", "contentHash", "model", "revision"]);
const RECORDS = new WeakMap();
const OWNERS = new WeakMap();

class CurrentEmbeddingIdentityIndexError extends Error {
  constructor(code) {
    super("Current embedding identity index operation failed");
    this.name = "CurrentEmbeddingIdentityIndexError";
    this.code = code;
    this.phase = "identity";
    this.retryable = false;
  }
}

function fail(code) {
  throw new CurrentEmbeddingIdentityIndexError(code);
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

function ownerHash(userId) {
  return createHash("sha256").update(userId.trim(), "utf8").digest("hex");
}

function assertMemoryId(memoryId) {
  if (typeof memoryId !== "string" || memoryId.trim().length === 0) {
    fail("INVALID_MEMORY_ID");
  }
}

class CurrentEmbeddingIdentityIndex {
  constructor(input) {
    if (!hasExactKeys(input, BUILD_KEYS) || !Array.isArray(input.items) ||
        typeof input.userId !== "string" || input.userId.trim().length === 0) {
      fail("INVALID_INDEX_INPUT");
    }
    const records = new Map();
    const logicalIdentities = new Set();
    for (const item of input.items) {
      if (!hasExactKeys(item, ITEM_KEYS) || records.has(item.memoryId)) {
        fail(records.has(item?.memoryId) ? "DUPLICATE_MEMORY_ID" : "INVALID_INDEX_ITEM");
      }
      let identity;
      try {
        identity = createIdentity({
          userId: input.userId,
          memoryId: item.memoryId,
          contentHash: item.contentHash,
          model: item.model,
          revision: item.revision
        });
      } catch (error) {
        if (error instanceof EmbeddingCacheRecordError) fail(error.code);
        fail("INVALID_INDEX_ITEM");
      }
      if (logicalIdentities.has(identity.logicalKeyHash)) {
        fail("DUPLICATE_LOGICAL_IDENTITY");
      }
      logicalIdentities.add(identity.logicalKeyHash);
      records.set(item.memoryId, Object.freeze({
        contentHash: identity.contentHash,
        pointId: createPointId(identity),
        model: identity.model,
        revision: identity.revision
      }));
    }
    RECORDS.set(this, records);
    OWNERS.set(this, ownerHash(input.userId));
    Object.freeze(this);
  }

  get size() {
    return RECORDS.get(this).size;
  }

  has(memoryId) {
    assertMemoryId(memoryId);
    return RECORDS.get(this).has(memoryId);
  }

  getExpected(memoryId) {
    assertMemoryId(memoryId);
    return RECORDS.get(this).get(memoryId) || null;
  }
}

function createCurrentEmbeddingIdentityIndex(input) {
  return new CurrentEmbeddingIdentityIndex(input);
}

function buildCurrentEmbeddingIdentityIndex(input) {
  return new CurrentEmbeddingIdentityIndex(input);
}

function isCurrentEmbeddingIdentityIndexForUser(value, userId) {
  if (!(value instanceof CurrentEmbeddingIdentityIndex) ||
      typeof userId !== "string" || userId.trim().length === 0) {
    return false;
  }
  return OWNERS.get(value) === ownerHash(userId);
}

module.exports = {
  CurrentEmbeddingIdentityIndexError,
  CurrentEmbeddingIdentityIndex,
  createCurrentEmbeddingIdentityIndex,
  buildCurrentEmbeddingIdentityIndex,
  isCurrentEmbeddingIdentityIndexForUser
};
