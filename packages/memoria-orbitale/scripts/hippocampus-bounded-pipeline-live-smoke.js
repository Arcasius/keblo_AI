#!/usr/bin/env node
"use strict";

const { createHash } = require("node:crypto");
const {
  DEFAULT_BOUNDED_CLUSTERING_POLICY
} = require("../core/clustering/HippocampusBoundedClusteringPlan");
const {
  createHippocampusCandidateGraphBuilder
} = require("../core/clustering/HippocampusCandidateGraphBuilder");
const {
  createHippocampusBoundedCompleteLinkRefiner
} = require("../core/clustering/HippocampusBoundedCompleteLinkRefiner");
const {
  createTemporalClusterProvenance
} = require("../core/clustering/HippocampusTemporalProvenance");
const {
  createTemporalSynthesisRequest
} = require("../core/synthesis/HippocampusTemporalSynthesisRequest");
const {
  createSuperMemoryRecord,
  validateSuperMemoryRecord
} = require("../core/consolidation/SuperMemoryRecord");
const {
  createHippocampusBoundedPipelineAdapter
} = require("../core/hippocampus/HippocampusBoundedPipelineAdapter");
const {
  EMBEDDING_CACHE_SCHEMA_VERSION,
  EMBEDDING_CACHE_MODEL,
  EMBEDDING_CACHE_REVISION
} = require("../core/hippocampus/embedding-cache/EmbeddingCacheRecord");
const {
  createHippocampusEmbeddingCacheAdapter
} = require("../core/hippocampus/embedding-cache/HippocampusEmbeddingCacheAdapter");
const {
  createBgeM3EmbeddingCacheCoordinator
} = require("../core/hippocampus/embedding-cache/BgeM3EmbeddingCacheCoordinator");
const {
  createBgeM3EmbeddingProvider
} = require("../core/providers/embedding/BgeM3EmbeddingProvider");
const {
  createQdrantEmbeddingCacheProvider
} = require("../core/providers/vector/QdrantEmbeddingCacheProvider");
const {
  createQdrantExactThresholdDiscoveryProvider
} = require("../core/providers/vector/QdrantExactThresholdDiscoveryProvider");
const {
  createOllamaSynthesisProvider
} = require("../core/providers/ollama/OllamaSynthesisProvider");
const {
  QDRANT_TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
  qdrantConfiguration,
  isPrivateQdrantEndpoint
} = require("./provision-hippocampus-embedding-cache");
const {
  smokeConfiguration,
  qualifiedBgeHealth
} = require("./hippocampus-embedding-cache-synthetic-smoke");

const SYNTHETIC_USER_ID = "bc8-live-synthetic-user-v1";
const QWEN_MODEL = "qwen3.5:27b";
const DEFAULT_QWEN_URL = "http://100.127.150.67:11434/api/chat";
const MAX_HITS_PER_QUERY = 8;
const SYNTHETIC = Object.freeze([
  Object.freeze({
    memoryId: "bc8-light-a",
    text: "Scenario sintetico BC8: una luce blu controllata illumina il laboratorio virtuale.",
    timestamp: 1800000000000
  }),
  Object.freeze({
    memoryId: "bc8-light-b",
    text: "Nel test sintetico BC8, la stessa luce blu controllata illumina il laboratorio virtuale.",
    timestamp: 1800000001000
  }),
  Object.freeze({
    memoryId: "bc8-light-c",
    text: "Il laboratorio virtuale BC8 è illuminato dalla medesima luce blu controllata.",
    timestamp: null
  })
]);
const BUDGETS = Object.freeze({
  neighborLimit: 16,
  overfetchFactor: 1,
  scoreThreshold: DEFAULT_BOUNDED_CLUSTERING_POLICY.clusterThreshold,
  maxComponentVectorsInMemory: 16,
  maxPairwiseComparisons: 1000,
  maxCandidateEdges: 100,
  maxClusterSize: 16,
  timeoutMs: 120000,
  maxRssDeltaBytes: 256 * 1024 * 1024
});
const SYNTHESIS_LIMITS = Object.freeze({
  timeoutMs: 120000,
  maxInputChars: 120000,
  maxOutputChars: 30000,
  maxTitleChars: 300,
  maxSynthesisChars: 12000,
  maxFactItems: 200,
  maxUncertaintyItems: 100,
  maxContradictionItems: 100
});

