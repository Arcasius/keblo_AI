#!/usr/bin/env node
"use strict";

const { createHash } = require("node:crypto");
const {
  EMBEDDING_CACHE_SCHEMA_VERSION,
  EMBEDDING_CACHE_COLLECTION,
  EMBEDDING_CACHE_MODEL,
  EMBEDDING_CACHE_REVISION,
  EMBEDDING_CACHE_DIMENSION,
  createIdentity,
  createPointId,
  validatePayload
} = require("../core/hippocampus/embedding-cache/EmbeddingCacheRecord");
const {
  createQdrantEmbeddingCacheProvider
} = require("../core/providers/vector/QdrantEmbeddingCacheProvider");
const {
  createHippocampusEmbeddingCacheAdapter
} = require("../core/hippocampus/embedding-cache/HippocampusEmbeddingCacheAdapter");
const {
  createBgeM3EmbeddingCacheCoordinator
} = require("../core/hippocampus/embedding-cache/BgeM3EmbeddingCacheCoordinator");
const {
  createCurrentEmbeddingIdentityIndex
} = require("../core/hippocampus/embedding-cache/CurrentEmbeddingIdentityIndex");
const {
  EXPECTED_NORMALIZED,
  createBgeM3EmbeddingProvider
} = require("../core/providers/embedding/BgeM3EmbeddingProvider");
const {
  QDRANT_TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
  qdrantConfiguration,
  isPrivateQdrantEndpoint,
  controlledProvider,
  listQdrantCollections,
  collectionsPreserved
} = require("./provision-hippocampus-embedding-cache");

const SYNTHETIC_USER_ID = "ec7-synthetic-user-v1";
const EMBEDDING_BATCH_SIZE = 2;
const PAYLOAD_KEYS = Object.freeze([
  "schema_version", "logical_key_hash", "user_id_hash", "memory_id",
  "content_hash", "embedding_model", "embedding_revision", "normalized",
  "vector_fingerprint"
]);
const SYNTHETIC_DEFINITIONS = Object.freeze([
  Object.freeze({
    memoryId: "orbit-a",
    text: "Un satellite sintetico percorre una traiettoria ellittica attorno a un pianeta immaginario."
  }),
  Object.freeze({
    memoryId: "bread-a",
    text: "Una ricetta sintetica descrive la cottura del pane in un forno virtuale."
  }),
  Object.freeze({
    memoryId: "garden-a",
    text: "Un giardino simulato contiene felci verdi e sentieri di ghiaia."
  }),
  Object.freeze({
    memoryId: "orbit-affine-8",
    text: "Un veicolo spaziale artificiale segue una orbita ellittica intorno a un mondo simulato."
  }),
  Object.freeze({
    memoryId: "bread-b",
    text: "Il pane artificiale viene cotto lentamente nel forno di una cucina simulata."
  }),
  Object.freeze({
    memoryId: "music-a",
    text: "Una scala musicale sintetica alterna note acute e note gravi."
  })
]);

function contentHash(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function syntheticItems() {
  return SYNTHETIC_DEFINITIONS.map((item) => ({
    userId: SYNTHETIC_USER_ID,
    memoryId: item.memoryId,
    contentHash: contentHash(item.text),
    text: item.text
  }));
}

function smokeConfiguration(env) {
  const qdrant = qdrantConfiguration(env);
  const rawEmbeddingUrl = env?.HIPPOCAMPUS_EMBEDDING_URL;
  const embeddingApiKey = env?.HIPPOCAMPUS_EMBEDDING_API_KEY;
  if (!qdrant || typeof rawEmbeddingUrl !== "string" || rawEmbeddingUrl.trim().length === 0 ||
      typeof embeddingApiKey !== "string" || embeddingApiKey.length === 0 || /[\r\n]/.test(embeddingApiKey)) {
    return null;
  }
  let embeddingUrl;
  try {
    embeddingUrl = new URL(rawEmbeddingUrl);
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(embeddingUrl.protocol) || embeddingUrl.username ||
      embeddingUrl.password || embeddingUrl.search || embeddingUrl.hash ||
      embeddingUrl.pathname !== "/api/v1/embed") return null;
  const healthUrl = new URL(embeddingUrl);
  healthUrl.pathname = "/health";
  return {
    qdrant,
    embeddingUrl: embeddingUrl.toString(),
    embeddingHealthUrl: healthUrl.toString(),
    embeddingApiKey
  };
}

async function qualifiedBgeHealth(config, fetchImpl = globalThis.fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), QDRANT_TIMEOUT_MS);
  try {
    const response = await fetchImpl(config.embeddingHealthUrl, {
      method: "GET",
      headers: { Accept: "application/json", "X-API-Key": config.embeddingApiKey },
      redirect: "manual",
      signal: controller.signal
    });
    if (!response.ok || response.status >= 300 && response.status <= 399 ||
        !/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") || "")) return false;
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) return false;
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return false;
    }
    const cuda = body?.cuda === true || body?.cuda_available === true ||
      typeof body?.device === "string" && /^cuda(?::\d+)?$/i.test(body.device);
    return body && typeof body === "object" && !Array.isArray(body) &&
      body.model === EMBEDDING_CACHE_MODEL && body.revision === EMBEDDING_CACHE_REVISION &&
      body.dimension === EMBEDDING_CACHE_DIMENSION && body.model_loaded === true && cuda;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function qdrantAuth(config) {
  return config.qdrant.apiKey === undefined ? "absent-private-network" : "present";
}

