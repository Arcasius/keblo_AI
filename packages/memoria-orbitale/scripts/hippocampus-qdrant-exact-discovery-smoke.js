#!/usr/bin/env node
"use strict";

const {
  DEFAULT_BOUNDED_CLUSTERING_POLICY,
  DISCOVERY_COMPLETENESS,
  createGlobalIdentitySnapshot
} = require("../core/clustering/HippocampusBoundedClusteringPlan");
const {
  evaluateThresholdDiscoveryCertificate
} = require("../core/clustering/HippocampusDiscoveryCompleteness");
const {
  EMBEDDING_CACHE_SCHEMA_VERSION,
  EMBEDDING_CACHE_COLLECTION,
  EMBEDDING_CACHE_MODEL,
  EMBEDDING_CACHE_REVISION,
  EMBEDDING_CACHE_NORMALIZED,
  createIdentity,
  createPointId
} = require("../core/hippocampus/embedding-cache/EmbeddingCacheRecord");
const {
  createCurrentEmbeddingIdentityIndex
} = require("../core/hippocampus/embedding-cache/CurrentEmbeddingIdentityIndex");
const {
  createQdrantEmbeddingCacheProvider
} = require("../core/providers/vector/QdrantEmbeddingCacheProvider");
const {
  createQdrantExactThresholdDiscoveryProvider
} = require("../core/providers/vector/QdrantExactThresholdDiscoveryProvider");
const {
  SYNTHETIC_USER_ID,
  syntheticItems
} = require("./hippocampus-embedding-cache-synthetic-smoke");
const {
  QDRANT_TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
  qdrantConfiguration,
  isPrivateQdrantEndpoint
} = require("./provision-hippocampus-embedding-cache");

const MAX_HITS_PER_QUERY = 5;

function baseResult() {
  return {
    collection: EMBEDDING_CACHE_COLLECTION,
    syntheticPoints: 6,
    maxHitsPerQuery: MAX_HITS_PER_QUERY,
    requestedLimit: MAX_HITS_PER_QUERY + 1,
    scoreThreshold: DEFAULT_BOUNDED_CLUSTERING_POLICY.clusterThreshold,
    exactQuery: false,
    certificateValid: false,
    writes: 0,
    realDataRead: false,
    daemonQwenSuperMemoryCommit: "none"
  };
}

function currentItems() {
  return syntheticItems().map((item) => ({
    memoryId: item.memoryId,
    contentHash: item.contentHash,
    model: EMBEDDING_CACHE_MODEL,
    revision: EMBEDDING_CACHE_REVISION
  }));
}

function identityFor(item) {
  return createIdentity({ userId: SYNTHETIC_USER_ID, ...item });
}

function snapshotFor(items) {
  const first = identityFor(items[0]);
  return createGlobalIdentitySnapshot({
    userIdHash: first.userIdHash,
    identities: items.map((item) => ({
      ...item,
      pointId: createPointId(identityFor(item))
    }))
  });
}

function filterFor(userIdHash) {
  return { must: [
    { key: "schema_version", match: { value: EMBEDDING_CACHE_SCHEMA_VERSION } },
    { key: "user_id_hash", match: { value: userIdHash } },
    { key: "embedding_model", match: { value: EMBEDDING_CACHE_MODEL } },
    { key: "embedding_revision", match: { value: EMBEDDING_CACHE_REVISION } },
    { key: "normalized", match: { value: EMBEDDING_CACHE_NORMALIZED } }
  ] };
}

function errorCode(error) {
  return typeof error?.code === "string" && /^[A-Z][A-Z0-9_]*$/.test(error.code)
    ? error.code
    : "EXACT_DISCOVERY_SMOKE_FAILURE";
}

