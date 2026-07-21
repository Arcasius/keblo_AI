#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const {
  ACTIVATION_MODES,
  createHippocampusRuntime
} = require("../core/hippocampus");
const {
  SHADOW_CONFIRMATION,
  RUNTIME_OPERATIONS
} = require("../core/hippocampus/HippocampusRuntimeComposition");
const {
  createHippocampusActivationPreflight,
  EXPECTED_BGE_MODEL,
  EXPECTED_BGE_REVISION,
  EXPECTED_BGE_DIMENSION,
  EXPECTED_QWEN_MODEL
} = require("../core/hippocampus/HippocampusActivationPreflight");
const {
  projectMemoryForCandidateSelection
} = require("../core/MemoryContractNormalizer");
const {
  EXCLUSION_COUNT_KEYS,
  projectLegacyFlatMemoriesForShadow
} = require("../core/hippocampus/LegacyFlatMemoryShadowProjection");
const {
  buildConsolidationPlanScalable
} = require("../core/consolidation/ConsolidationPlan");
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
  EMBEDDING_CACHE_COLLECTION,
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
  smokeConfiguration
} = require("./hippocampus-embedding-cache-synthetic-smoke");
const { sanitizeHact9Failure } = require(
  "../core/hippocampus/Hact9FailureDiagnostic"
);

const MAX_CANDIDATES = 1000;
const MAX_HITS_PER_QUERY = 64;
const QWEN_TIMEOUT_MS = 120000;
const QWEN_MAX_RESPONSE_BYTES = 1024 * 1024;
const REQUIRED_ENVIRONMENT_KEYS = Object.freeze([
  "HIPPOCAMPUS_EMBEDDING_API_KEY",
  "HIPPOCAMPUS_EMBEDDING_URL",
  "HIPPOCAMPUS_MEMORY_DATA_DIR",
  "HIPPOCAMPUS_QDRANT_URL",
  "HIPPOCAMPUS_QWEN_TIMEOUT_MS",
  "PRIMARY_MODEL",
  "PRIMARY_OLLAMA_URL"
]);
const EXIT_CODES = Object.freeze({
  SUCCESS: 0,
  INVALID_ARGUMENTS: 2,
  PREFLIGHT_FAILED: 3,
  RUN_FAILED: 4,
  RUN_ABORTED: 5,
  LIVE_NOT_AUTHORIZED: 6
});
const FLAG_NAMES = new Set([
  "--confirm",
  "--max-candidates",
  "--mode",
  "--preflight-only",
  "--run-once",
  "--status",
  "--user-id"
]);

class HippocampusCliError extends Error {
  constructor(code, exitCode = EXIT_CODES.INVALID_ARGUMENTS) {
    super("Hippocampus standalone CLI request failed");
    this.name = "HippocampusCliError";
    this.code = code;
    this.phase = "cli";
    this.retryable = false;
    this.exitCode = exitCode;
  }
}

function fail(code, exitCode) {
  throw new HippocampusCliError(code, exitCode);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function nextValue(args, index) {
  const value = args[index + 1];
  if (typeof value !== "string" || value.length === 0 ||
      value.startsWith("--")) {
    fail("INVALID_ARGUMENTS");
  }
  return value;
}

function parseArguments(args) {
  if (!Array.isArray(args) || args.some((item) => typeof item !== "string")) {
    fail("INVALID_ARGUMENTS");
  }
  if (args.length === 0) {
    return {
      mode: ACTIVATION_MODES.OFF,
      operation: RUNTIME_OPERATIONS.STATUS,
      confirmation: null,
      userId: null,
      maxCandidates: null
    };
  }
  const values = {
    mode: null,
    operation: null,
    confirmation: null,
    userId: null,
    maxCandidates: null
  };
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!FLAG_NAMES.has(flag) || seen.has(flag)) fail("INVALID_ARGUMENTS");
    seen.add(flag);
    if (flag === "--status") {
      values.operation = values.operation === null
        ? RUNTIME_OPERATIONS.STATUS
        : fail("INVALID_ARGUMENTS");
      continue;
    }
    if (flag === "--preflight-only") {
      values.operation = values.operation === null
        ? RUNTIME_OPERATIONS.PREFLIGHT_ONLY
        : fail("INVALID_ARGUMENTS");
      continue;
    }
    if (flag === "--run-once") {
      values.operation = values.operation === null
        ? RUNTIME_OPERATIONS.RUN_ONCE
        : fail("INVALID_ARGUMENTS");
      continue;
    }
    const value = nextValue(args, index);
    index += 1;
    if (flag === "--mode") values.mode = value;
    if (flag === "--confirm") values.confirmation = value;
    if (flag === "--user-id") values.userId = value;
    if (flag === "--max-candidates") {
      if (!/^[1-9][0-9]*$/.test(value)) fail("INVALID_ARGUMENTS");
      values.maxCandidates = Number(value);
    }
  }
  if (values.mode === ACTIVATION_MODES.LIVE) {
    fail("LIVE_RUNTIME_NOT_AUTHORIZED", EXIT_CODES.LIVE_NOT_AUTHORIZED);
  }
  if (values.operation === RUNTIME_OPERATIONS.STATUS) {
    if (values.mode !== null && values.mode !== ACTIVATION_MODES.OFF ||
        values.confirmation !== null ||
        values.userId !== null ||
        values.maxCandidates !== null) {
      fail("INVALID_ARGUMENTS");
    }
    return {
      mode: ACTIVATION_MODES.OFF,
      operation: RUNTIME_OPERATIONS.STATUS,
      confirmation: null,
      userId: null,
      maxCandidates: null
    };
  }
  if (values.mode === ACTIVATION_MODES.OFF && values.operation === null &&
      values.confirmation === null && values.userId === null &&
      values.maxCandidates === null) {
    return {
      mode: ACTIVATION_MODES.OFF,
      operation: RUNTIME_OPERATIONS.STATUS,
      confirmation: null,
      userId: null,
      maxCandidates: null
    };
  }
  if (values.mode !== ACTIVATION_MODES.SHADOW ||
      ![RUNTIME_OPERATIONS.PREFLIGHT_ONLY, RUNTIME_OPERATIONS.RUN_ONCE]
        .includes(values.operation) ||
      values.confirmation !== SHADOW_CONFIRMATION) {
    fail(values.mode === ACTIVATION_MODES.SHADOW
      ? "SHADOW_CONFIRMATION_REQUIRED"
      : "INVALID_ARGUMENTS");
  }
  if (values.operation === RUNTIME_OPERATIONS.PREFLIGHT_ONLY) {
    if (values.userId !== null || values.maxCandidates !== null) {
      fail("INVALID_ARGUMENTS");
    }
  } else {
    if (typeof values.userId !== "string" ||
        !/^[A-Za-z0-9._-]{1,128}$/.test(values.userId) ||
        !Number.isSafeInteger(values.maxCandidates) ||
        values.maxCandidates <= 0 ||
        values.maxCandidates > MAX_CANDIDATES) {
      fail("INVALID_ARGUMENTS");
    }
  }
  return values;
}

