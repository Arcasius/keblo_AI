import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  buildRecallRequest,
  createLegacyRecallAdapter,
  createRecallRouter,
  detectMemoryContract,
  normalizeMemory
} = require("../../../packages/memoria-orbitale");

const ADAPTER_SCHEMA_VERSION = 1;
const ALLOWED_TIERS = Object.freeze(["core", "warm"]);

export class KebloReadOnlyRecallAdapterError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "KebloReadOnlyRecallAdapterError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new KebloReadOnlyRecallAdapterError(code, message);
}

function validateUserId(userId) {
  if (typeof userId !== "string" || userId.trim().length === 0 || userId !== userId.trim()) {
    fail("INVALID_USER_ID", "userId must be an explicit non-empty trimmed string");
  }
  return userId;
}

function validateReader(reader) {
  if (!reader || typeof reader !== "object" || Array.isArray(reader) ||
      typeof reader.searchReadOnly !== "function") {
    fail("MISSING_STORAGE_READER", "storageReader.searchReadOnly is required");
  }
  return reader;
}

function validateSearchRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    fail("INVALID_SEARCH_REQUEST", "search request must be an object");
  }
  const allowed = new Set(["query", "tier", "limit", "mutate"]);
  if (Object.keys(request).some((key) => !allowed.has(key))) {
    fail("INVALID_SEARCH_REQUEST", "search request contains unsupported properties");
  }
  if (request.mutate !== false) {
    fail("MUTATION_FORBIDDEN", "search requires mutate: false");
  }
  if (typeof request.query !== "string" || request.query.trim().length === 0) {
    fail("INVALID_QUERY", "query must be non-empty");
  }
  if (!ALLOWED_TIERS.includes(request.tier)) {
    fail("INVALID_TIER", "tier must be core or warm");
  }
  if (!Number.isInteger(request.limit) || request.limit <= 0) {
    fail("INVALID_LIMIT", "limit must be a positive integer");
  }
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)]));
  }
  return value;
}

function isCanonicalMemory(memory, tier) {
  const sourceContract = detectMemoryContract(memory);
  if (sourceContract === "unknown") return false;
  const normalized = normalizeMemory(memory);
  if (typeof normalized.id !== "string" || normalized.id.trim().length === 0 ||
      typeof normalized.content.text !== "string" || normalized.content.text.length === 0) {
    return false;
  }
  if (tier === "core") {
    if (normalized.memoryKind !== "super_memory" || normalized.storageTier !== "core") return false;
    const sourceIds = memory.source_memory_ids;
    return Array.isArray(sourceIds) &&
      sourceIds.every((id) => typeof id === "string" && id.length > 0) &&
      new Set(sourceIds).size === sourceIds.length;
  }
  return normalized.memoryKind === "raw" && normalized.storageTier === "warm";
}

function readEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const memory = entry.memory;
  const score = entry.score;
  if (!memory || typeof memory !== "object" || Array.isArray(memory) ||
      typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 1) {
    return null;
  }
  return { memory, score };
}

export function createKebloUserRecallAdapter({ userId, storageReader } = {}) {
  const boundUserId = validateUserId(userId);
  const reader = validateReader(storageReader);
  const metrics = {
    searches: 0,
    scanned: 0,
    accepted: 0,
    excludedMalformed: 0,
    excludedIncompatible: 0
  };

  async function searchCanonical(request) {
    validateSearchRequest(request);
    metrics.searches += 1;
    const entries = await reader.searchReadOnly(Object.freeze({
      schemaVersion: ADAPTER_SCHEMA_VERSION,
      userId: boundUserId,
      query: request.query,
      tier: request.tier,
      limit: request.limit,
      mutate: false
    }));
    if (!Array.isArray(entries)) {
      fail("INVALID_READER_RESULT", "storage reader must return an array");
    }

    const accepted = [];
    for (const candidate of entries) {
      metrics.scanned += 1;
      const entry = readEntry(candidate);
      if (!entry) {
        metrics.excludedMalformed += 1;
        continue;
      }
      let compatible = false;
      try {
        compatible = isCanonicalMemory(entry.memory, request.tier);
      } catch {
        metrics.excludedMalformed += 1;
        continue;
      }
      if (!compatible) {
        metrics.excludedIncompatible += 1;
        continue;
      }
      metrics.accepted += 1;
      accepted.push({ ...clone(entry.memory), _score: entry.score });
    }
    return accepted;
  }

  const kebloMemory = Object.freeze({
    async recallReadOnly(requestUserId, query, options = {}) {
      if (requestUserId !== boundUserId) {
        fail("USER_SCOPE_VIOLATION", "reader cannot cross its bound user scope");
      }
      return searchCanonical({
        query,
        tier: options.tier,
        limit: options.limit,
        mutate: false
      });
    }
  });
  const retrievers = createLegacyRecallAdapter({ kebloMemory, userId: boundUserId });
  const router = createRecallRouter({
    coreRetriever: retrievers.coreRetriever,
    warmRetriever: retrievers.warmRetriever
  });

  return Object.freeze({
    schemaVersion: ADAPTER_SCHEMA_VERSION,
    userId: boundUserId,
    buildRequest: buildRecallRequest,
    recall(input) {
      return router.recall(buildRecallRequest(input));
    },
    search(request) {
      validateSearchRequest(request);
      return retrievers[`${request.tier}Retriever`].search(request);
    },
    getMetrics() {
      return Object.freeze({ schemaVersion: ADAPTER_SCHEMA_VERSION, ...metrics });
    }
  });
}