function contentHash(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function sources() {
  return SYNTHETIC.map((item) => ({
    memoryId: item.memoryId,
    text: item.text,
    contentHash: contentHash(item.text),
    timestamp: item.timestamp,
    sourceContract: "flat",
    lastAccess: null,
    eventTimeEvidence: null,
    type: "synthetic"
  }));
}

function baseResult() {
  return {
    sourceSyntheticCount: SYNTHETIC.length,
    cache: { hit: 0, created: 0, replay: 0 },
    exactCertificates: 0,
    componentsCompleted: 0,
    componentsDeferred: 0,
    clusterCount: 0,
    clusterSizes: [],
    timestampQuality: [],
    synthesisCalls: 0,
    temporarySuperMemoryValid: false,
    commitCalls: 0,
    realDataModified: false,
    elapsedMs: 0
  };
}

function errorCode(error) {
  return typeof error?.code === "string" && /^[A-Z][A-Z0-9_]*$/.test(error.code)
    ? error.code
    : "BC8_LIVE_SMOKE_FAILURE";
}

function controlledQdrant(provider, counters) {
  const wrapped = {};
  for (const [name, value] of Object.entries(provider)) {
    if (typeof value !== "function") {
      wrapped[name] = value;
      continue;
    }
    wrapped[name] = async (request) => {
      if (/delete/i.test(name) || ["createCollection", "createPayloadIndex"].includes(name)) {
        counters.destructiveCalls += 1;
        throw Object.assign(new Error("destructive API forbidden"), {
          code: "DESTRUCTIVE_API_FORBIDDEN"
        });
      }
      if (name === "upsertPoints") counters.cacheWrites += 1;
      return value(request);
    };
  }
  return Object.freeze(wrapped);
}

async function runLiveSmoke(options = {}) {
  const startedAt = Date.now();
  const base = baseResult();
  const env = options.env || {};
  const config = smokeConfiguration(env);
  const qdrant = qdrantConfiguration(env);
  const qwenUrl = env.PRIMARY_OLLAMA_URL || DEFAULT_QWEN_URL;
  if (!config || !qdrant) {
    return { status: "BLOCKED_CONFIGURATION", ...base, elapsedMs: Date.now() - startedAt };
  }
  if (qdrant.apiKey === undefined && !isPrivateQdrantEndpoint(qdrant.endpoint)) {
    return { status: "BLOCKED_QDRANT_SCOPE", ...base, elapsedMs: Date.now() - startedAt };
  }
  const counters = { cacheWrites: 0, destructiveCalls: 0 };
  try {
    if (!await qualifiedBgeHealth(config, options.fetchImpl || globalThis.fetch)) {
      return { status: "BLOCKED_BGE_HEALTH", ...base, elapsedMs: Date.now() - startedAt };
    }
    const rawQdrant = createQdrantEmbeddingCacheProvider({
      endpoint: qdrant.endpoint,
      apiKey: qdrant.apiKey,
      timeoutMs: QDRANT_TIMEOUT_MS,
      maxResponseBytes: MAX_RESPONSE_BYTES,
      providerId: "hippocampus-bc8-live-smoke"
    });
    const qdrantProvider = controlledQdrant(rawQdrant, counters);
    const cacheAdapter = createHippocampusEmbeddingCacheAdapter({
      provider: qdrantProvider
    });
    const lifecycle = await cacheAdapter.ensureCollection({
      allowCreate: false,
      signal: new AbortController().signal
    });
    if (!lifecycle.ready) {
      return { status: "BLOCKED_CACHE_COLLECTION", ...base, elapsedMs: Date.now() - startedAt };
    }
    const embeddingProvider = createBgeM3EmbeddingProvider({
      baseUrl: config.embeddingUrl,
      apiKey: config.embeddingApiKey,
      timeoutMs: 120000,
      maxResponseBytes: MAX_RESPONSE_BYTES,
      fetchImpl: options.fetchImpl || globalThis.fetch
    });
    const coordinator = createBgeM3EmbeddingCacheCoordinator({
      cacheAdapter,
      embeddingProvider,
      embeddingBatchSize: 3,
      model: EMBEDDING_CACHE_MODEL,
      revision: EMBEDDING_CACHE_REVISION
    });
    const embeddingCoordinator = {
      materialize(request) {
        return coordinator.materialize(request);
      },
      async resolveEmbedding(request) {
        const lookup = await cacheAdapter.getValidEmbedding({
          userId: request.userId,
          memoryId: request.identity.memoryId,
          contentHash: request.identity.contentHash,
          model: request.identity.model,
          revision: request.identity.revision,
          signal: request.signal
        });
        if (lookup.status !== "hit") {
          throw Object.assign(new Error("embedding unavailable"), {
            code: "EMBEDDING_UNAVAILABLE"
          });
        }
        return {
          vector: lookup.embedding,
          provenance: {
            cacheSchemaVersion: EMBEDDING_CACHE_SCHEMA_VERSION,
            identitySnapshotFingerprint: request.identitySnapshotFingerprint,
            pointId: request.identity.pointId,
            memoryId: request.identity.memoryId,
            contentHash: request.identity.contentHash,
            model: request.identity.model,
            revision: request.identity.revision,
            dimension: 1024,
            normalized: true
          }
        };
      }
    };
    const synthesisProvider = createOllamaSynthesisProvider({
      baseUrl: qwenUrl,
      model: QWEN_MODEL,
      timeoutMs: 120000,
      maxResponseBytes: 1024 * 1024,
      keepAlive: "5m",
      fetchImpl: options.fetchImpl || globalThis.fetch
    });
    const liveSources = sources();
    const adapter = createHippocampusBoundedPipelineAdapter({
      sourceResolver: {
        async resolveSnapshotSources() {
          return { userId: SYNTHETIC_USER_ID, sources: liveSources };
        },
        async rereadSources({ memoryIds }) {
          return memoryIds.map((memoryId) =>
            liveSources.find((source) => source.memoryId === memoryId));
        }
      },
      embeddingCoordinator,
      exactDiscoveryProvider: {
        create(context) {
          return createQdrantExactThresholdDiscoveryProvider({
            qdrantProvider,
            ...context,
            maxHitsPerQuery: MAX_HITS_PER_QUERY,
            timeoutMs: QDRANT_TIMEOUT_MS,
            maxResponseBytes: MAX_RESPONSE_BYTES
          });
        }
      },
      graphBuilder: {
        create({ discoveryProvider, budgets }) {
          return createHippocampusCandidateGraphBuilder({
            discoveryProvider,
            maxNeighborQueries: liveSources.length,
            maxCandidateEdges: budgets.maxCandidateEdges,
            timeoutMs: budgets.timeoutMs
          });
        }
      },
      refiner: {
        create() {
          return createHippocampusBoundedCompleteLinkRefiner({
            embeddingResolver: {
              cacheSchemaVersion: EMBEDDING_CACHE_SCHEMA_VERSION,
              resolveEmbedding(request) {
                return embeddingCoordinator.resolveEmbedding({
                  userId: SYNTHETIC_USER_ID,
                  ...request
                });
              }
            },
            rssReader: { readRssBytes: () => process.memoryUsage().rss },
            clock: { now: Date.now }
          });
        }
      },
      temporalProvenance: {
        createClusterProvenance: createTemporalClusterProvenance,
        createSynthesisRequest: createTemporalSynthesisRequest
      },
      synthesisProvider,
      synthesisLimits: SYNTHESIS_LIMITS,
      superMemoryValidator: {
        create: createSuperMemoryRecord,
        validate: validateSuperMemoryRecord
      },
      clock: { now: Date.now }
    });
    const result = await adapter.run({
      budgets: BUDGETS,
      constraints: {
        language: "it",
        preserveUncertainty: true,
        preserveContradictions: true
      },
      processingAttemptId: "bc8-live-synthetic-attempt",
      signal: new AbortController().signal
    });
    if (counters.destructiveCalls !== 0 || result.commitCalls !== 0 ||
        result.realDataModified !== false) {
      throw Object.assign(new Error("write boundary violated"), {
        code: "WRITE_BOUNDARY_VIOLATION"
      });
    }
    return {
      status: result.status === "COMPLETE" &&
        result.clusterCount > 0 &&
        result.temporarySuperMemoryValid === true
        ? "PASS"
        : "BLOCKED_NO_CERTIFIED_CLUSTER",
      sourceSyntheticCount: result.sourceCount,
      cache: result.cache,
      exactCertificates: result.exactCertificateCount,
      componentsCompleted: result.components.completed,
      componentsDeferred: result.components.deferred,
      clusterCount: result.clusterCount,
      clusterSizes: result.clusterSizes,
      timestampQuality: result.timestampQuality,
      synthesisCalls: result.synthesisCalls,
      temporarySuperMemoryValid: result.temporarySuperMemoryValid,
      commitCalls: result.commitCalls,
      realDataModified: result.realDataModified,
      elapsedMs: Date.now() - startedAt
    };
  } catch (error) {
    return {
      status: "FAIL",
      ...base,
      errorCode: errorCode(error),
      elapsedMs: Date.now() - startedAt
    };
  }
}

if (require.main === module) {
  runLiveSmoke({ env: process.env }).then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.status !== "PASS") process.exitCode = 1;
  }).catch(() => {
    process.stdout.write(`${JSON.stringify({
      status: "FAIL",
      ...baseResult(),
      errorCode: "BC8_LIVE_SMOKE_FAILURE"
    })}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  SYNTHETIC_USER_ID,
  SYNTHETIC,
  BUDGETS,
  runLiveSmoke
};
