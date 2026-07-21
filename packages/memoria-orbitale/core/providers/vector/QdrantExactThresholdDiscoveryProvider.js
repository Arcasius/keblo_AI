"use strict";

const {
  DEFAULT_BOUNDED_CLUSTERING_POLICY,
  DISCOVERY_COMPLETENESS
} = require("../../clustering/HippocampusBoundedClusteringPlan");
const {
  THRESHOLD_DISCOVERY_CERTIFICATE_VERSION,
  THRESHOLD_DISCOVERY_MODE
} = require("../../clustering/HippocampusDiscoveryCompleteness");
const {
  EMBEDDING_CACHE_SCHEMA_VERSION,
  EMBEDDING_CACHE_COLLECTION,
  EMBEDDING_CACHE_MODEL,
  EMBEDDING_CACHE_REVISION,
  EMBEDDING_CACHE_NORMALIZED,
  createIdentity,
  createPointId
} = require("../../hippocampus/embedding-cache/EmbeddingCacheRecord");
const {
  isCurrentEmbeddingIdentityIndexForUser
} = require("../../hippocampus/embedding-cache/CurrentEmbeddingIdentityIndex");
const {
  QDRANT_PROVIDER_SCHEMA_VERSION,
  MIN_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  MIN_RESPONSE_BYTES,
  MAX_RESPONSE_BYTES
} = require("./QdrantEmbeddingCacheProvider");

const QDRANT_EXACT_DISCOVERY_PROVIDER_SCHEMA_VERSION = 1;
const MIN_MAX_HITS_PER_QUERY = 1;
const MAX_MAX_HITS_PER_QUERY = 4096;
const HEX_64 = /^[a-f0-9]{64}$/;
const UUID_V5 = /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

const OPTION_KEYS = Object.freeze([
  "identitySnapshotFingerprint", "maxHitsPerQuery", "maxResponseBytes",
  "qdrantProvider", "timeoutMs", "userId", "validIdentityIndex"
]);
const REQUEST_KEYS = Object.freeze([
  "clusterThreshold", "identitySnapshotFingerprint", "queryIdentity", "signal"
]);
const QUERY_IDENTITY_KEYS = Object.freeze([
  "contentHash", "memoryId", "model", "pointId", "revision"
]);
const PAYLOAD_KEYS = Object.freeze([
  "schema_version", "logical_key_hash", "user_id_hash", "memory_id",
  "content_hash", "embedding_model", "embedding_revision", "normalized",
  "vector_fingerprint"
]);

class QdrantExactThresholdDiscoveryProviderError extends Error {
  constructor(code, phase = "configuration") {
    super("Qdrant exact threshold discovery provider validation failed");
    this.name = "QdrantExactThresholdDiscoveryProviderError";
    this.code = code;
    this.phase = phase;
    this.retryable = false;
  }
}