function sanitizedErrorCode(error, fallback) {
  return typeof error?.code === "string" && /^[A-Z][A-Z0-9_]*$/.test(error.code)
    ? error.code
    : fallback;
}

function baseResult(config) {
  return {
    collection: EMBEDDING_CACHE_COLLECTION,
    dimension: EMBEDDING_CACHE_DIMENSION,
    distance: "Cosine",
    payloadIndexes: 8,
    qdrantAuth: config ? qdrantAuth(config) : "unknown",
    bgeModel: EMBEDDING_CACHE_MODEL,
    bgeRevision: EMBEDDING_CACHE_REVISION,
    syntheticPoints: 6,
    batchSize: EMBEDDING_BATCH_SIZE,
    existingCollectionsModified: false,
    deleteCleanup: "none",
    daemonQwenCommit: "none",
    realDataModified: false
  };
}

function countedEmbeddingProvider(provider, counters) {
  return Object.freeze({
    ...provider,
    async embedBatch(request) {
      counters.embeddingCalls += 1;
      return provider.embedBatch(request);
    }
  });
}

function identityFor(item) {
  return createIdentity({
    userId: SYNTHETIC_USER_ID,
    memoryId: item.memoryId,
    contentHash: item.contentHash,
    model: EMBEDDING_CACHE_MODEL,
    revision: EMBEDDING_CACHE_REVISION
  });
}

function assertCrossBatchPlan(items) {
  const ordered = items.map((item) => ({ item, pointId: createPointId(identityFor(item)) }))
    .sort((left, right) => left.pointId.localeCompare(right.pointId));
  const queryIndex = ordered.findIndex(({ item }) => item.memoryId === "orbit-a");
  const affineIndex = ordered.findIndex(({ item }) => item.memoryId === "orbit-affine-8");
  if (queryIndex < 0 || affineIndex < 0 ||
      Math.floor(queryIndex / EMBEDDING_BATCH_SIZE) >= Math.floor(affineIndex / EMBEDDING_BATCH_SIZE)) {
    throw Object.assign(new Error("synthetic cross-batch plan invalid"), {
      code: "SYNTHETIC_CROSS_BATCH_PLAN_INVALID"
    });
  }
}

function assertMaterialize(result, total) {
  if (result?.total !== total || result.hitCount + result.createdCount + result.replayedCount !== total ||
      result.embeddedCount !== result.createdCount + result.replayedCount) {
    throw Object.assign(new Error("materialize result invalid"), { code: "MATERIALIZE_RESULT_INVALID" });
  }
}

function assertPayloadPoint(point, expectedById) {
  if (!point || typeof point !== "object" || !expectedById.has(point.id) ||
      !point.payload || !Array.isArray(point.vector) ||
      Object.keys(point.payload).sort().join("\0") !== [...PAYLOAD_KEYS].sort().join("\0")) {
    throw Object.assign(new Error("synthetic payload invalid"), { code: "SYNTHETIC_PAYLOAD_INVALID" });
  }
  const identity = expectedById.get(point.id);
  validatePayload(point.payload, identity, point.vector);
  const serialized = JSON.stringify(point.payload);
  if (serialized.includes(SYNTHETIC_USER_ID) ||
      Object.keys(point.payload).some((key) => /text|timestamp|metadata|narrative/i.test(key))) {
    throw Object.assign(new Error("synthetic payload leaks source data"), {
      code: "SYNTHETIC_PAYLOAD_PRIVACY_FAILURE"
    });
  }
}