function parsePositiveInteger(value, fallback, maximum) {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= maximum ? parsed : null;
}

function parseQwenUrl(raw) {
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol) ||
        url.username || url.password || url.search || url.hash ||
        url.pathname !== "/api/chat") return null;
    return url.toString();
  } catch {
    return null;
  }
}

function runtimeEnvironment(env) {
  const source = env !== null && typeof env === "object" ? env : {};
  const missingConfigurationKeys = REQUIRED_ENVIRONMENT_KEYS.filter((key) =>
    typeof source[key] !== "string" || source[key].trim().length === 0);
  if (missingConfigurationKeys.length > 0) {
    return Object.freeze({
      complete: false,
      reasonCode: "CONFIGURATION_INCOMPLETE",
      missingConfigurationKeys: Object.freeze(missingConfigurationKeys.sort())
    });
  }
  const qdrant = qdrantConfiguration(env);
  const embedding = smokeConfiguration(env);
  const qwenUrl = parseQwenUrl(env?.PRIMARY_OLLAMA_URL);
  const dataDir = env?.HIPPOCAMPUS_MEMORY_DATA_DIR;
  const qwenTimeoutMs = parsePositiveInteger(
    env?.HIPPOCAMPUS_QWEN_TIMEOUT_MS,
    null,
    300000
  );
  if (qdrant !== null && qdrant.apiKey === undefined &&
      !isPrivateQdrantEndpoint(qdrant.endpoint)) {
    return Object.freeze({
      complete: false,
      reasonCode: "CONFIGURATION_INCOMPLETE",
      missingConfigurationKeys: Object.freeze([
        "HIPPOCAMPUS_QDRANT_API_KEY"
      ])
    });
  }
  if (typeof dataDir !== "string" || !path.isAbsolute(dataDir)) {
    return Object.freeze({
      complete: false,
      reasonCode: "STORAGE_CONFIGURATION_INVALID",
      missingConfigurationKeys: Object.freeze([])
    });
  }
  const complete = qdrant !== null && embedding !== null &&
    qwenUrl !== null && qwenTimeoutMs !== null &&
    env.PRIMARY_MODEL === EXPECTED_QWEN_MODEL;
  if (!complete) {
    return Object.freeze({
      complete: false,
      reasonCode: "PREFLIGHT_INTERNAL_CONFIGURATION_ERROR",
      missingConfigurationKeys: Object.freeze([])
    });
  }
  return Object.freeze({
    complete: true,
    reasonCode: "PREFLIGHT_READY",
    missingConfigurationKeys: Object.freeze([]),
    qdrant,
    embedding: Object.freeze({
      ...embedding,
      model: EXPECTED_BGE_MODEL,
      revision: EXPECTED_BGE_REVISION,
      dimension: EXPECTED_BGE_DIMENSION,
      normalized: true
    }),
    qwenUrl,
    qwenModel: env.PRIMARY_MODEL,
    collection: EMBEDDING_CACHE_COLLECTION,
    dataDir,
    storage: Object.freeze({
      adapter: "json-memory-storage-read-only-v1",
      dataDir
    }),
    qdrantTimeoutMs: QDRANT_TIMEOUT_MS,
    qwenTimeoutMs
  });
}

function safeUserId(userId) {
  if (typeof userId !== "string" ||
      !/^[A-Za-z0-9._-]{1,128}$/.test(userId)) {
    fail("INVALID_RUNTIME_CONFIGURATION");
  }
  return userId;
}

function createReadOnlyAuthoritativeStorage(dataDir) {
  let authoritativeMemoryReads = 0;

  async function inspect(signal) {
    if (signal?.aborted) return false;
    try {
      await fs.promises.access(dataDir, fs.constants.R_OK);
      const stat = await fs.promises.stat(dataDir);
      return signal?.aborted !== true && stat.isDirectory();
    } catch {
      return false;
    }
  }

  async function readMap(userId, signal) {
    if (signal.aborted) fail("RUN_ABORTED", EXIT_CODES.RUN_ABORTED);
    const filePath = path.join(dataDir, `${safeUserId(userId)}_memories.json`);
    let parsed;
    try {
      authoritativeMemoryReads += 1;
      parsed = JSON.parse(await fs.promises.readFile(filePath, "utf8"));
    } catch {
      fail("AUTHORITATIVE_STORAGE_READ_FAILED", EXIT_CODES.RUN_FAILED);
    }
    if (signal.aborted) fail("RUN_ABORTED", EXIT_CODES.RUN_ABORTED);
    if (!isPlainObject(parsed) && !Array.isArray(parsed)) {
      fail("AUTHORITATIVE_STORAGE_READ_FAILED", EXIT_CODES.RUN_FAILED);
    }
    return parsed;
  }

  async function loadCandidates({ userId, limit, signal }) {
    const source = await readMap(userId, signal);
    const memories = Array.isArray(source) ? source : Object.values(source);
    return memories
      .filter((memory) => isPlainObject(memory))
      .sort((left, right) =>
        String(left.id || "").localeCompare(String(right.id || "")))
      .slice(0, limit);
  }

  async function rereadCandidates({ userId, memoryIds, signal }) {
    const source = await readMap(userId, signal);
    const memories = Array.isArray(source) ? source : Object.values(source);
    const wanted = new Set(memoryIds);
    return memories
      .filter((memory) => isPlainObject(memory) && wanted.has(memory.id))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  async function loadLegacyShadowCandidates({ userId, limit, signal }) {
    const source = await readMap(userId, signal);
    try {
      return projectLegacyFlatMemoriesForShadow(source, {
        requestedUserId: userId,
        sourceUserId: userId,
        maxCandidates: limit
      });
    } catch {
      fail("LEGACY_PROJECTION_FAILED", EXIT_CODES.RUN_FAILED);
    }
  }

  async function rereadLegacyShadowCandidates({ userId, memoryIds, signal }) {
    const source = await readMap(userId, signal);
    try {
      return projectLegacyFlatMemoriesForShadow(source, {
        requestedUserId: userId,
        sourceUserId: userId,
        maxCandidates: memoryIds.length,
        onlyMemoryIds: memoryIds
      });
    } catch {
      fail("LEGACY_PROJECTION_FAILED", EXIT_CODES.RUN_FAILED);
    }
  }

  function getAuthoritativeMemoryReads() {
    return authoritativeMemoryReads;
  }

  return Object.freeze({
    inspect,
    loadCandidates,
    rereadCandidates,
    loadLegacyShadowCandidates,
    rereadLegacyShadowCandidates,
    getAuthoritativeMemoryReads
  });
}

async function readJsonResponse(response, maximum) {
  if (!response || !response.ok ||
      !/^application\/json(?:\s*;|$)/i.test(
        response.headers?.get("content-type") || ""
      )) return null;
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > maximum) return null;
  try {
    const parsed = JSON.parse(text);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function linkedFetch(fetchImpl, url, request, callerSignal, timeoutMs) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (callerSignal.aborted) controller.abort();
  else callerSignal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...request, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    callerSignal.removeEventListener?.("abort", abort);
  }
}

