"use strict";

const { createHash } = require("node:crypto");
const {
  EMBEDDING_CACHE_MODEL,
  EMBEDDING_CACHE_REVISION,
  EMBEDDING_CACHE_DIMENSION,
  EmbeddingCacheRecordError,
  createIdentity,
  createPointId,
  validateEmbedding
} = require("./EmbeddingCacheRecord");
const {
  EXPECTED_MODEL,
  EXPECTED_REVISION,
  EXPECTED_DIMENSION,
  EXPECTED_NORMALIZED
} = require("../../providers/embedding/BgeM3EmbeddingProvider");

const MAX_MATERIALIZE_ITEMS = 4096;
const MIN_EMBEDDING_BATCH_SIZE = 1;
const MAX_EMBEDDING_BATCH_SIZE = 128;
const OPTION_KEYS = Object.freeze([
  "cacheAdapter", "embeddingProvider", "embeddingBatchSize", "model", "revision"
]);
const REQUEST_KEYS = Object.freeze(["items", "signal"]);
const ITEM_KEYS = Object.freeze(["userId", "memoryId", "contentHash", "text"]);
const LOOKUP_KEYS = Object.freeze(["status", "reasonCode", "pointId", "embedding"]);
const MISS_KEYS = Object.freeze(["status", "reasonCode", "pointId"]);
const UPSERT_RESULT_KEYS = Object.freeze([
  "pointId", "created", "idempotentReplay"
]);
const RESPONSE_ITEM_KEYS = Object.freeze(["id", "contentHash", "embedding"]);
const HEX_64 = /^[a-f0-9]{64}$/;

class BgeM3EmbeddingCacheCoordinatorError extends Error {
  constructor(code, phase, retryable, details = {}) {
    super("BGE-M3 embedding cache coordinator operation failed");
    this.name = "BgeM3EmbeddingCacheCoordinatorError";
    this.code = code;
    this.phase = phase;
    this.retryable = retryable;
    if (Number.isInteger(details.status)) this.status = details.status;
  }
}

