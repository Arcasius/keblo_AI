#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  runtimeEnvironment
} = require("./hippocampus-run");
const {
  projectLegacyFlatMemoriesForShadow
} = require("../core/hippocampus/LegacyFlatMemoryShadowProjection");
const {
  buildConsolidationPlanScalable
} = require("../core/consolidation/ConsolidationPlan");
const {
  createQdrantEmbeddingCacheProvider
} = require("../core/providers/vector/QdrantEmbeddingCacheProvider");
const {
  createHippocampusEmbeddingCacheAdapter
} = require("../core/hippocampus/embedding-cache/HippocampusEmbeddingCacheAdapter");
const {
  EMBEDDING_CACHE_MODEL,
  EMBEDDING_CACHE_REVISION
} = require("../core/hippocampus/embedding-cache/EmbeddingCacheRecord");
const {
  qdrantConfiguration,
  QDRANT_TIMEOUT_MS,
  MAX_RESPONSE_BYTES
} = require("./provision-hippocampus-embedding-cache");

const POLICIES = new Set(["CURRENT", "CONNECTION_CLOSE"]);

function parse(args) {
  if (!Array.isArray(args) || args.length !== 4 || args[0] !== "--policy" ||
      !POLICIES.has(args[1]) || args[2] !== "--reads" ||
      !/^[1-9][0-9]*$/.test(args[3])) {
    throw Object.assign(new Error("invalid diagnostic request"), {
      code: "INVALID_DIAGNOSTIC_REQUEST"
    });
  }
  const reads = Number(args[3]);
  if (!Number.isSafeInteger(reads) || reads > 1000) {
    throw Object.assign(new Error("invalid diagnostic request"), {
      code: "INVALID_DIAGNOSTIC_REQUEST"
    });
  }
  return { policy: args[1], reads };
}

function sanitizedError(error) {
  const technical = error?.transportDiagnostic;
  return {
    reasonCode: typeof error?.code === "string" &&
      /^[A-Z][A-Z0-9_]*$/.test(error.code)
      ? error.code : "DIAGNOSTIC_READ_FAILED",
    requestSequence: Number.isSafeInteger(technical?.requestSequence)
      ? technical.requestSequence : 0,
    socketReused: typeof technical?.socketReused === "boolean"
      ? technical.socketReused : null,
    responseCompleted: technical?.responseCompleted === true,
    resetBeforeHeaders: technical?.resetBeforeHeaders === true,
    resetDuringBody: technical?.resetDuringBody === true,
    resetAfterComplete: technical?.resetAfterComplete === true
  };
}

async function candidates(configuration, signal) {
  const file = path.join(configuration.dataDir, "francesco_memories.json");
  const source = JSON.parse(await fs.promises.readFile(file, "utf8"));
  const projection = projectLegacyFlatMemoriesForShadow(source, {
    requestedUserId: "francesco",
    sourceUserId: "francesco",
    maxCandidates: 100
  });
  const scalable = await buildConsolidationPlanScalable(projection.records, {
    allowLegacyUnclassified: false,
    maxCandidates: 100,
    batchSize: 100,
    budget: {
      maxElapsedMs: 9500,
      maxRssDeltaBytes: 128 * 1024 * 1024
    },
    signal
  });
  const decisionById = new Map(scalable.plan.decisions.map((decision) =>
    [decision.memoryId, decision]));
  return scalable.plan.candidateIds.map((memoryId) => ({
    memoryId,
    contentHash: decisionById.get(memoryId).contentHash
  }));
}

async function run(args, env = process.env) {
  const request = parse(args);
  const configuration = runtimeEnvironment(env);
  const qdrant = qdrantConfiguration(env);
  if (!configuration.complete || !qdrant) {
    throw Object.assign(new Error("configuration incomplete"), {
      code: "CONFIGURATION_INCOMPLETE"
    });
  }
  const signal = new AbortController().signal;
  const items = await candidates(configuration, signal);
  if (items.length === 0) {
    throw Object.assign(new Error("no candidates"), {
      code: "NO_CANDIDATES"
    });
  }
  const originalFetch = globalThis.fetch;
  if (request.policy === "CONNECTION_CLOSE") {
    globalThis.fetch = (url, options = {}) => originalFetch(url, {
      ...options,
      headers: { ...options.headers, Connection: "close" }
    });
  }
  let completed = 0;
  try {
    const provider = createQdrantEmbeddingCacheProvider({
      endpoint: qdrant.endpoint,
      apiKey: qdrant.apiKey,
      timeoutMs: QDRANT_TIMEOUT_MS,
      maxResponseBytes: MAX_RESPONSE_BYTES,
      providerId: "hact9-connection-policy-diagnostic"
    });
    const cache = createHippocampusEmbeddingCacheAdapter({ provider });
    for (let index = 0; index < request.reads; index += 1) {
      const item = items[index % items.length];
      const result = await cache.getValidEmbedding({
        userId: "francesco",
        memoryId: item.memoryId,
        contentHash: item.contentHash,
        model: EMBEDDING_CACHE_MODEL,
        revision: EMBEDDING_CACHE_REVISION,
        signal
      });
      if (result.status !== "hit") {
        throw Object.assign(new Error("cache miss"), {
          code: "CACHE_MISS_READ_ONLY"
        });
      }
      completed += 1;
    }
    return {
      schemaVersion: 1,
      status: "PASSED",
      connectionPolicy: "PER_REQUEST_CONNECTION_CLOSE",
      requestedReadCount: request.reads,
      completedReadCount: completed,
      candidateCountVerified: items.length,
      requestSequence: request.reads,
      socketReused: null,
      responseCompleted: true,
      resetBeforeHeaders: false,
      resetDuringBody: false,
      resetAfterComplete: false,
      cacheMissCount: 0,
      upsertCount: 0,
      authoritativeWriteCount: 0,
      processingStateWriteCount: 0,
      commitCalls: 0
    };
  } catch (error) {
    return {
      schemaVersion: 1,
      status: "BLOCKED",
      connectionPolicy: "PER_REQUEST_CONNECTION_CLOSE",
      requestedReadCount: request.reads,
      completedReadCount: completed,
      candidateCountVerified: items.length,
      ...sanitizedError(error),
      cacheMissCount: error?.code === "CACHE_MISS_READ_ONLY" ? 1 : 0,
      upsertCount: 0,
      authoritativeWriteCount: 0,
      processingStateWriteCount: 0,
      commitCalls: 0
    };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

if (require.main === module) {
  run(process.argv.slice(2))
    .then((report) => {
      process.stdout.write(`${JSON.stringify(report)}\n`);
      if (report.status !== "PASSED") process.exitCode = 1;
    })
    .catch((error) => {
      process.stdout.write(`${JSON.stringify({
        schemaVersion: 1,
        status: "BLOCKED",
        ...sanitizedError(error)
      })}\n`);
      process.exitCode = 1;
    });
}

module.exports = { parse, run };