function createRealPreflightEvaluator(config, injections = {}) {
  const fetchImpl = injections.fetchImpl || globalThis.fetch;
  return async ({ signal }) => {
    const state = {
      qdrant: false,
      embeddingCache: false,
      bge: false,
      ollama: false,
      qwenListed: false,
      qwenInference: false,
      qwenJson: false,
      qwenDone: null,
      storage: false
    };
    const checks = {
      configuration: "NOT_RUN",
      storage: "NOT_RUN",
      qdrant: "NOT_RUN",
      embeddingCache: "NOT_RUN",
      bgeM3: "NOT_RUN",
      qwenMiniInference: "NOT_RUN",
      commitCapabilityAbsent: "PASS"
    };
    const activationReport = () => createHippocampusActivationPreflight({
      qdrant: { ready: state.qdrant },
      embeddingCache: { ready: state.embeddingCache },
      bgeM3: {
        ready: state.bge,
        model: EXPECTED_BGE_MODEL,
        revision: EXPECTED_BGE_REVISION,
        dimension: EXPECTED_BGE_DIMENSION,
        normalized: true
      },
      ollama: { reachable: state.ollama },
      qwen: {
        model: EXPECTED_QWEN_MODEL,
        modelListed: state.qwenListed,
        miniInferenceCompleted: state.qwenInference,
        jsonValid: state.qwenJson,
        doneReason: state.qwenDone
      },
      storage: {
        available: state.storage,
        capabilityAttestationValid: state.storage
      },
      commit: { present: false }
    });
    const result = (reasonCode) => ({
      report: activationReport(),
      diagnostic: {
        reasonCode,
        checks: { ...checks },
        missingConfigurationKeys: [
          ...(config.missingConfigurationKeys || [])
        ]
      }
    });
    const aborted = () => {
      if (!signal.aborted) return null;
      return result("PREFLIGHT_ABORTED");
    };
    if (config.complete !== true) {
      checks.configuration = "FAIL";
      return result(config.reasonCode ||
        "PREFLIGHT_INTERNAL_CONFIGURATION_ERROR");
    }
    checks.configuration = "PASS";
    const storage = createReadOnlyAuthoritativeStorage(config.dataDir);
    state.storage = await storage.inspect(signal);
    if (aborted()) return aborted();
    checks.storage = state.storage ? "PASS" : "FAIL";
    if (!state.storage) return result("STORAGE_CONFIGURATION_INVALID");
    let qdrantProvider;
    try {
      qdrantProvider = (injections.qdrantProviderFactory ||
        createQdrantEmbeddingCacheProvider)({
        endpoint: config.qdrant.endpoint,
        apiKey: config.qdrant.apiKey,
        timeoutMs: QDRANT_TIMEOUT_MS,
        maxResponseBytes: MAX_RESPONSE_BYTES,
        providerId: "hippocampus-hact3-preflight"
      });
      await qdrantProvider.health({ signal });
      state.qdrant = true;
    } catch {
      if (aborted()) return aborted();
      checks.qdrant = "FAIL";
      return result("QDRANT_UNAVAILABLE");
    }
    checks.qdrant = "PASS";
    try {
      const cache = (injections.cacheAdapterFactory ||
        createHippocampusEmbeddingCacheAdapter)({ provider: qdrantProvider });
      const collection = await cache.ensureCollection({
        allowCreate: false,
        signal
      });
      state.embeddingCache = collection.ready === true;
    } catch {
      if (aborted()) return aborted();
      checks.embeddingCache = "FAIL";
      return result("EMBEDDING_CACHE_NOT_READY");
    }
    checks.embeddingCache = state.embeddingCache ? "PASS" : "FAIL";
    if (!state.embeddingCache) return result("EMBEDDING_CACHE_NOT_READY");
    try {
      const health = await linkedFetch(
        fetchImpl,
        config.embedding.embeddingHealthUrl,
        {
          method: "GET",
          headers: {
            Accept: "application/json",
            "X-API-Key": config.embedding.embeddingApiKey
          },
          redirect: "manual"
        },
        signal,
        QDRANT_TIMEOUT_MS
      );
      const body = await readJsonResponse(health, MAX_RESPONSE_BYTES);
      if (body === null) {
        checks.bgeM3 = "FAIL";
        return result("BGE_M3_UNAVAILABLE");
      }
      state.bge = body?.status === "healthy" &&
        body?.model === EXPECTED_BGE_MODEL &&
        body?.revision === EXPECTED_BGE_REVISION &&
        body?.model_loaded === true &&
        body?.device === "cuda" &&
        body?.dimension === EXPECTED_BGE_DIMENSION;
    } catch {
      if (aborted()) return aborted();
      checks.bgeM3 = "FAIL";
      return result("BGE_M3_UNAVAILABLE");
    }
    checks.bgeM3 = state.bge ? "PASS" : "FAIL";
    if (!state.bge) return result("BGE_M3_PROVENANCE_MISMATCH");
    try {
      const tagsUrl = new URL(config.qwenUrl);
      tagsUrl.pathname = "/api/tags";
      const tagsResponse = await linkedFetch(
        fetchImpl,
        tagsUrl.toString(),
        { method: "GET", headers: { Accept: "application/json" }, redirect: "manual" },
        signal,
        Math.min(config.qwenTimeoutMs, 10000)
      );
      const tags = await readJsonResponse(tagsResponse, QWEN_MAX_RESPONSE_BYTES);
      state.ollama = tags !== null;
      state.qwenListed = Array.isArray(tags?.models) && tags.models.some((item) =>
        item?.name === EXPECTED_QWEN_MODEL ||
        item?.model === EXPECTED_QWEN_MODEL);
      if (!state.ollama || !state.qwenListed) {
        checks.qwenMiniInference = "FAIL";
        return result("QWEN_UNAVAILABLE");
      }
      const miniProvider = (injections.synthesisProviderFactory ||
        createOllamaSynthesisProvider)({
        baseUrl: config.qwenUrl,
        model: config.qwenModel,
        timeoutMs: config.qwenTimeoutMs,
        maxResponseBytes: QWEN_MAX_RESPONSE_BYTES,
        keepAlive: "5m",
        fetchImpl
      });
      const inference = await miniProvider.generate({
        requestId: "0".repeat(64),
        messages: [{
          role: "user",
          content: "Return only JSON: {\"ready\":true}"
        }],
        signal,
        responseFormat: { type: "json_object", schemaVersion: 1 },
        maxOutputChars: 1024
      });
      state.qwenInference = inference?.ok === true &&
        typeof inference.text === "string";
      state.qwenDone = state.qwenInference ? "stop" : null;
      if (state.qwenInference) {
        try {
          state.qwenJson = isPlainObject(JSON.parse(inference.text));
        } catch {
          state.qwenJson = false;
        }
      }
    } catch {
      if (aborted()) return aborted();
      checks.qwenMiniInference = "FAIL";
      return result("QWEN_MINI_INFERENCE_FAILED");
    }
    const qwenReady = state.qwenInference && state.qwenJson &&
      state.qwenDone === "stop";
    checks.qwenMiniInference = qwenReady ? "PASS" : "FAIL";
    return result(qwenReady
      ? "PREFLIGHT_READY"
      : "QWEN_MINI_INFERENCE_FAILED");
  };
}

