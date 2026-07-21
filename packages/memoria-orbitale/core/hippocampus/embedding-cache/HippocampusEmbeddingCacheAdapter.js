"use strict";

const {
  EMBEDDING_CACHE_SCHEMA_VERSION,
  EMBEDDING_CACHE_COLLECTION,
  EMBEDDING_CACHE_MODEL,
  EMBEDDING_CACHE_REVISION,
  EMBEDDING_CACHE_DIMENSION,
  EMBEDDING_CACHE_NORMALIZED,
  EmbeddingCacheRecordError,
  createIdentity,
  createPointId,
  validateEmbedding,
  createVectorFingerprint,
  createPayload,
  validatePayload
} = require("./EmbeddingCacheRecord");
const {
  isCurrentEmbeddingIdentityIndexForUser
} = require("./CurrentEmbeddingIdentityIndex");
const {
  QDRANT_PROVIDER_SCHEMA_VERSION
} = require("../../providers/vector/QdrantEmbeddingCacheProvider");

const EMBEDDING_CACHE_DISTANCE = "Cosine";
const CREATE_CONFIRMATION = "CREATE_HIPPOCAMPUS_EMBEDDING_CACHE_V1";
const PROVIDER_METHODS = Object.freeze([
  "health", "getCollectionInfo", "createCollection", "createPayloadIndex",
  "retrievePoints", "upsertPoints", "searchPoints", "scrollPayload"
]);
const FORBIDDEN_PROVIDER_METHODS = Object.freeze([
  "deleteCollection", "deletePoints", "clear", "recreate", "migrate",
  "rename", "cleanup"
]);
const PAYLOAD_INDEXES = Object.freeze({
  content_hash: "keyword",
  embedding_model: "keyword",
  embedding_revision: "keyword",
  logical_key_hash: "keyword",
  memory_id: "keyword",
  normalized: "bool",
  schema_version: "integer",
  user_id_hash: "keyword"
});
const PAYLOAD_INDEX_NAMES = Object.freeze(Object.keys(PAYLOAD_INDEXES).sort());
const REQUEST_KEYS = Object.freeze(["allowCreate", "confirmCreate", "signal"]);
const LOOKUP_REQUEST_KEYS = Object.freeze([
  "userId", "memoryId", "contentHash", "model", "revision", "signal"
]);
const UPSERT_REQUEST_KEYS = Object.freeze([
  "userId", "memoryId", "contentHash", "model", "revision", "embedding", "signal"
]);
const SEARCH_REQUEST_KEYS = Object.freeze([
  "userId", "queryIdentity", "validIdentityIndex", "scoreThreshold", "limit", "signal"
]);
const QUERY_IDENTITY_KEYS = Object.freeze([
  "memoryId", "contentHash", "model", "revision"
]);
const CACHE_PAYLOAD_KEYS = Object.freeze([
  "schema_version", "logical_key_hash", "user_id_hash", "memory_id",
  "content_hash", "embedding_model", "embedding_revision", "normalized",
  "vector_fingerprint"
]);
const INFORMATION_KEYS = Object.freeze([
  "exists", "collectionStatus", "config", "payloadSchema"
]);
const RETRYABLE_PROVIDER_CODES = new Set([
  "QDRANT_TIMEOUT", "CONNECTION_REFUSED", "CONNECTION_RESET",
  "QDRANT_UNAVAILABLE", "HTTP_RETRYABLE"
]);
const MAX_NEIGHBOR_LIMIT = 1000;
const NEIGHBOR_OVERFETCH_FACTOR = 4;
const MAX_NEIGHBOR_SEARCH_RESULTS = MAX_NEIGHBOR_LIMIT * NEIGHBOR_OVERFETCH_FACTOR;
const HEX_64 = /^[a-f0-9]{64}$/;