async function runExactDiscoverySmoke(options = {}) {
  const base = baseResult();
  const config = qdrantConfiguration(options.env || {});
  if (!config) return { status: "DEFERRED_INVALID_CONFIGURATION", ...base };
  if (config.apiKey === undefined && !isPrivateQdrantEndpoint(config.endpoint)) {
    return { status: "DEFERRED_PUBLIC_ENDPOINT_WITHOUT_AUTH", ...base };
  }
  const items = currentItems();
  const validIdentityIndex = createCurrentEmbeddingIdentityIndex({
    userId: SYNTHETIC_USER_ID,
    items
  });
  const identitySnapshot = snapshotFor(items);
  const expectedPointIds = new Set(items.map((item) => createPointId(identityFor(item))));
  const rawQdrant = options.qdrantProvider ||
    (options.qdrantProviderFactory || createQdrantEmbeddingCacheProvider)({
      endpoint: config.endpoint,
      apiKey: config.apiKey,
      timeoutMs: QDRANT_TIMEOUT_MS,
      maxResponseBytes: MAX_RESPONSE_BYTES,
      providerId: "hippocampus-qdrant-exact-discovery-smoke"
    });
  let capturedRequest = null;
  const exactTransport = Object.freeze({
    schemaVersion: rawQdrant.schemaVersion,
    providerId: rawQdrant.providerId,
    timeoutMs: rawQdrant.timeoutMs,
    maxResponseBytes: rawQdrant.maxResponseBytes,
    async queryPoints(request) {
      capturedRequest = {
        exact: request.exact,
        limit: request.limit,
        scoreThreshold: request.scoreThreshold,
        withPayload: request.withPayload,
        withVector: request.withVector
      };
      return rawQdrant.queryPoints(request);
    }
  });
  try {
    const firstIdentity = identityFor(items[0]);
    const scrolled = await rawQdrant.scrollPayload({
      collection: EMBEDDING_CACHE_COLLECTION,
      filter: filterFor(firstIdentity.userIdHash),
      limit: items.length + 1,
      offset: null,
      withPayload: false,
      withVector: false,
      signal: new AbortController().signal
    });
    if (scrolled.points.length !== items.length || scrolled.nextPageOffset !== null ||
        scrolled.points.some((point) => !expectedPointIds.has(point.id))) {
      return {
        status: "BLOCKED_SYNTHETIC_POINT_SET_MISMATCH",
        ...base,
        observedSyntheticPoints: scrolled.points.length
      };
    }
    const provider = createQdrantExactThresholdDiscoveryProvider({
      qdrantProvider: exactTransport,
      userId: SYNTHETIC_USER_ID,
      validIdentityIndex,
      identitySnapshotFingerprint: identitySnapshot.snapshotFingerprint,
      maxHitsPerQuery: MAX_HITS_PER_QUERY,
      timeoutMs: QDRANT_TIMEOUT_MS,
      maxResponseBytes: MAX_RESPONSE_BYTES
    });
    const query = items.find((item) => item.memoryId === "orbit-a");
    const queryPointId = createPointId(identityFor(query));
    const result = await provider.discoverNeighbors({
      queryIdentity: { ...query, pointId: queryPointId },
      identitySnapshotFingerprint: identitySnapshot.snapshotFingerprint,
      clusterThreshold: DEFAULT_BOUNDED_CLUSTERING_POLICY.clusterThreshold,
      signal: new AbortController().signal
    });
    if (result.discoveryCompleteness !==
        DISCOVERY_COMPLETENESS.COMPLETE_ABOVE_THRESHOLD ||
        !result.certificate) {
      return {
        status: "BLOCKED_EXACT_DISCOVERY_INCOMPLETE",
        ...base,
        exactQuery: capturedRequest?.exact === true,
        observedHitCount: result.hits.length
      };
    }
    const evaluation = evaluateThresholdDiscoveryCertificate({
      identitySnapshot,
      queryPointId,
      providerCompleteness: result.discoveryCompleteness,
      certificate: result.certificate,
      observedAboveThresholdCount: result.hits.length
    });
    const certificateValid = evaluation.discoveryCompleteness ===
      DISCOVERY_COMPLETENESS.COMPLETE_ABOVE_THRESHOLD;
    const requestValid = capturedRequest?.exact === true &&
      capturedRequest.limit === MAX_HITS_PER_QUERY + 1 &&
      capturedRequest.scoreThreshold ===
        DEFAULT_BOUNDED_CLUSTERING_POLICY.clusterThreshold &&
      capturedRequest.withPayload === true &&
      capturedRequest.withVector === false;
    return {
      status: certificateValid && requestValid ? "PASS" : "BLOCKED_EXACT_REQUEST_INVALID",
      ...base,
      exactQuery: capturedRequest?.exact === true,
      certificateValid,
      observedHitCount: result.hits.length,
      writes: 0
    };
  } catch (error) {
    return {
      status: "FAIL",
      ...base,
      errorCode: errorCode(error),
      retryable: error?.retryable === true
    };
  }
}

if (require.main === module) {
  runExactDiscoverySmoke({ env: process.env }).then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.status === "FAIL" || result.status.startsWith("BLOCKED_")) {
      process.exitCode = 1;
    }
  }).catch(() => {
    process.stdout.write(`${JSON.stringify({
      status: "FAIL",
      ...baseResult(),
      errorCode: "EXACT_DISCOVERY_SMOKE_FAILURE"
    })}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  MAX_HITS_PER_QUERY,
  currentItems,
  snapshotFor,
  runExactDiscoverySmoke
};