function controlledCacheProvider(provider, counters) {
  const wrapped = {};
  for (const [name, value] of Object.entries(provider)) {
    if (typeof value !== "function") {
      wrapped[name] = value;
      continue;
    }
    wrapped[name] = async (request) => {
      if (/delete/i.test(name) ||
          ["createCollection", "createPayloadIndex"].includes(name)) {
        fail("QDRANT_WRITE_SCOPE_VIOLATION", EXIT_CODES.RUN_FAILED);
      }
      if (name === "upsertPoints" &&
          request?.collection !== EMBEDDING_CACHE_COLLECTION) {
        fail("QDRANT_WRITE_SCOPE_VIOLATION", EXIT_CODES.RUN_FAILED);
      }
      const result = await value(request);
      if (name === "upsertPoints") {
        counters.cacheWrites += 1;
      }
      return result;
    };
  }
  return Object.freeze(wrapped);
}

function shadowFailureReason(error, phase, signal) {
  if (signal?.aborted || error?.code === "RUN_ABORTED" ||
      error?.code === "MATERIALIZE_ABORTED" ||
      error?.code === "BOUNDED_PIPELINE_ABORTED") return "RUN_ABORTED";
  if (error?.code === "AUTHORITATIVE_STORAGE_READ_FAILED") {
    return "AUTHORITATIVE_STORAGE_READ_FAILED";
  }
  if (error?.code === "LEGACY_PROJECTION_FAILED") {
    return "LEGACY_PROJECTION_FAILED";
  }
  if (phase === "cache_lookup" && [
    "POINT_IDENTITY_CONFLICT", "CACHE_RECORD_INVALID", "POINT_ID_COLLISION"
  ].includes(error?.code)) return "CACHE_POINT_CONFLICT";
  const byPhase = {
    cache_lookup: "CACHE_LOOKUP_FAILED",
    cache_replay_verification: "CACHE_REPLAY_VERIFICATION_FAILED",
    exact_discovery: "EXACT_DISCOVERY_FAILED",
    clustering: "CLUSTERING_FAILED",
    temporal_provenance: "TEMPORAL_PROVENANCE_FAILED",
    qwen_synthesis: "QWEN_SYNTHESIS_FAILED",
    result_normalization: "RESULT_VALIDATION_FAILED"
  };
  return byPhase[phase] || "INTERNAL_RUNTIME_ERROR";
}

function createShadowRunFailure(error, phase, metrics, signal) {
  const failurePhase = error?.code === "AUTHORITATIVE_STORAGE_READ_FAILED"
    ? "authoritative_read"
    : error?.code === "LEGACY_PROJECTION_FAILED"
      ? "legacy_projection"
      : phase;
  const failure = new Error("Hippocampus SHADOW run failed");
  failure.name = "HippocampusShadowRunError";
  failure.code = shadowFailureReason(error, phase, signal);
  failure.phase = failurePhase;
  failure.retryable = false;
  failure.shadowFailure = Object.freeze({
    reasonCode: failure.code,
    failurePhase,
    candidateCount: metrics.candidateCount,
    cacheHitCount: metrics.cacheHitCount,
    cacheCreatedCount: metrics.cacheCreatedCount,
    exactCertificateCount: metrics.exactCertificateCount,
    clusterCount: metrics.clusterCount,
    deferredComponentCount: metrics.deferredComponentCount,
    simulatedSuperMemoryCount: metrics.simulatedSuperMemoryCount,
    authoritativeMemoryReads: metrics.authoritativeMemoryReads,
    authoritativeMemoryWrites: 0,
    processingStateWrites: 0,
    commitCalls: 0,
    realDataModified: false,
    embeddingCacheModified: metrics.embeddingCacheModified,
    exclusionCounts: { ...metrics.exclusionCounts }
  });
  return failure;
}