async function runSyntheticSmoke(options) {
  const config = smokeConfiguration(options?.env || {});
  if (!config) return { status: "DEFERRED_INVALID_CONFIGURATION", ...baseResult(null) };
  const base = baseResult(config);
  if (config.qdrant.apiKey === undefined && !isPrivateQdrantEndpoint(config.qdrant.endpoint)) {
    return { status: "DEFERRED_PUBLIC_ENDPOINT_WITHOUT_AUTH", ...base };
  }
  const counters = { writes: 0, embeddingCalls: 0 };
  let phase = "qdrant-health";
  try {
    const rawQdrant = options?.qdrantProvider ||
      (options?.qdrantProviderFactory || createQdrantEmbeddingCacheProvider)({
        endpoint: config.qdrant.endpoint,
        apiKey: config.qdrant.apiKey,
        timeoutMs: QDRANT_TIMEOUT_MS,
        maxResponseBytes: MAX_RESPONSE_BYTES,
        providerId: "hippocampus-embedding-cache-ec7-smoke"
      });
    const qdrant = controlledProvider(rawQdrant, counters);
    await qdrant.health({ signal: new AbortController().signal });

    phase = "bge-health";
    const healthPassed = options?.bgeHealthCheck
      ? await options.bgeHealthCheck()
      : await qualifiedBgeHealth(config, options?.fetchImpl || globalThis.fetch);
    if (!healthPassed) return { status: "DEFERRED_BGE_HEALTH_UNQUALIFIED", ...base };

    const cache = (options?.adapterFactory || createHippocampusEmbeddingCacheAdapter)({ provider: qdrant });
    phase = "collection-inspect";
    const lifecycle = await cache.ensureCollection({
      allowCreate: false, signal: new AbortController().signal
    });
    if (!lifecycle.ready) return { status: "DEFERRED_COLLECTION_NOT_READY", ...base };

    const listCollections = options?.listCollections ||
      (() => listQdrantCollections(config.qdrant, options?.fetchImpl || globalThis.fetch));
    phase = "snapshot-before";
    const collectionsBefore = await listCollections();

    const rawEmbedding = options?.embeddingProvider ||
      (options?.embeddingProviderFactory || createBgeM3EmbeddingProvider)({
        baseUrl: config.embeddingUrl,
        apiKey: config.embeddingApiKey,
        timeoutMs: 120000,
        maxResponseBytes: MAX_RESPONSE_BYTES,
        fetchImpl: options?.fetchImpl || globalThis.fetch
      });
    const embedding = countedEmbeddingProvider(rawEmbedding, counters);
    const coordinator = createBgeM3EmbeddingCacheCoordinator({
      cacheAdapter: cache,
      embeddingProvider: embedding,
      embeddingBatchSize: EMBEDDING_BATCH_SIZE,
      model: EMBEDDING_CACHE_MODEL,
      revision: EMBEDDING_CACHE_REVISION
    });
    const items = syntheticItems();
    assertCrossBatchPlan(items);

    phase = "first-materialize";
    const first = await coordinator.materialize({ items, signal: new AbortController().signal });
    assertMaterialize(first, items.length);
    const embeddingCallsAfterFirst = counters.embeddingCalls;
    const writesAfterFirst = counters.writes;

    phase = "second-materialize";
    const second = await coordinator.materialize({ items, signal: new AbortController().signal });
    assertMaterialize(second, items.length);
    if (second.hitCount !== items.length || second.createdCount !== 0 || second.replayedCount !== 0 ||
        counters.embeddingCalls !== embeddingCallsAfterFirst || counters.writes !== writesAfterFirst) {
      throw Object.assign(new Error("second materialize was not a pure cache hit"), {
        code: "SECOND_MATERIALIZE_NOT_PURE_HIT"
      });
    }

    phase = "neighbor-search";
    const index = createCurrentEmbeddingIdentityIndex({
      userId: SYNTHETIC_USER_ID,
      items: items.map((item) => ({
        memoryId: item.memoryId,
        contentHash: item.contentHash,
        model: EMBEDDING_CACHE_MODEL,
        revision: EMBEDDING_CACHE_REVISION
      }))
    });
    const query = items.find((item) => item.memoryId === "orbit-a");
    const search = await cache.searchNeighbors({
      userId: SYNTHETIC_USER_ID,
      queryIdentity: {
        memoryId: query.memoryId,
        contentHash: query.contentHash,
        model: EMBEDDING_CACHE_MODEL,
        revision: EMBEDDING_CACHE_REVISION
      },
      validIdentityIndex: index,
      scoreThreshold: -1,
      limit: 5,
      signal: new AbortController().signal
    });
    const affine = search.neighbors.find((neighbor) => neighbor.memoryId === "orbit-affine-8");
    const unrelated = search.neighbors.find((neighbor) => neighbor.memoryId === "bread-a");
    if (!affine || !unrelated || !(affine.score > unrelated.score)) {
      throw Object.assign(new Error("cross-batch semantic ordering failed"), {
        code: "CROSS_BATCH_SIMILARITY_FAILURE"
      });
    }

    phase = "bounded-payload-read";
    const expectedById = new Map(items.map((item) => {
      const identity = identityFor(item);
      return [createPointId(identity), identity];
    }));
    const retrieved = await qdrant.retrievePoints({
      collection: EMBEDDING_CACHE_COLLECTION,
      pointIds: [...expectedById.keys()],
      withPayload: true,
      withVector: true,
      signal: new AbortController().signal
    });
    if (retrieved.points.length !== items.length) {
      throw Object.assign(new Error("synthetic retrieve incomplete"), { code: "SYNTHETIC_RETRIEVE_INCOMPLETE" });
    }
    for (const point of retrieved.points) assertPayloadPoint(point, expectedById);
    const userIdHash = identityFor(items[0]).userIdHash;
    const scrolled = await qdrant.scrollPayload({
      collection: EMBEDDING_CACHE_COLLECTION,
      filter: { must: [
        { key: "schema_version", match: { value: EMBEDDING_CACHE_SCHEMA_VERSION } },
        { key: "user_id_hash", match: { value: userIdHash } },
        { key: "embedding_model", match: { value: EMBEDDING_CACHE_MODEL } },
        { key: "embedding_revision", match: { value: EMBEDDING_CACHE_REVISION } },
        { key: "normalized", match: { value: EXPECTED_NORMALIZED } }
      ] },
      limit: items.length,
      offset: null,
      withPayload: true,
      withVector: false,
      signal: new AbortController().signal
    });
    if (scrolled.points.length !== items.length || scrolled.nextPageOffset !== null ||
        scrolled.points.some((point) => !expectedById.has(point.id))) {
      throw Object.assign(new Error("synthetic scroll was not bounded"), { code: "SYNTHETIC_SCROLL_INVALID" });
    }

    phase = "snapshot-after";
    const collectionsAfter = await listCollections();
    if (!collectionsPreserved(collectionsBefore, collectionsAfter)) {
      throw Object.assign(new Error("existing collection set changed"), {
        code: "EXISTING_COLLECTIONS_NOT_PRESERVED"
      });
    }
    return {
      status: "PASS",
      ...base,
      firstMaterialize: {
        hit: first.hitCount, created: first.createdCount, replay: first.replayedCount,
        batches: first.batches
      },
      secondMaterialize: { hit: second.hitCount, created: 0, replay: 0, newBgeCalls: 0, newWrites: 0 },
      crossBatchNeighbor: true,
      affineSimilarity: affine.score,
      unrelatedSimilarity: unrelated.score,
      payloadContainsText: false,
      writes: counters.writes,
      embeddingCalls: counters.embeddingCalls
    };
  } catch (error) {
    return {
      status: "FAIL",
      ...base,
      failedPhase: phase,
      errorCode: sanitizedErrorCode(error, "EC7_SYNTHETIC_SMOKE_FAILURE"),
      retryable: error?.retryable === true,
      writes: counters.writes,
      embeddingCalls: counters.embeddingCalls
    };
  }
}

function writeReport(result) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (require.main === module) {
  runSyntheticSmoke({ env: process.env })
    .then((result) => {
      writeReport(result);
      if (result.status === "FAIL") process.exitCode = 1;
    })
    .catch(() => {
      writeReport({ status: "FAIL", errorCode: "EC7_SYNTHETIC_SMOKE_FAILURE" });
      process.exitCode = 1;
    });
}

module.exports = {
  SYNTHETIC_USER_ID,
  EMBEDDING_BATCH_SIZE,
  SYNTHETIC_DEFINITIONS,
  PAYLOAD_KEYS,
  syntheticItems,
  smokeConfiguration,
  qualifiedBgeHealth,
  assertCrossBatchPlan,
  runSyntheticSmoke
};