class HippocampusEmbeddingCacheAdapterError extends Error {
  constructor(code, phase, retryable, details = {}) {
    super("Hippocampus embedding cache adapter operation failed");
    this.name = "HippocampusEmbeddingCacheAdapterError";
    this.code = code;
    this.phase = phase;
    this.retryable = retryable;
    if (Number.isInteger(details.status)) this.status = details.status;
  }
}

function fail(code, phase, retryable = false, details) {
  throw new HippocampusEmbeddingCacheAdapterError(code, phase, retryable, details);
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

function hasOnlyKeys(value, allowed, required) {
  return isPlainObject(value) &&
    Object.keys(value).every((key) => allowed.includes(key)) &&
    required.every((key) => Object.hasOwn(value, key));
}

function assertSignal(signal) {
  if (!signal || typeof signal.aborted !== "boolean" ||
      typeof signal.addEventListener !== "function") {
    fail("INVALID_REQUEST", "request");
  }
}

function validateProvider(provider) {
  if (!isPlainObject(provider) ||
      provider.schemaVersion !== QDRANT_PROVIDER_SCHEMA_VERSION ||
      typeof provider.providerId !== "string" || provider.providerId.length === 0 ||
      PROVIDER_METHODS.some((method) => typeof provider[method] !== "function") ||
      FORBIDDEN_PROVIDER_METHODS.some((method) => typeof provider[method] === "function")) {
    fail("INVALID_PROVIDER", "configuration");
  }
}

function validateRequest(request) {
  if (!hasOnlyKeys(request, REQUEST_KEYS, ["signal"]) ||
      Object.hasOwn(request, "allowCreate") && typeof request.allowCreate !== "boolean" ||
      Object.hasOwn(request, "confirmCreate") && typeof request.confirmCreate !== "string") {
    fail("INVALID_REQUEST", "request");
  }
  assertSignal(request.signal);
  const allowCreate = request.allowCreate === true;
  if (allowCreate && request.confirmCreate !== CREATE_CONFIRMATION) {
    fail("INVALID_CREATE_CONFIRMATION", "authorization");
  }
  return allowCreate;
}

function assertOperationResult(result) {
  if (!hasExactKeys(result, ["acknowledged", "operationId", "status"]) ||
      result.acknowledged !== true ||
      result.operationId !== null && !Number.isSafeInteger(result.operationId) ||
      result.status !== null && typeof result.status !== "string") {
    fail("INVALID_PROVIDER_RESPONSE", "provider");
  }
}

function assertUpsertAcknowledgement(result) {
  if (!hasExactKeys(result, ["acknowledged", "operationId", "status"]) ||
      result.acknowledged !== true ||
      result.operationId !== null && !Number.isSafeInteger(result.operationId) ||
      result.status !== null && typeof result.status !== "string") {
    fail("UPSERT_ACKNOWLEDGEMENT_INVALID", "upsert", true);
  }
}

function classifyProviderError(error, phase) {
  if (error instanceof HippocampusEmbeddingCacheAdapterError) throw error;
  const status = Number.isInteger(error?.status) ? error.status : undefined;
  const code = typeof error?.code === "string" && /^[A-Z][A-Z0-9_]*$/.test(error.code)
    ? error.code
    : "PROVIDER_FAILURE";
  const retryable = error?.retryable === true && RETRYABLE_PROVIDER_CODES.has(code);
  throw new HippocampusEmbeddingCacheAdapterError(code, phase, retryable, { status });
}

async function callProvider(provider, method, request, phase) {
  try {
    return await provider[method](request);
  } catch (error) {
    classifyProviderError(error, phase);
  }
}

function collectionIncompatible() {
  fail("COLLECTION_INCOMPATIBLE", "contract");
}

function recordFailure(error, payload, identity) {
  if (!(error instanceof EmbeddingCacheRecordError)) throw error;
  if (error.category === "conflict" && isPlainObject(payload) &&
      (payload.logical_key_hash !== identity.logicalKeyHash ||
       payload.user_id_hash !== identity.userIdHash ||
       payload.memory_id !== identity.memoryId ||
       payload.content_hash !== identity.contentHash ||
       payload.embedding_model !== identity.model ||
       payload.embedding_revision !== identity.revision)) {
    fail("POINT_IDENTITY_CONFLICT", "retrieve");
  }
  fail("CACHE_RECORD_INVALID", "retrieve");
}

function validateSearchPayload(payload, vector) {
  if (!hasExactKeys(payload, CACHE_PAYLOAD_KEYS) ||
      payload.schema_version !== EMBEDDING_CACHE_SCHEMA_VERSION ||
      !HEX_64.test(payload.logical_key_hash || "") ||
      !HEX_64.test(payload.user_id_hash || "") ||
      typeof payload.memory_id !== "string" || payload.memory_id.trim().length === 0 ||
      !HEX_64.test(payload.content_hash || "") ||
      typeof payload.embedding_model !== "string" || payload.embedding_model.length === 0 ||
      typeof payload.embedding_revision !== "string" || payload.embedding_revision.length === 0 ||
      payload.normalized !== EMBEDDING_CACHE_NORMALIZED ||
      !HEX_64.test(payload.vector_fingerprint || "") ||
      payload.vector_fingerprint !== createVectorFingerprint(vector)) {
    fail("CACHE_RECORD_INVALID", "search");
  }
}

function searchFilter(userIdHash) {
  return {
    must: [
      { key: "schema_version", match: { value: EMBEDDING_CACHE_SCHEMA_VERSION } },
      { key: "user_id_hash", match: { value: userIdHash } },
      { key: "embedding_model", match: { value: EMBEDDING_CACHE_MODEL } },
      { key: "embedding_revision", match: { value: EMBEDDING_CACHE_REVISION } },
      { key: "normalized", match: { value: EMBEDDING_CACHE_NORMALIZED } }
    ]
  };
}

function validateCurrentSearchRecord(point, payload, vector, identity) {
  if (point.id !== createPointId(identity)) {
    fail("POINT_IDENTITY_CONFLICT", "search");
  }
  try {
    validatePayload(payload, identity, vector);
  } catch (error) {
    if (error instanceof EmbeddingCacheRecordError && error.category === "conflict") {
      fail("POINT_IDENTITY_CONFLICT", "search");
    }
    fail("CACHE_RECORD_INVALID", "search");
  }
}

function validateVectors(vectors) {
  if (!isPlainObject(vectors) ||
      !Object.hasOwn(vectors, "size") || !Object.hasOwn(vectors, "distance")) {
    collectionIncompatible();
  }
  const allowed = ["size", "distance", "on_disk", "datatype"];
  if (Object.keys(vectors).some((key) => !allowed.includes(key)) ||
      vectors.size !== EMBEDDING_CACHE_DIMENSION ||
      vectors.distance !== EMBEDDING_CACHE_DISTANCE ||
      Object.hasOwn(vectors, "on_disk") && typeof vectors.on_disk !== "boolean" ||
      Object.hasOwn(vectors, "datatype") &&
        vectors.datatype !== "Float32" && vectors.datatype !== "float32") {
    collectionIncompatible();
  }
}

function inspectCollectionInfo(info) {
  if (hasExactKeys(info, ["exists"]) && info.exists === false) {
    return { exists: false, missingPayloadIndexes: [...PAYLOAD_INDEX_NAMES] };
  }
  if (!hasExactKeys(info, INFORMATION_KEYS) || info.exists !== true ||
      typeof info.collectionStatus !== "string" ||
      !isPlainObject(info.config) || !isPlainObject(info.config.params) ||
      !isPlainObject(info.payloadSchema)) {
    collectionIncompatible();
  }
  validateVectors(info.config.params.vectors);

  if (Object.hasOwn(info.payloadSchema, "vector_fingerprint")) collectionIncompatible();
  const missingPayloadIndexes = [];
  for (const name of PAYLOAD_INDEX_NAMES) {
    if (!Object.hasOwn(info.payloadSchema, name)) {
      missingPayloadIndexes.push(name);
      continue;
    }
    const definition = info.payloadSchema[name];
    if (!isPlainObject(definition) || definition.data_type !== PAYLOAD_INDEXES[name]) {
      collectionIncompatible();
    }
  }
  return { exists: true, missingPayloadIndexes };
}

function lifecycleResult({ ready, created, missingPayloadIndexes, reasonCode }) {
  return Object.freeze({
    ready,
    created,
    collection: EMBEDDING_CACHE_COLLECTION,
    dimension: EMBEDDING_CACHE_DIMENSION,
    distance: EMBEDDING_CACHE_DISTANCE,
    payloadIndexesReady: missingPayloadIndexes.length === 0,
    missingPayloadIndexes: Object.freeze([...missingPayloadIndexes]),
    reasonCode
  });
}

function isConflict(error) {
  return Number.isInteger(error?.status) && error.status === 409;
}

function createHippocampusEmbeddingCacheAdapter(options) {
  if (!hasExactKeys(options, ["provider"])) fail("INVALID_ADAPTER_OPTIONS", "configuration");
  const provider = options.provider;
  validateProvider(provider);

  async function readInspection(signal) {
    const info = await callProvider(provider, "getCollectionInfo", {
      collection: EMBEDDING_CACHE_COLLECTION,
      signal
    }, "inspect");
    return inspectCollectionInfo(info);
  }

  async function createIndex(name, signal) {
    try {
      const result = await provider.createPayloadIndex({
        collection: EMBEDDING_CACHE_COLLECTION,
        fieldName: name,
        fieldSchema: PAYLOAD_INDEXES[name],
        signal
      });
      assertOperationResult(result);
    } catch (error) {
      if (!isConflict(error)) classifyProviderError(error, "index");
      const concurrent = await readInspection(signal);
      if (!concurrent.exists || concurrent.missingPayloadIndexes.includes(name)) {
        collectionIncompatible();
      }
    }
  }

  async function ensureCollection(request) {
    const allowCreate = validateRequest(request);
    let inspection = await readInspection(request.signal);
    let created = false;

    if (!inspection.exists) {
      if (!allowCreate) {
        return lifecycleResult({
          ready: false,
          created: false,
          missingPayloadIndexes: inspection.missingPayloadIndexes,
          reasonCode: "COLLECTION_NOT_FOUND"
        });
      }
      try {
        const result = await provider.createCollection({
          collection: EMBEDDING_CACHE_COLLECTION,
          configuration: {
            vectors: { size: EMBEDDING_CACHE_DIMENSION, distance: EMBEDDING_CACHE_DISTANCE }
          },
          signal: request.signal
        });
        assertOperationResult(result);
        created = true;
      } catch (error) {
        if (!isConflict(error)) classifyProviderError(error, "create");
      }
      inspection = await readInspection(request.signal);
      if (!inspection.exists) fail("COLLECTION_POSTCONDITION_FAILED", "contract");
    }

    if (inspection.missingPayloadIndexes.length > 0) {
      if (!allowCreate) {
        return lifecycleResult({
          ready: false,
          created: false,
          missingPayloadIndexes: inspection.missingPayloadIndexes,
          reasonCode: "PAYLOAD_INDEXES_MISSING"
        });
      }
      for (const name of inspection.missingPayloadIndexes) {
        await createIndex(name, request.signal);
      }
    }

    const verified = allowCreate
      ? await readInspection(request.signal)
      : inspection;
    if (!verified.exists || verified.missingPayloadIndexes.length > 0) {
      fail("COLLECTION_POSTCONDITION_FAILED", "contract");
    }
    return lifecycleResult({
      ready: true,
      created,
      missingPayloadIndexes: [],
      reasonCode: null
    });
  }

  async function assertCollectionReady(signal) {
    const lifecycle = await ensureCollection({ allowCreate: false, signal });
    if (!lifecycle.ready) fail("COLLECTION_NOT_READY", "collection");
  }

  function identityFromRequest(request, expectedKeys) {
    if (!hasExactKeys(request, expectedKeys)) fail("INVALID_REQUEST", "request");
    assertSignal(request.signal);
    try {
      return createIdentity({
        userId: request.userId,
        memoryId: request.memoryId,
        contentHash: request.contentHash,
        model: request.model,
        revision: request.revision
      });
    } catch (error) {
      if (error instanceof EmbeddingCacheRecordError) {
        fail(error.code, "request");
      }
      throw error;
    }
  }

  async function getValidEmbedding(request) {
    const identity = identityFromRequest(request, LOOKUP_REQUEST_KEYS);
    const pointId = createPointId(identity);
    await assertCollectionReady(request.signal);
    const result = await callProvider(provider, "retrievePoints", {
      collection: EMBEDDING_CACHE_COLLECTION,
      pointIds: [pointId],
      withPayload: true,
      withVector: true,
      signal: request.signal
    }, "retrieve");
    if (!hasExactKeys(result, ["points"]) || !Array.isArray(result.points)) {
      fail("CACHE_RECORD_INVALID", "retrieve");
    }
    if (result.points.length === 0) {
      return Object.freeze({ status: "miss", reasonCode: "POINT_NOT_FOUND", pointId });
    }
    if (result.points.length !== 1 ||
        !hasExactKeys(result.points[0], ["id", "payload", "vector"])) {
      fail("CACHE_RECORD_INVALID", "retrieve");
    }
    const point = result.points[0];
    if (point.id !== pointId) fail("POINT_IDENTITY_CONFLICT", "retrieve");
    let embedding;
    try {
      embedding = validateEmbedding(point.vector);
      validatePayload(point.payload, identity, embedding);
    } catch (error) {
      recordFailure(error, point.payload, identity);
    }
    return Object.freeze({
      status: "hit",
      reasonCode: "CACHE_HIT",
      pointId,
      embedding
    });
  }

  async function upsertEmbedding(request) {
    const identity = identityFromRequest(request, UPSERT_REQUEST_KEYS);
    let embedding;
    let payload;
    let fingerprint;
    try {
      embedding = validateEmbedding(request.embedding);
      fingerprint = createVectorFingerprint(embedding);
      payload = createPayload(identity, embedding);
    } catch (error) {
      if (error instanceof EmbeddingCacheRecordError) {
        fail(error.code, "request");
      }
      throw error;
    }
    const pointId = createPointId(identity);
    const lookupRequest = {
      userId: request.userId,
      memoryId: request.memoryId,
      contentHash: request.contentHash,
      model: request.model,
      revision: request.revision,
      signal: request.signal
    };
    const existing = await getValidEmbedding(lookupRequest);
    if (existing.status === "hit") {
      if (createVectorFingerprint(existing.embedding) !== fingerprint) {
        fail("POINT_IDENTITY_CONFLICT", "upsert");
      }
      return Object.freeze({ pointId, created: false, idempotentReplay: true });
    }

    await assertCollectionReady(request.signal);
    const acknowledgement = await callProvider(provider, "upsertPoints", {
      collection: EMBEDDING_CACHE_COLLECTION,
      points: [{ id: pointId, vector: embedding, payload }],
      signal: request.signal
    }, "upsert");
    assertUpsertAcknowledgement(acknowledgement);

    let verified;
    try {
      verified = await getValidEmbedding(lookupRequest);
    } catch (error) {
      if (error instanceof HippocampusEmbeddingCacheAdapterError && error.retryable) throw error;
      fail("UPSERT_VERIFICATION_FAILED", "verify");
    }
    if (verified.status !== "hit" ||
        createVectorFingerprint(verified.embedding) !== fingerprint) {
      fail("UPSERT_VERIFICATION_FAILED", "verify", verified.status === "miss");
    }
    return Object.freeze({ pointId, created: true, idempotentReplay: false });
  }

  async function searchNeighbors(request) {
    if (!hasExactKeys(request, SEARCH_REQUEST_KEYS) ||
        !hasExactKeys(request.queryIdentity, QUERY_IDENTITY_KEYS) ||
        !Number.isInteger(request.limit) || request.limit <= 0 ||
        request.limit > MAX_NEIGHBOR_LIMIT ||
        typeof request.scoreThreshold !== "number" ||
        !Number.isFinite(request.scoreThreshold) ||
        request.scoreThreshold < -1 || request.scoreThreshold > 1) {
      fail("INVALID_REQUEST", "request");
    }
    assertSignal(request.signal);
    if (request.signal.aborted) fail("QDRANT_ABORTED", "search");
    if (!isCurrentEmbeddingIdentityIndexForUser(request.validIdentityIndex, request.userId)) {
      fail("INVALID_IDENTITY_INDEX", "request");
    }

    let queryIdentity;
    try {
      queryIdentity = createIdentity({
        userId: request.userId,
        memoryId: request.queryIdentity.memoryId,
        contentHash: request.queryIdentity.contentHash,
        model: request.queryIdentity.model,
        revision: request.queryIdentity.revision
      });
    } catch (error) {
      if (error instanceof EmbeddingCacheRecordError) fail(error.code, "request");
      fail("INVALID_REQUEST", "request");
    }
    const queryPointId = createPointId(queryIdentity);
    const expectedQuery = request.validIdentityIndex.getExpected(queryIdentity.memoryId);
    if (!expectedQuery || expectedQuery.contentHash !== queryIdentity.contentHash ||
        expectedQuery.model !== queryIdentity.model ||
        expectedQuery.revision !== queryIdentity.revision ||
        expectedQuery.pointId !== queryPointId) {
      fail("QUERY_IDENTITY_NOT_CURRENT", "request");
    }

    let lookup = await getValidEmbedding({
      userId: request.userId,
      memoryId: queryIdentity.memoryId,
      contentHash: queryIdentity.contentHash,
      model: queryIdentity.model,
      revision: queryIdentity.revision,
      signal: request.signal
    });
    if (lookup.status !== "hit") fail("POINT_NOT_FOUND", "search");
    let queryVector = lookup.embedding;
    lookup = null;
    const providerLimit = Math.min(
      request.limit * NEIGHBOR_OVERFETCH_FACTOR,
      MAX_NEIGHBOR_SEARCH_RESULTS
    );
    const result = await callProvider(provider, "searchPoints", {
      collection: EMBEDDING_CACHE_COLLECTION,
      vector: queryVector,
      filter: searchFilter(queryIdentity.userIdHash),
      limit: providerLimit,
      withPayload: true,
      withVector: true,
      scoreThreshold: request.scoreThreshold,
      signal: request.signal
    }, "search");
    queryVector = null;

    if (!hasExactKeys(result, ["points"]) || !Array.isArray(result.points) ||
        result.points.length > providerLimit) {
      fail("INVALID_PROVIDER_RESPONSE", "search");
    }
    const seenPointIds = new Set();
    const neighbors = [];
    let discardedStaleCount = 0;
    for (const point of result.points) {
      if (!hasExactKeys(point, ["id", "vector", "payload", "score"]) ||
          typeof point.id !== "string" || point.id.length === 0 ||
          typeof point.score !== "number" || !Number.isFinite(point.score)) {
        fail("INVALID_PROVIDER_RESPONSE", "search");
      }
      if (seenPointIds.has(point.id)) fail("DUPLICATE_NEIGHBOR_POINT", "search");
      seenPointIds.add(point.id);
      let vector;
      try {
        vector = validateEmbedding(point.vector);
        validateSearchPayload(point.payload, vector);
      } catch (error) {
        if (error instanceof HippocampusEmbeddingCacheAdapterError) throw error;
        fail("CACHE_RECORD_INVALID", "search");
      }
      const payload = point.payload;
      const expected = request.validIdentityIndex.getExpected(payload.memory_id);
      const expectedIdentity = expected ? createIdentity({
        userId: request.userId,
        memoryId: payload.memory_id,
        contentHash: expected.contentHash,
        model: expected.model,
        revision: expected.revision
      }) : null;
      const belongsToCurrentUser = payload.user_id_hash === queryIdentity.userIdHash;
      const hasCurrentProvenance = payload.embedding_model === EMBEDDING_CACHE_MODEL &&
        payload.embedding_revision === EMBEDDING_CACHE_REVISION;

      if (!expected || !belongsToCurrentUser || !hasCurrentProvenance) {
        if (expected && (point.id === expected.pointId ||
            payload.logical_key_hash === expectedIdentity.logicalKeyHash)) {
          fail("POINT_IDENTITY_CONFLICT", "search");
        }
        if (!expected && belongsToCurrentUser && hasCurrentProvenance) {
          let staleIdentity;
          try {
            staleIdentity = createIdentity({
              userId: request.userId,
              memoryId: payload.memory_id,
              contentHash: payload.content_hash,
              model: payload.embedding_model,
              revision: payload.embedding_revision
            });
          } catch {
            fail("CACHE_RECORD_INVALID", "search");
          }
          validateCurrentSearchRecord(point, payload, vector, staleIdentity);
        }
        discardedStaleCount += 1;
        continue;
      }

      const currentIdentity = expectedIdentity;
      const payloadClaimsCurrent = payload.content_hash === expected.contentHash &&
        payload.embedding_model === expected.model &&
        payload.embedding_revision === expected.revision;
      if (!payloadClaimsCurrent) {
        if (point.id === expected.pointId ||
            payload.logical_key_hash === currentIdentity.logicalKeyHash) {
          fail("POINT_IDENTITY_CONFLICT", "search");
        }
        let staleIdentity;
        try {
          staleIdentity = createIdentity({
            userId: request.userId,
            memoryId: payload.memory_id,
            contentHash: payload.content_hash,
            model: payload.embedding_model,
            revision: payload.embedding_revision
          });
        } catch {
          fail("CACHE_RECORD_INVALID", "search");
        }
        validateCurrentSearchRecord(point, payload, vector, staleIdentity);
        discardedStaleCount += 1;
        continue;
      }
      validateCurrentSearchRecord(point, payload, vector, currentIdentity);
      if (point.id === queryPointId) {
        discardedStaleCount += 1;
        continue;
      }
      neighbors.push({
        memoryId: payload.memory_id,
        pointId: point.id,
        score: point.score
      });
    }

    neighbors.sort((left, right) =>
      right.score - left.score ||
      left.memoryId.localeCompare(right.memoryId) ||
      left.pointId.localeCompare(right.pointId));
    const truncated = result.points.length === providerLimit ||
      discardedStaleCount > 0 || neighbors.length > request.limit;
    const boundedNeighbors = Object.freeze(neighbors.slice(0, request.limit)
      .map((neighbor) => Object.freeze(neighbor)));
    return Object.freeze({
      queryPointId,
      neighbors: boundedNeighbors,
      discardedStaleCount,
      truncated
    });
  }

  const adapter = {
    schemaVersion: EMBEDDING_CACHE_SCHEMA_VERSION,
    ensureCollection
  };
  Object.defineProperties(adapter, {
    getValidEmbedding: { value: getValidEmbedding, enumerable: false },
    upsertEmbedding: { value: upsertEmbedding, enumerable: false },
    searchNeighbors: { value: searchNeighbors, enumerable: false }
  });
  return Object.freeze(adapter);
}

module.exports = {
  EMBEDDING_CACHE_DISTANCE,
  CREATE_CONFIRMATION,
  PAYLOAD_INDEXES,
  MAX_NEIGHBOR_LIMIT,
  NEIGHBOR_OVERFETCH_FACTOR,
  MAX_NEIGHBOR_SEARCH_RESULTS,
  HippocampusEmbeddingCacheAdapterError,
  createHippocampusEmbeddingCacheAdapter
};