function sourceFromMemory(memory, decision) {
  const projected = projectMemoryForCandidateSelection(memory);
  return {
    memoryId: decision.memoryId,
    text: projected.text,
    contentHash: decision.contentHash,
    timestamp: projected.timestamp,
    sourceContract: projected.sourceContract,
    lastAccess: memory.lastAccess ?? memory.orbital?.last_access ?? null,
    eventTimeEvidence: null,
    type: typeof memory.type === "string" ? memory.type : "unknown"
  };
}

function boundedBudgets(candidateCount) {
  const comparisons = Math.max(
    1,
    Math.min(500000, candidateCount * Math.max(1, candidateCount - 1) / 2)
  );
  return Object.freeze({
    neighborLimit: MAX_HITS_PER_QUERY,
    overfetchFactor: 1,
    scoreThreshold: DEFAULT_BOUNDED_CLUSTERING_POLICY.clusterThreshold,
    maxComponentVectorsInMemory: Math.max(1, Math.min(128, candidateCount)),
    maxPairwiseComparisons: Math.floor(comparisons),
    maxCandidateEdges: Math.max(
      1,
      Math.min(64000, candidateCount * MAX_HITS_PER_QUERY)
    ),
    maxClusterSize: Math.max(3, Math.min(128, candidateCount)),
    timeoutMs: QWEN_TIMEOUT_MS,
    maxRssDeltaBytes: 256 * 1024 * 1024
  });
}

const REAL_BOUNDED_PILOT_TOKEN = Symbol("real-bounded-pilot");