function fail(code, phase, retryable = false, details) {
  throw new BgeM3EmbeddingCacheCoordinatorError(code, phase, retryable, details);
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

function assertSignal(signal) {
  if (!signal || typeof signal.aborted !== "boolean" ||
      typeof signal.addEventListener !== "function") {
    fail("INVALID_REQUEST", "request");
  }
}

function assertNotAborted(signal) {
  if (signal.aborted) fail("MATERIALIZE_ABORTED", "request", true);
}

function sha256Text(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function classifyDependencyError(error, phase) {
  if (error instanceof BgeM3EmbeddingCacheCoordinatorError) throw error;
  const status = Number.isInteger(error?.status) ? error.status : undefined;
  const code = typeof error?.code === "string" && /^[A-Z][A-Z0-9_]*$/.test(error.code)
    ? error.code
    : "DEPENDENCY_FAILURE";
  const retryable = error?.retryable === true;
  throw new BgeM3EmbeddingCacheCoordinatorError(code, phase, retryable, { status });
}

async function callDependency(target, method, request, phase) {
  try {
    return await target[method](request);
  } catch (error) {
    classifyDependencyError(error, phase);
  }
}

function validateOptions(options) {
  if (!hasExactKeys(options, OPTION_KEYS) ||
      !options.cacheAdapter || typeof options.cacheAdapter !== "object" ||
      typeof options.cacheAdapter.getValidEmbedding !== "function" ||
      typeof options.cacheAdapter.upsertEmbedding !== "function" ||
      !options.embeddingProvider || typeof options.embeddingProvider !== "object" ||
      typeof options.embeddingProvider.embedBatch !== "function" ||
      !Number.isInteger(options.embeddingBatchSize) ||
      options.embeddingBatchSize < MIN_EMBEDDING_BATCH_SIZE ||
      options.embeddingBatchSize > MAX_EMBEDDING_BATCH_SIZE ||
      options.model !== EMBEDDING_CACHE_MODEL ||
      options.revision !== EMBEDDING_CACHE_REVISION ||
      options.model !== EXPECTED_MODEL ||
      options.revision !== EXPECTED_REVISION ||
      options.embeddingProvider.model !== EXPECTED_MODEL ||
      options.embeddingProvider.revision !== EXPECTED_REVISION ||
      options.embeddingProvider.dimension !== EXPECTED_DIMENSION ||
      options.embeddingProvider.normalized !== EXPECTED_NORMALIZED ||
      EXPECTED_DIMENSION !== EMBEDDING_CACHE_DIMENSION) {
    fail("INVALID_CONFIGURATION", "configuration");
  }
}

function validatedWork(request) {
  if (!hasExactKeys(request, REQUEST_KEYS) || !Array.isArray(request.items) ||
      request.items.length === 0 || request.items.length > MAX_MATERIALIZE_ITEMS) {
    fail("INVALID_REQUEST", "request");
  }
  assertSignal(request.signal);
  const logicalHashes = new Set();
  const pointIds = new Map();
  const work = [];
  for (const item of request.items) {
    if (!hasExactKeys(item, ITEM_KEYS) || typeof item.text !== "string" ||
        item.text.length === 0 || !HEX_64.test(item.contentHash || "") ||
        sha256Text(item.text) !== item.contentHash) {
      fail("INVALID_ITEM", "request");
    }
    let identity;
    try {
      identity = createIdentity({
        userId: item.userId,
        memoryId: item.memoryId,
        contentHash: item.contentHash,
        model: EMBEDDING_CACHE_MODEL,
        revision: EMBEDDING_CACHE_REVISION
      });
    } catch (error) {
      if (error instanceof EmbeddingCacheRecordError) fail(error.code, "request");
      fail("INVALID_ITEM", "request");
    }
    if (logicalHashes.has(identity.logicalKeyHash)) {
      fail("DUPLICATE_LOGICAL_ITEM", "request");
    }
    logicalHashes.add(identity.logicalKeyHash);
    const pointId = createPointId(identity);
    const previousHash = pointIds.get(pointId);
    if (previousHash !== undefined && previousHash !== identity.logicalKeyHash) {
      fail("POINT_ID_COLLISION", "request");
    }
    pointIds.set(pointId, identity.logicalKeyHash);
    work.push({
      userId: item.userId,
      memoryId: item.memoryId,
      contentHash: item.contentHash,
      text: item.text,
      pointId,
      status: null
    });
  }
  work.sort((left, right) => left.pointId.localeCompare(right.pointId));
  return work;
}

function validateLookup(result, item) {
  const hit = hasExactKeys(result, LOOKUP_KEYS) && result.status === "hit" &&
    result.reasonCode === "CACHE_HIT";
  const miss = hasExactKeys(result, MISS_KEYS) && result.status === "miss" &&
    result.reasonCode === "POINT_NOT_FOUND";
  if ((!hit && !miss) || result.pointId !== item.pointId) {
    fail("INVALID_CACHE_RESPONSE", "cache");
  }
  if (hit) {
    try {
      validateEmbedding(result.embedding);
    } catch {
      fail("INVALID_CACHE_RESPONSE", "cache");
    }
  }
  return result.status;
}

function validateEmbeddingResponse(response, batch) {
  if (!Array.isArray(response) || response.length !== batch.length) {
    fail("EMBEDDING_RESPONSE_INCOMPLETE", "embedding");
  }
  const expected = new Map(batch.map((item) => [item.pointId, item]));
  const received = new Map();
  for (const result of response) {
    if (!hasExactKeys(result, RESPONSE_ITEM_KEYS) || typeof result.id !== "string" ||
        !HEX_64.test(result.contentHash || "") || !Array.isArray(result.embedding)) {
      fail("INVALID_EMBEDDING_RESPONSE", "embedding");
    }
    if (received.has(result.id)) fail("DUPLICATE_EMBEDDING_RESPONSE", "embedding");
    const item = expected.get(result.id);
    if (!item) fail("UNEXPECTED_EMBEDDING_RESPONSE", "embedding");
    if (result.contentHash !== item.contentHash) {
      fail("EMBEDDING_HASH_MISMATCH", "embedding");
    }
    try {
      validateEmbedding(result.embedding);
    } catch {
      fail("INVALID_EMBEDDING_VECTOR", "embedding");
    }
    received.set(result.id, result.embedding);
  }
  for (const item of batch) {
    if (!received.has(item.pointId)) fail("MISSING_EMBEDDING_RESPONSE", "embedding");
  }
  return received;
}

function validateUpsertResult(result, item) {
  if (!hasExactKeys(result, UPSERT_RESULT_KEYS) || result.pointId !== item.pointId ||
      typeof result.created !== "boolean" || typeof result.idempotentReplay !== "boolean" ||
      result.created === result.idempotentReplay) {
    fail("INVALID_CACHE_RESPONSE", "cache");
  }
  return result.created ? "created" : "replayed";
}

function lightweightIdentity(item) {
  return Object.freeze({
    memoryId: item.memoryId,
    contentHash: item.contentHash,
    pointId: item.pointId,
    model: EMBEDDING_CACHE_MODEL,
    revision: EMBEDDING_CACHE_REVISION,
    status: item.status
  });
}

class BgeM3EmbeddingCacheCoordinator {
  constructor(options) {
    validateOptions(options);
    this.cacheAdapter = options.cacheAdapter;
    this.embeddingProvider = options.embeddingProvider;
    this.embeddingBatchSize = options.embeddingBatchSize;
    Object.freeze(this);
  }

  async materialize(request) {
    const work = validatedWork(request);
    assertNotAborted(request.signal);
    const misses = [];
    let hitCount = 0;
    let createdCount = 0;
    let replayedCount = 0;
    let batches = 0;

    for (const item of work) {
      assertNotAborted(request.signal);
      const lookup = await callDependency(this.cacheAdapter, "getValidEmbedding", {
        userId: item.userId,
        memoryId: item.memoryId,
        contentHash: item.contentHash,
        model: EMBEDDING_CACHE_MODEL,
        revision: EMBEDDING_CACHE_REVISION,
        signal: request.signal
      }, "cache");
      if (validateLookup(lookup, item) === "hit") {
        item.status = "hit";
        item.userId = null;
        item.text = null;
        hitCount += 1;
      } else {
        misses.push(item);
      }
    }

    while (misses.length > 0) {
      assertNotAborted(request.signal);
      const batch = misses.splice(0, this.embeddingBatchSize);
      batches += 1;
      let response = await callDependency(this.embeddingProvider, "embedBatch", {
        items: batch.map((item) => ({ id: item.pointId, text: item.text })),
        signal: request.signal
      }, "embedding");
      const embeddings = validateEmbeddingResponse(response, batch);
      response = null;

      for (const item of batch) {
        assertNotAborted(request.signal);
        const embedding = embeddings.get(item.pointId);
        const upsert = await callDependency(this.cacheAdapter, "upsertEmbedding", {
          userId: item.userId,
          memoryId: item.memoryId,
          contentHash: item.contentHash,
          model: EMBEDDING_CACHE_MODEL,
          revision: EMBEDDING_CACHE_REVISION,
          embedding,
          signal: request.signal
        }, "cache");
        item.status = validateUpsertResult(upsert, item);
        if (item.status === "created") createdCount += 1;
        else replayedCount += 1;
        embeddings.delete(item.pointId);
        item.userId = null;
        item.text = null;
      }
    }

    const identities = Object.freeze(work.map(lightweightIdentity));
    return Object.freeze({
      total: work.length,
      hitCount,
      embeddedCount: createdCount + replayedCount,
      createdCount,
      replayedCount,
      batches,
      identities
    });
  }
}

function createBgeM3EmbeddingCacheCoordinator(options) {
  return new BgeM3EmbeddingCacheCoordinator(options);
}

module.exports = {
  MAX_MATERIALIZE_ITEMS,
  MIN_EMBEDDING_BATCH_SIZE,
  MAX_EMBEDDING_BATCH_SIZE,
  BgeM3EmbeddingCacheCoordinatorError,
  BgeM3EmbeddingCacheCoordinator,
  createBgeM3EmbeddingCacheCoordinator
};