function fail(code, phase) {
  throw new QdrantExactThresholdDiscoveryProviderError(code, phase);
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

function isAbortSignal(signal) {
  return signal && typeof signal === "object" &&
    typeof signal.aborted === "boolean" &&
    typeof signal.addEventListener === "function" &&
    typeof signal.removeEventListener === "function";
}

function deepFreeze(value) {
  Object.freeze(value);
  for (const child of Object.values(value)) {
    if (child && typeof child === "object" && !Object.isFrozen(child)) deepFreeze(child);
  }
  return value;
}

function failedResponse() {
  return deepFreeze({
    discoveryCompleteness: DISCOVERY_COMPLETENESS.FAILED,
    hits: []
  });
}

function exactFilter(userIdHash, queryPointId) {
  return {
    must: [
      { key: "schema_version", match: { value: EMBEDDING_CACHE_SCHEMA_VERSION } },
      { key: "user_id_hash", match: { value: userIdHash } },
      { key: "embedding_model", match: { value: EMBEDDING_CACHE_MODEL } },
      { key: "embedding_revision", match: { value: EMBEDDING_CACHE_REVISION } },
      { key: "normalized", match: { value: EMBEDDING_CACHE_NORMALIZED } }
    ],
    must_not: [{ has_id: [queryPointId] }]
  };
}

function assertOptions(options) {
  if (!hasExactKeys(options, OPTION_KEYS) ||
      typeof options.userId !== "string" || options.userId.trim().length === 0 ||
      !HEX_64.test(options.identitySnapshotFingerprint || "") ||
      !Number.isSafeInteger(options.maxHitsPerQuery) ||
      options.maxHitsPerQuery < MIN_MAX_HITS_PER_QUERY ||
      options.maxHitsPerQuery > MAX_MAX_HITS_PER_QUERY ||
      !Number.isInteger(options.timeoutMs) || options.timeoutMs < MIN_TIMEOUT_MS ||
      options.timeoutMs > MAX_TIMEOUT_MS ||
      !Number.isInteger(options.maxResponseBytes) ||
      options.maxResponseBytes < MIN_RESPONSE_BYTES ||
      options.maxResponseBytes > MAX_RESPONSE_BYTES ||
      !isCurrentEmbeddingIdentityIndexForUser(options.validIdentityIndex, options.userId) ||
      !isPlainObject(options.qdrantProvider) ||
      options.qdrantProvider.schemaVersion !== QDRANT_PROVIDER_SCHEMA_VERSION ||
      typeof options.qdrantProvider.providerId !== "string" ||
      typeof options.qdrantProvider.queryPoints !== "function" ||
      options.qdrantProvider.timeoutMs !== options.timeoutMs ||
      options.qdrantProvider.maxResponseBytes !== options.maxResponseBytes) {
    fail("INVALID_EXACT_DISCOVERY_CONFIGURATION");
  }
}

function assertRequest(request) {
  if (!hasExactKeys(request, REQUEST_KEYS) ||
      !hasExactKeys(request.queryIdentity, QUERY_IDENTITY_KEYS) ||
      !isAbortSignal(request.signal) ||
      !HEX_64.test(request.identitySnapshotFingerprint || "") ||
      request.clusterThreshold !== DEFAULT_BOUNDED_CLUSTERING_POLICY.clusterThreshold ||
      typeof request.queryIdentity.memoryId !== "string" ||
      request.queryIdentity.memoryId.trim().length === 0 ||
      !HEX_64.test(request.queryIdentity.contentHash || "") ||
      !UUID_V5.test(request.queryIdentity.pointId || "") ||
      request.queryIdentity.model !== EMBEDDING_CACHE_MODEL ||
      request.queryIdentity.revision !== EMBEDDING_CACHE_REVISION) {
    fail("INVALID_EXACT_DISCOVERY_REQUEST", "request");
  }
}

function validateHit(point, context) {
  if (!hasExactKeys(point, ["id", "payload", "score", "vector"]) ||
      typeof point.id !== "string" || !UUID_V5.test(point.id) ||
      point.vector !== null ||
      typeof point.score !== "number" || !Number.isFinite(point.score) ||
      point.score < context.clusterThreshold || point.score > 1 ||
      !hasExactKeys(point.payload, PAYLOAD_KEYS)) {
    return null;
  }
  const payload = point.payload;
  if (payload.schema_version !== EMBEDDING_CACHE_SCHEMA_VERSION ||
      !HEX_64.test(payload.logical_key_hash || "") ||
      !HEX_64.test(payload.user_id_hash || "") ||
      typeof payload.memory_id !== "string" || payload.memory_id.trim().length === 0 ||
      !HEX_64.test(payload.content_hash || "") ||
      payload.embedding_model !== EMBEDDING_CACHE_MODEL ||
      payload.embedding_revision !== EMBEDDING_CACHE_REVISION ||
      payload.normalized !== EMBEDDING_CACHE_NORMALIZED ||
      !HEX_64.test(payload.vector_fingerprint || "")) {
    return null;
  }
  const expected = context.validIdentityIndex.getExpected(payload.memory_id);
  if (!expected) return null;
  let identity;
  try {
    identity = createIdentity({
      userId: context.userId,
      memoryId: payload.memory_id,
      contentHash: expected.contentHash,
      model: expected.model,
      revision: expected.revision
    });
  } catch {
    return null;
  }
  if (point.id !== expected.pointId || point.id !== createPointId(identity) ||
      payload.logical_key_hash !== identity.logicalKeyHash ||
      payload.user_id_hash !== identity.userIdHash ||
      payload.memory_id !== identity.memoryId ||
      payload.content_hash !== identity.contentHash ||
      payload.embedding_model !== identity.model ||
      payload.embedding_revision !== identity.revision) {
    return null;
  }
  return {
    pointId: point.id,
    memoryId: identity.memoryId,
    contentHash: identity.contentHash,
    model: identity.model,
    revision: identity.revision,
    score: point.score
  };
}

function createQdrantExactThresholdDiscoveryProvider(options) {
  assertOptions(options);
  const config = {
    identitySnapshotFingerprint: options.identitySnapshotFingerprint,
    maxHitsPerQuery: options.maxHitsPerQuery,
    maxResponseBytes: options.maxResponseBytes,
    qdrantProvider: options.qdrantProvider,
    timeoutMs: options.timeoutMs,
    userId: options.userId,
    validIdentityIndex: options.validIdentityIndex
  };

  async function discoverNeighbors(request) {
    assertRequest(request);
    if (request.signal.aborted ||
        request.identitySnapshotFingerprint !== config.identitySnapshotFingerprint) {
      return failedResponse();
    }
    const expectedQuery = config.validIdentityIndex.getExpected(request.queryIdentity.memoryId);
    if (!expectedQuery ||
        expectedQuery.contentHash !== request.queryIdentity.contentHash ||
        expectedQuery.pointId !== request.queryIdentity.pointId ||
        expectedQuery.model !== request.queryIdentity.model ||
        expectedQuery.revision !== request.queryIdentity.revision) {
      return failedResponse();
    }
    let queryIdentity;
    try {
      queryIdentity = createIdentity({
        userId: config.userId,
        memoryId: request.queryIdentity.memoryId,
        contentHash: request.queryIdentity.contentHash,
        model: request.queryIdentity.model,
        revision: request.queryIdentity.revision
      });
    } catch {
      return failedResponse();
    }
    if (createPointId(queryIdentity) !== request.queryIdentity.pointId) {
      return failedResponse();
    }

    let result;
    try {
      result = await config.qdrantProvider.queryPoints({
        collection: EMBEDDING_CACHE_COLLECTION,
        queryPointId: request.queryIdentity.pointId,
        filter: exactFilter(queryIdentity.userIdHash, request.queryIdentity.pointId),
        exact: true,
        limit: config.maxHitsPerQuery + 1,
        withPayload: true,
        withVector: false,
        scoreThreshold: DEFAULT_BOUNDED_CLUSTERING_POLICY.clusterThreshold,
        signal: request.signal
      });
    } catch {
      return failedResponse();
    }
    if (!hasExactKeys(result, ["exact", "points"]) || result.exact !== true ||
        !Array.isArray(result.points) ||
        result.points.length > config.maxHitsPerQuery + 1) {
      return failedResponse();
    }

    const seenPointIds = new Set();
    const hits = [];
    for (const point of result.points) {
      if (point?.id === request.queryIdentity.pointId) continue;
      if (seenPointIds.has(point?.id)) return failedResponse();
      seenPointIds.add(point.id);
      const hit = validateHit(point, {
        clusterThreshold: request.clusterThreshold,
        userId: config.userId,
        validIdentityIndex: config.validIdentityIndex
      });
      if (!hit) return failedResponse();
      hits.push(hit);
    }
    hits.sort((left, right) =>
      left.pointId.localeCompare(right.pointId) ||
      right.score - left.score ||
      left.memoryId.localeCompare(right.memoryId));

    if (hits.length > config.maxHitsPerQuery) {
      return deepFreeze({
        discoveryCompleteness: DISCOVERY_COMPLETENESS.INCOMPLETE_TRUNCATED,
        hits: hits.slice(0, config.maxHitsPerQuery)
      });
    }
    const certificate = {
      certificateVersion: THRESHOLD_DISCOVERY_CERTIFICATE_VERSION,
      mode: THRESHOLD_DISCOVERY_MODE,
      identityIndexFingerprint: config.identitySnapshotFingerprint,
      queryPointId: request.queryIdentity.pointId,
      clusterThreshold: DEFAULT_BOUNDED_CLUSTERING_POLICY.clusterThreshold,
      embeddingModel: request.queryIdentity.model,
      embeddingRevision: request.queryIdentity.revision,
      eligibleIdentityCount: Math.max(0, config.validIdentityIndex.size - 1),
      enumeratedAboveThresholdCount: hits.length,
      exhausted: true,
      truncated: false,
      continuation: null
    };
    return deepFreeze({
      discoveryCompleteness: DISCOVERY_COMPLETENESS.COMPLETE_ABOVE_THRESHOLD,
      hits,
      certificate
    });
  }

  return deepFreeze({
    schemaVersion: QDRANT_EXACT_DISCOVERY_PROVIDER_SCHEMA_VERSION,
    providerId: "qdrant-exact-threshold-discovery-v1",
    maxHitsPerQuery: config.maxHitsPerQuery,
    timeoutMs: config.timeoutMs,
    maxResponseBytes: config.maxResponseBytes,
    discoverNeighbors
  });
}

module.exports = {
  QDRANT_EXACT_DISCOVERY_PROVIDER_SCHEMA_VERSION,
  MIN_MAX_HITS_PER_QUERY,
  MAX_MAX_HITS_PER_QUERY,
  QdrantExactThresholdDiscoveryProviderError,
  createQdrantExactThresholdDiscoveryProvider
};