function createRealPipelineRunner(config, injections, pilotContext, token) {
  if (pilotContext !== null && token !== REAL_BOUNDED_PILOT_TOKEN) {
    fail("LIVE_RUNTIME_NOT_AUTHORIZED", EXIT_CODES.LIVE_NOT_AUTHORIZED);
  }
  return async ({ configuration, signal }) => {
    const startedAt = Date.now();
    const metrics = {
      candidateCount: 0,
      candidateCountVerified: 0,
      cacheLookupCount: 0,
      cacheHitCount: 0,
      cacheMissCount: 0,
      cacheCreatedCount: 0,
      neighborQueryCount: 0,
      exactCertificateCount: 0,
      clusterCount: 0,
      deferredComponentCount: 0,
      simulatedSuperMemoryCount: 0,
      authoritativeMemoryReads: 0,
      embeddingCacheModified: false,
      exclusionCounts: Object.fromEntries(
        EXCLUSION_COUNT_KEYS.map((key) => [key, 0])
      )
    };
    let failurePhase = "runtime";
    let hact9Context = {
      failurePhase: "AUTHORITATIVE_READ",
      failureProvider: "AUTHORITATIVE_STORAGE",
      failureOperation: "LOAD_CANDIDATES",
      lastCompletedPhase: "PREFLIGHT"
    };
    const enter = (phase, provider, operation) => {
      hact9Context = {
        ...hact9Context,
        failurePhase: phase,
        failureProvider: provider,
        failureOperation: operation
      };
    };
    const complete = (phase) => { hact9Context.lastCompletedPhase = phase; };
    let storage = null;
    try {
      if (!config.complete) fail("INVALID_RUNTIME_CONFIGURATION");
      storage = createReadOnlyAuthoritativeStorage(config.dataDir);
      failurePhase = "authoritative_read";
      enter("AUTHORITATIVE_READ", "AUTHORITATIVE_STORAGE", "LOAD_CANDIDATES");
      const projection = await storage.loadLegacyShadowCandidates({
      userId: configuration.userId,
      limit: configuration.maxCandidates,
      signal
    });
    metrics.authoritativeMemoryReads = storage.getAuthoritativeMemoryReads();
    metrics.exclusionCounts = { ...projection.stats.exclusionCounts };
    complete("AUTHORITATIVE_READ");
    failurePhase = "legacy_projection";
    enter("PROJECTION", "INTERNAL", "PROJECT_CANDIDATES");
    const memories = projection.records;
    const scalable = await buildConsolidationPlanScalable(memories, {
      allowLegacyUnclassified: false,
      maxCandidates: configuration.maxCandidates,
      batchSize: Math.max(1, Math.min(500, configuration.maxCandidates)),
      budget: {
        maxElapsedMs: 9500,
        maxRssDeltaBytes: 128 * 1024 * 1024
      },
      signal
    });
    const candidateIds = scalable.plan.candidateIds;
    metrics.candidateCount = candidateIds.length;
    metrics.candidateCountVerified = candidateIds.length;
    complete("PROJECTION");
    if (candidateIds.length === 0) {
      return {
        authoritativeMemoryReads: storage.getAuthoritativeMemoryReads(),
        candidateCount: 0,
        cacheHitCount: 0,
        cacheCreatedCount: 0,
        exactCertificateCount: 0,
        clusterCount: 0,
        deferredComponentCount: 0,
        simulatedSuperMemoryCount: 0,
        authoritativeMemoryWrites: 0,
        commitCalls: 0,
        realDataModified: false,
        embeddingCacheModified: false,
        exclusionCounts: projection.stats.exclusionCounts
      };
    }
    const memoryById = new Map(memories.map((memory) => [memory.id, memory]));
    const decisionById = new Map(scalable.plan.decisions.map((item) =>
      [item.memoryId, item]));
    const sources = candidateIds.map((memoryId) =>
      sourceFromMemory(memoryById.get(memoryId), decisionById.get(memoryId)));
    const counters = { cacheWrites: 0 };
    const rawQdrant = (injections.qdrantProviderFactory ||
      createQdrantEmbeddingCacheProvider)({
      endpoint: config.qdrant.endpoint,
      apiKey: config.qdrant.apiKey,
      timeoutMs: QDRANT_TIMEOUT_MS,
      maxResponseBytes: MAX_RESPONSE_BYTES,
      providerId: "hippocampus-hact3-shadow"
    });
    const qdrantProvider = controlledCacheProvider(rawQdrant, counters);
    const cacheAdapter = (injections.cacheAdapterFactory ||
      createHippocampusEmbeddingCacheAdapter)({ provider: qdrantProvider });
    failurePhase = "cache_lookup";
    enter("CACHE_LOOKUP", "QDRANT", "VERIFY_CACHE_COLLECTION");
    const lifecycle = await cacheAdapter.ensureCollection({
      allowCreate: false,
      signal
    });
    if (!lifecycle.ready) fail("EMBEDDING_CACHE_NOT_READY");
    complete("CACHE_LOOKUP");
    const rawEmbeddingProvider = (injections.embeddingProviderFactory ||
      createBgeM3EmbeddingProvider)({
      baseUrl: config.embedding.embeddingUrl,
      apiKey: config.embedding.embeddingApiKey,
      timeoutMs: QWEN_TIMEOUT_MS,
      maxResponseBytes: MAX_RESPONSE_BYTES,
      fetchImpl: injections.fetchImpl || globalThis.fetch
    });
    const embeddingProvider = Object.freeze({
      ...rawEmbeddingProvider,
      async embedBatch(request) {
        enter("EMBEDDING_MATERIALIZATION", "BGE_M3", "EMBED_BATCH");
        return rawEmbeddingProvider.embedBatch(request);
      }
    });
    const coordinator = createBgeM3EmbeddingCacheCoordinator({
      cacheAdapter: Object.freeze({
        async getValidEmbedding(request) {
          enter("CACHE_LOOKUP", "QDRANT", "GET_VALID_EMBEDDING");
          metrics.cacheLookupCount += 1;
          const result = await cacheAdapter.getValidEmbedding(request);
          if (result.status === "hit") {
            metrics.cacheHitCount += 1;
          } else {
            metrics.cacheMissCount += 1;
            if (pilotContext?.readOnly === true) fail("CACHE_MISS_READ_ONLY");
          }
          return result;
        },
        async upsertEmbedding(request) {
          if (pilotContext?.readOnly === true) fail("CACHE_WRITE_FORBIDDEN");
          failurePhase = "cache_replay_verification";
          const result = await cacheAdapter.upsertEmbedding(request);
          if (result.created) {
            metrics.cacheCreatedCount += 1;
            metrics.embeddingCacheModified = true;
          }
          failurePhase = "cache_lookup";
          return result;
        }
      }),
      embeddingProvider,
      embeddingBatchSize: Math.max(1, Math.min(64, candidateIds.length)),
      model: EMBEDDING_CACHE_MODEL,
      revision: EMBEDDING_CACHE_REVISION
    });
    const embeddingCoordinator = {
      async materialize(request) {
        failurePhase = "cache_lookup";
        const result = await coordinator.materialize(request);
        metrics.cacheHitCount = result.hitCount;
        metrics.cacheCreatedCount = result.createdCount;
        complete("EMBEDDING_MATERIALIZATION");
        failurePhase = "exact_discovery";
        return result;
      },
      async resolveEmbedding(request) {
        enter("CACHE_LOOKUP", "QDRANT", "GET_VALID_EMBEDDING");
        metrics.cacheLookupCount += 1;
        const lookup = await cacheAdapter.getValidEmbedding({
          userId: request.userId,
          memoryId: request.identity.memoryId,
          contentHash: request.identity.contentHash,
          model: request.identity.model,
          revision: request.identity.revision,
          signal: request.signal
        });
        if (lookup.status !== "hit") fail("EMBEDDING_UNAVAILABLE");
        metrics.cacheHitCount += 1;
        return {
          vector: lookup.embedding,
          provenance: {
            cacheSchemaVersion: EMBEDDING_CACHE_SCHEMA_VERSION,
            identitySnapshotFingerprint:
              request.identitySnapshotFingerprint,
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
    const rawSynthesisProvider = (injections.synthesisProviderFactory ||
      createOllamaSynthesisProvider)({
      baseUrl: config.qwenUrl,
      model: EXPECTED_QWEN_MODEL,
      timeoutMs: config.qwenTimeoutMs,
      maxResponseBytes: QWEN_MAX_RESPONSE_BYTES,
      keepAlive: "5m",
      fetchImpl: injections.fetchImpl || globalThis.fetch
    });
    const synthesisProvider = Object.freeze({
      ...rawSynthesisProvider,
      async generate(request) {
        failurePhase = "qwen_synthesis";
        enter("QWEN_SYNTHESIS", "QWEN", "GENERATE_SYNTHESIS");
        const generated = await rawSynthesisProvider.generate(request);
        complete("QWEN_SYNTHESIS");
        return generated;
      }
    });
    const budgets = boundedBudgets(candidateIds.length);
    const pipeline = createHippocampusBoundedPipelineAdapter({
      sourceResolver: {
        async resolveSnapshotSources() {
          return { userId: configuration.userId, sources };
        },
        async rereadSources({ memoryIds, signal: rereadSignal }) {
          enter("AUTHORITATIVE_READ", "AUTHORITATIVE_STORAGE", "REREAD_CLUSTER_SOURCES");
          const rereadProjection = await storage.rereadLegacyShadowCandidates({
            userId: configuration.userId,
            memoryIds,
            signal: rereadSignal
          });
          const reread = rereadProjection.records;
          const rereadById = new Map(reread.map((memory) =>
            [memory.id, memory]));
          complete("AUTHORITATIVE_READ");
          return memoryIds.map((memoryId) =>
            sourceFromMemory(
              rereadById.get(memoryId),
              decisionById.get(memoryId)
            ));
        }
      },
      embeddingCoordinator,
      exactDiscoveryProvider: {
        create(context) {
          const created = createQdrantExactThresholdDiscoveryProvider({
            qdrantProvider,
            ...context,
            maxHitsPerQuery: MAX_HITS_PER_QUERY,
            timeoutMs: QDRANT_TIMEOUT_MS,
            maxResponseBytes: MAX_RESPONSE_BYTES
          });
          return Object.freeze({
            ...created,
            async discoverNeighbors(request) {
              enter("EXACT_DISCOVERY", "QDRANT", "QUERY_NEIGHBORS");
              metrics.neighborQueryCount += 1;
              const discovered = await created.discoverNeighbors(request);
              if (discovered.certificate) metrics.exactCertificateCount += 1;
              return discovered;
            }
          });
        }
      },
      graphBuilder: {
        create({ discoveryProvider, budgets: graphBudgets }) {
          const builder = createHippocampusCandidateGraphBuilder({
            discoveryProvider,
            maxNeighborQueries: candidateIds.length,
            maxCandidateEdges: graphBudgets.maxCandidateEdges,
            timeoutMs: graphBudgets.timeoutMs
          });
          return {
            async build(request) {
              failurePhase = "exact_discovery";
              const graph = await builder.build(request);
              complete("EXACT_DISCOVERY");
              return graph;
            }
          };
        }
      },
      refiner: {
        create() {
          const created = createHippocampusBoundedCompleteLinkRefiner({
            embeddingResolver: {
              cacheSchemaVersion: EMBEDDING_CACHE_SCHEMA_VERSION,
              resolveEmbedding(request) {
                return embeddingCoordinator.resolveEmbedding({
                  userId: configuration.userId,
                  ...request
                });
              }
            },
            rssReader: {
              readRssBytes: () => process.memoryUsage().rss
            },
            clock: { now: Date.now }
          });
          return {
            async refine(request) {
              failurePhase = "clustering";
              enter("BOUNDED_REFINEMENT", "INTERNAL", "REFINE_CLUSTERS");
              const refined = await created.refine(request);
              metrics.clusterCount = refined.clusters.length;
              complete("BOUNDED_REFINEMENT");
              return refined;
            }
          };
        }
      },
      temporalProvenance: {
        createClusterProvenance(request) {
          failurePhase = "temporal_provenance";
          enter("TEMPORAL_PROVENANCE", "INTERNAL", "BUILD_TEMPORAL_PROVENANCE");
          return createTemporalClusterProvenance(request);
        },
        createSynthesisRequest(request) {
          failurePhase = "temporal_provenance";
          const temporal = createTemporalSynthesisRequest(request);
          complete("TEMPORAL_PROVENANCE");
          return temporal;
        }
      },
      synthesisProvider,
      synthesisLimits: {
        timeoutMs: config.qwenTimeoutMs,
        maxInputChars: 120000,
        maxOutputChars: 30000,
        maxTitleChars: 300,
        maxSynthesisChars: 12000,
        maxFactItems: 200,
        maxUncertaintyItems: 100,
        maxContradictionItems: 100
      },
      superMemoryValidator: {
        create(request) {
          failurePhase = "result_normalization";
          enter("ARTIFACT_DELIVERY", "INTERNAL", "FINALIZE_ARTIFACT");
          return createSuperMemoryRecord(request);
        },
        validate(request) {
          failurePhase = "result_normalization";
          enter("ARTIFACT_DELIVERY", "INTERNAL", "FINALIZE_ARTIFACT");
          return validateSuperMemoryRecord(request);
        }
      },
      clock: { now: Date.now }
    });
    const pipelineInput = {
      budgets,
      constraints: {
        language: "it",
        preserveUncertainty: true,
        preserveContradictions: true
      },
      processingAttemptId: "hact3-shadow-attempt-v1",
      signal
    };
    const result = pilotContext === null
      ? await pipeline.run(pipelineInput)
      : await (async () => {
        enter("ARTIFACT_DELIVERY", "INTERNAL", "FINALIZE_ARTIFACT");
        const artifact = await pipeline.runFirstFinalizable({
          ...pipelineInput,
          processingAttemptId: pilotContext.processingAttemptId
        }, pilotContext.artifactContext);
        complete("ARTIFACT_DELIVERY");
        return artifact;
      })();
    if (pilotContext !== null) {
      return {
        ...result,
        authoritativeMemoryReads: storage.getAuthoritativeMemoryReads(),
        candidateCountVerified: metrics.candidateCountVerified,
        cacheLookupCount: metrics.cacheLookupCount,
        cacheHitCount: metrics.cacheHitCount,
        cacheMissCount: metrics.cacheMissCount,
        neighborQueryCount: metrics.neighborQueryCount,
        exactCertificateCount: metrics.exactCertificateCount,
        clusterCount: metrics.clusterCount
      };
    }
    failurePhase = "result_normalization";
    metrics.authoritativeMemoryReads = storage.getAuthoritativeMemoryReads();
    metrics.cacheHitCount = result.cache.hit;
    metrics.cacheCreatedCount = result.cache.created;
    metrics.exactCertificateCount = result.exactCertificateCount;
    metrics.clusterCount = result.clusterCount;
    metrics.deferredComponentCount = result.components.deferred;
    metrics.simulatedSuperMemoryCount =
      result.temporarySuperMemoryValid ? result.clusterCount : 0;
    metrics.embeddingCacheModified = counters.cacheWrites > 0;
    return {
      authoritativeMemoryReads: storage.getAuthoritativeMemoryReads(),
      candidateCount: candidateIds.length,
      cacheHitCount: result.cache.hit,
      cacheCreatedCount: result.cache.created + result.cache.replay,
      exactCertificateCount: result.exactCertificateCount,
      clusterCount: result.clusterCount,
      deferredComponentCount: result.components.deferred,
      simulatedSuperMemoryCount:
        result.temporarySuperMemoryValid ? result.clusterCount : 0,
      authoritativeMemoryWrites: 0,
      commitCalls: 0,
      realDataModified: false,
      embeddingCacheModified: counters.cacheWrites > 0,
      exclusionCounts: Object.fromEntries(
        EXCLUSION_COUNT_KEYS.map((key) =>
          [key, projection.stats.exclusionCounts[key]])
      )
    };
    } catch (error) {
      if (storage) {
        metrics.authoritativeMemoryReads = storage.getAuthoritativeMemoryReads();
      }
      if (pilotContext !== null) {
        const wrapped = new Error("Hippocampus bounded pilot run failed");
        wrapped.name = "HippocampusBoundedPilotRunError";
        wrapped.code = typeof error?.code === "string" &&
          /^[A-Z][A-Z0-9_]*$/.test(error.code)
          ? error.code : "BOUNDED_PILOT_FAILED";
        wrapped.retryable = false;
        wrapped.hact9Failure = sanitizeHact9Failure({
          ...hact9Context,
          elapsedMsAtFailure: Date.now() - startedAt,
          candidateCountVerified: metrics.candidateCountVerified,
          cacheLookupCount: metrics.cacheLookupCount,
          cacheHitCount: metrics.cacheHitCount,
          cacheMissCount: metrics.cacheMissCount,
          neighborQueryCount: metrics.neighborQueryCount,
          exactCertificateCount: metrics.exactCertificateCount,
          clusterCount: metrics.clusterCount
        });
        throw wrapped;
      }
      throw createShadowRunFailure(error, failurePhase, metrics, signal);
    }
  };
}

function createRealShadowRunner(config, injections = {}) {
  return createRealPipelineRunner(config, injections, null, null);
}

function createRealBoundedPilotRunner(config, injections, pilotContext) {
  if (!isPlainObject(pilotContext) ||
      typeof pilotContext.processingAttemptId !== "string" ||
      !isPlainObject(pilotContext.artifactContext) ||
      pilotContext.readOnly !== undefined && typeof pilotContext.readOnly !== "boolean") {
    fail("BOUNDED_PILOT_ARTIFACT_BOUNDARY_UNAVAILABLE", EXIT_CODES.LIVE_NOT_AUTHORIZED);
  }
  return createRealPipelineRunner(
    config, injections || {}, pilotContext, REAL_BOUNDED_PILOT_TOKEN
  );
}

function createDefaultRuntime({ configuration, env, injections }) {
  const config = runtimeEnvironment(env);
  return createHippocampusRuntime({
    configuration,
    evaluatePreflight: createRealPreflightEvaluator(config, injections),
    runShadow: configuration.operation === RUNTIME_OPERATIONS.RUN_ONCE
      ? createRealShadowRunner(config, injections)
      : undefined
  });
}

function sanitizedFailure(error) {
  const code = typeof error?.code === "string" &&
    /^[A-Z][A-Z0-9_]*$/.test(error.code)
    ? error.code
    : "HIPPOCAMPUS_CLI_FAILURE";
  return {
    status: code === "LIVE_RUNTIME_NOT_AUTHORIZED"
      ? "LIVE_RUNTIME_NOT_AUTHORIZED"
      : "FAILED",
    mode: code === "LIVE_RUNTIME_NOT_AUTHORIZED" ? "LIVE" : "OFF",
    preflight: "NOT_RUN",
    candidateCount: 0,
    cacheHitCount: 0,
    cacheCreatedCount: 0,
    exactCertificateCount: 0,
    clusterCount: 0,
    deferredComponentCount: 0,
    simulatedSuperMemoryCount: 0,
    authoritativeMemoryWrites: 0,
    commitCalls: 0,
    realDataModified: false,
    embeddingCacheModified: false,
    durationMs: 0,
    reasonCode: code
  };
}

function exitCodeFor(report) {
  if (["OFF", "SHADOW_IDLE", "SHADOW_PREFLIGHT_PASSED",
    "SHADOW_SUCCEEDED"].includes(report.status)) {
    return EXIT_CODES.SUCCESS;
  }
  if (report.status === "SHADOW_PREFLIGHT_FAILED") {
    return EXIT_CODES.PREFLIGHT_FAILED;
  }
  if (report.status === "SHADOW_ABORTED") return EXIT_CODES.RUN_ABORTED;
  if (report.status === "LIVE_RUNTIME_NOT_AUTHORIZED") {
    return EXIT_CODES.LIVE_NOT_AUTHORIZED;
  }
  return EXIT_CODES.RUN_FAILED;
}

async function executeCli(options = {}) {
  const args = options.args || [];
  const env = options.env || {};
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  const signalSource = options.signalSource || process;
  const runtimeFactory = options.runtimeFactory || createDefaultRuntime;
  let runtime = null;
  let stopPromise = null;
  let stopRequested = false;
  let report;
  let explicitExitCode = null;
  const requestStop = () => {
    if (stopRequested || runtime === null) return;
    stopRequested = true;
    stopPromise = Promise.resolve(runtime.stop()).catch(() => null);
  };
  try {
    const configuration = parseArguments(args);
    runtime = runtimeFactory({
      configuration,
      env,
      injections: options.injections || {}
    });
    signalSource.on("SIGINT", requestStop);
    signalSource.on("SIGTERM", requestStop);
    if (configuration.operation === RUNTIME_OPERATIONS.STATUS) {
      report = runtime.getStatus();
    } else if (configuration.operation === RUNTIME_OPERATIONS.PREFLIGHT_ONLY) {
      report = await runtime.preflightOnly();
    } else {
      report = await runtime.runOnce();
    }
    if (stopPromise) await stopPromise;
  } catch (error) {
    report = sanitizedFailure(error);
    explicitExitCode = error instanceof HippocampusCliError
      ? error.exitCode
      : error?.code === "LIVE_RUNTIME_NOT_AUTHORIZED"
        ? EXIT_CODES.LIVE_NOT_AUTHORIZED
        : EXIT_CODES.INVALID_ARGUMENTS;
    if (options.diagnostics === true) {
      stderr.write(`${JSON.stringify({
        phase: typeof error?.phase === "string" &&
          /^[a-z][a-z0-9_]*$/.test(error.phase)
          ? error.phase
          : "cli",
        reasonCode: report.reasonCode
      })}\n`);
    }
  } finally {
    signalSource.removeListener?.("SIGINT", requestStop);
    signalSource.removeListener?.("SIGTERM", requestStop);
  }
  stdout.write(`${JSON.stringify(report)}\n`);
  return explicitExitCode ?? exitCodeFor(report);
}

if (require.main === module) {
  executeCli({
    args: process.argv.slice(2),
    env: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
    signalSource: process
  }).then((exitCode) => {
    process.exitCode = exitCode;
  }).catch(() => {
    process.stdout.write(`${JSON.stringify(
      sanitizedFailure({ code: "HIPPOCAMPUS_CLI_FAILURE" })
    )}\n`);
    process.exitCode = EXIT_CODES.RUN_FAILED;
  });
}

module.exports = {
  MAX_CANDIDATES,
  EXIT_CODES,
  HippocampusCliError,
  parseArguments,
  runtimeEnvironment,
  createReadOnlyAuthoritativeStorage,
  createRealPreflightEvaluator,
  createRealShadowRunner,
  createRealBoundedPilotRunner,
  createDefaultRuntime,
  executeCli
};
