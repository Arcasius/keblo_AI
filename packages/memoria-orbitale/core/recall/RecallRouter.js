"use strict";

const { createHash } = require("node:crypto");
const { normalizeMemory } = require("../MemoryContractNormalizer");

const RECALL_ROUTER_SCHEMA_VERSION = 1;

function deepFreeze(value) {
  Object.freeze(value);
  for (const child of Object.values(value)) {
    if (child && typeof child === "object" && !Object.isFrozen(child)) deepFreeze(child);
  }
  return value;
}

const RECALL_MODES = deepFreeze({ DEFAULT: "default", FULL_HISTORY: "full-history" });
const RECALL_TIERS = deepFreeze({ CORE: "core", WARM: "warm", DEEP: "deep" });
const RECALL_REASON_CODES = deepFreeze({
  CORE_SELECTED: "CORE_SELECTED",
  WARM_SELECTED: "WARM_SELECTED",
  DEEP_EXPLICIT: "DEEP_EXPLICIT",
  DEEP_FULL_HISTORY: "DEEP_FULL_HISTORY",
  DEEP_FALLBACK_LOW_COUNT: "DEEP_FALLBACK_LOW_COUNT",
  DEEP_FALLBACK_LOW_SCORE: "DEEP_FALLBACK_LOW_SCORE",
  DEEP_NOT_REQUESTED: "DEEP_NOT_REQUESTED",
  INVALID_RESULT: "INVALID_RESULT",
  INVALID_SCORE: "INVALID_SCORE",
  TIER_MISMATCH: "TIER_MISMATCH",
  INCOMPATIBLE_MEMORY_KIND: "INCOMPATIBLE_MEMORY_KIND",
  DUPLICATE_ID_SUPPRESSED: "DUPLICATE_ID_SUPPRESSED",
  DUPLICATE_CONTENT_SUPPRESSED: "DUPLICATE_CONTENT_SUPPRESSED",
  SOURCE_COVERED_BY_SUPER_MEMORY: "SOURCE_COVERED_BY_SUPER_MEMORY",
  FINAL_LIMIT_APPLIED: "FINAL_LIMIT_APPLIED"
});
const DEFAULT_RECALL_POLICY = deepFreeze({
  schemaVersion: 1,
  suppressCoveredSources: true
});
const TIER_PRIORITY = Object.freeze({ core: 0, warm: 1, deep: 2 });

class RecallRouterError extends Error {
  constructor(code, phase, message, details = {}) {
    super(message);
    this.name = "RecallRouterError";
    this.code = code;
    this.phase = phase;
    Object.assign(this, details);
  }
}

function fail(code, phase, message, details) {
  throw new RecallRouterError(code, phase, message, details);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (isPlainObject(value)) return Object.fromEntries(Object.keys(value).map((key) => [key, clone(value[key])]));
  return value;
}

function assertAllowedKeys(value, allowed, label, phase = "configuration") {
  if (!isPlainObject(value)) fail("INVALID_REQUEST", phase, `${label} must be a plain object`);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail("INVALID_REQUEST", phase, `${label} contains an unsupported property`);
  }
}

function validateRetriever(retriever, label, required) {
  if (retriever === undefined && !required) return null;
  if (!isPlainObject(retriever)) fail("MISSING_RETRIEVER", "configuration", `${label} is required`, { tier: label });
  if (retriever.schemaVersion !== 1 || typeof retriever.id !== "string" || retriever.id.trim().length === 0 ||
      typeof retriever.search !== "function") {
    fail("INVALID_RETRIEVER", "configuration", `${label} does not satisfy retriever V1`, { tier: label });
  }
  return retriever;
}

function validatePolicy(policy) {
  if (policy === undefined) return { ...DEFAULT_RECALL_POLICY };
  assertAllowedKeys(policy, ["schemaVersion", "suppressCoveredSources"], "policy");
  const merged = { ...DEFAULT_RECALL_POLICY, ...policy };
  if (merged.schemaVersion !== 1 || typeof merged.suppressCoveredSources !== "boolean") {
    fail("INVALID_POLICY", "configuration", "Recall policy is invalid");
  }
  return merged;
}

function validateFallback(value) {
  if (value === undefined) return { enabled: false, minResults: null, minBestScore: null };
  assertAllowedKeys(value, ["enabled", "minResults", "minBestScore"], "deepFallback", "request");
  const fallback = {
    enabled: value.enabled === undefined ? false : value.enabled,
    minResults: value.minResults === undefined ? null : value.minResults,
    minBestScore: value.minBestScore === undefined ? null : value.minBestScore
  };
  if (typeof fallback.enabled !== "boolean") fail("INVALID_REQUEST", "request", "deepFallback.enabled must be boolean");
  if (fallback.minResults !== null && (!Number.isInteger(fallback.minResults) || fallback.minResults < 1)) {
    fail("INVALID_REQUEST", "request", "deepFallback.minResults must be null or integer >= 1");
  }
  if (fallback.minBestScore !== null && (typeof fallback.minBestScore !== "number" ||
      !Number.isFinite(fallback.minBestScore) || fallback.minBestScore < 0 || fallback.minBestScore > 1)) {
    fail("INVALID_REQUEST", "request", "deepFallback.minBestScore must be null or finite in [0,1]");
  }
  if (fallback.enabled && fallback.minResults === null && fallback.minBestScore === null) {
    fail("INVALID_REQUEST", "request", "Enabled deep fallback requires a threshold");
  }
  return fallback;
}

function validateRequest(request) {
  assertAllowedKeys(request, ["query", "mode", "includeDeep", "limit", "deepFallback"], "request", "request");
  if (typeof request.query !== "string" || request.query.trim().length === 0) {
    fail("INVALID_REQUEST", "request", "query must be a non-empty string");
  }
  const mode = request.mode === undefined ? RECALL_MODES.DEFAULT : request.mode;
  if (!Object.values(RECALL_MODES).includes(mode)) fail("INVALID_REQUEST", "request", "mode is invalid");
  const includeDeep = request.includeDeep === undefined ? false : request.includeDeep;
  if (typeof includeDeep !== "boolean") fail("INVALID_REQUEST", "request", "includeDeep must be boolean");
  if (!Number.isInteger(request.limit) || request.limit <= 0) {
    fail("INVALID_REQUEST", "request", "limit must be a positive integer");
  }
  return { query: request.query, mode, includeDeep, limit: request.limit, deepFallback: validateFallback(request.deepFallback) };
}

function hashText(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function invalidDescriptor(reasonCode, tier, retrieverId, index, id = null, code = null) {
  return { reasonCode, tier, retrieverId, index, id, code };
}

function selectionReason(tier, deepReasons) {
  if (tier === RECALL_TIERS.CORE) return RECALL_REASON_CODES.CORE_SELECTED;
  if (tier === RECALL_TIERS.WARM) return RECALL_REASON_CODES.WARM_SELECTED;
  return deepReasons[0] || RECALL_REASON_CODES.DEEP_EXPLICIT;
}

function validateResult(item, tier, retrieverId, index, deepReasons) {
  if (!isPlainObject(item) || !isPlainObject(item.memory) || typeof item.id !== "string" || item.id.trim().length === 0) {
    return { invalid: invalidDescriptor(RECALL_REASON_CODES.INVALID_RESULT, tier, retrieverId, index) };
  }
  if (typeof item.score !== "number" || !Number.isFinite(item.score) || item.score < 0 || item.score > 1) {
    return { invalid: invalidDescriptor(RECALL_REASON_CODES.INVALID_SCORE, tier, retrieverId, index, item.id) };
  }
  if (item.retrievalTier !== tier) {
    return { invalid: invalidDescriptor(RECALL_REASON_CODES.TIER_MISMATCH, tier, retrieverId, index, item.id) };
  }
  let normalized;
  try { normalized = normalizeMemory(item.memory); } catch {
    return { invalid: invalidDescriptor(RECALL_REASON_CODES.INVALID_RESULT, tier, retrieverId, index, item.id) };
  }
  if (normalized.id !== item.id || typeof normalized.content.text !== "string") {
    return { invalid: invalidDescriptor(RECALL_REASON_CODES.INVALID_RESULT, tier, retrieverId, index, item.id) };
  }
  const kind = normalized.memoryKind;
  const storageTier = normalized.storageTier;
  const compatible = tier === RECALL_TIERS.CORE
    ? kind === "super_memory" && storageTier === "core"
    : tier === RECALL_TIERS.WARM
      ? storageTier === "warm" && ["raw", "episodic", "semantic", "structural"].includes(kind)
      : storageTier === "deep" && kind !== "super_memory";
  if (!compatible) {
    const tierMismatch = storageTier !== tier;
    return { invalid: invalidDescriptor(
      tierMismatch ? RECALL_REASON_CODES.TIER_MISMATCH : RECALL_REASON_CODES.INCOMPATIBLE_MEMORY_KIND,
      tier, retrieverId, index, item.id
    ) };
  }
  const sourceMemoryIds = kind === "super_memory" && Array.isArray(item.memory.source_memory_ids)
    ? [...item.memory.source_memory_ids]
    : [];
  if (sourceMemoryIds.some((id) => typeof id !== "string" || id.length === 0) ||
      new Set(sourceMemoryIds).size !== sourceMemoryIds.length) {
    return { invalid: invalidDescriptor(RECALL_REASON_CODES.INVALID_RESULT, tier, retrieverId, index, item.id) };
  }
  const text = normalized.content.text;
  return { result: {
    id: item.id,
    text,
    score: item.score,
    finalScore: item.score,
    retrievalTier: tier,
    memoryKind: kind,
    storageTier,
    timestamp: normalized.timestamps.createdAt,
    sourceMemoryIds,
    contentHash: hashText(text),
    retrieverId,
    reasonCodes: [selectionReason(tier, deepReasons)]
  } };
}

function compareResults(left, right) {
  return right.finalScore - left.finalScore ||
    TIER_PRIORITY[left.retrievalTier] - TIER_PRIORITY[right.retrievalTier] ||
    left.retrieverId.localeCompare(right.retrieverId) ||
    left.id.localeCompare(right.id);
}

function compareTechnical(left, right) {
  return left.reasonCode.localeCompare(right.reasonCode) ||
    (left.id || "").localeCompare(right.id || "") ||
    left.tier.localeCompare(right.tier) ||
    left.retrieverId.localeCompare(right.retrieverId) ||
    (left.index ?? 0) - (right.index ?? 0);
}

function dedupe(results) {
  const suppressed = [];
  const byId = new Map();
  for (const result of [...results].sort(compareResults)) {
    if (byId.has(result.id)) {
      suppressed.push({
        id: result.id, reasonCode: RECALL_REASON_CODES.DUPLICATE_ID_SUPPRESSED,
        keptId: byId.get(result.id).id, retrievalTier: result.retrievalTier,
        retrieverId: result.retrieverId
      });
    } else byId.set(result.id, result);
  }
  const byContent = new Map();
  for (const result of [...byId.values()].sort(compareResults)) {
    if (byContent.has(result.contentHash)) {
      suppressed.push({
        id: result.id, reasonCode: RECALL_REASON_CODES.DUPLICATE_CONTENT_SUPPRESSED,
        keptId: byContent.get(result.contentHash).id, retrievalTier: result.retrievalTier,
        retrieverId: result.retrieverId
      });
    } else byContent.set(result.contentHash, result);
  }
  return { results: [...byContent.values()], suppressed };
}

function suppressCovered(results, enabled) {
  if (!enabled) return { results, suppressed: [] };
  const coveredBy = new Map();
  for (const result of results) {
    if (result.retrievalTier === "core" && result.memoryKind === "super_memory") {
      for (const id of result.sourceMemoryIds) if (!coveredBy.has(id)) coveredBy.set(id, result.id);
    }
  }
  const kept = [];
  const suppressed = [];
  for (const result of results) {
    if (result.memoryKind !== "super_memory" && coveredBy.has(result.id)) {
      suppressed.push({
        id: result.id, reasonCode: RECALL_REASON_CODES.SOURCE_COVERED_BY_SUPER_MEMORY,
        keptId: coveredBy.get(result.id), retrievalTier: result.retrievalTier,
        retrieverId: result.retrieverId
      });
    } else kept.push(result);
  }
  return { results: kept, suppressed };
}

async function searchRetriever(retriever, tier, request) {
  try {
    const results = await retriever.search({
      query: request.query,
      tier,
      limit: request.limit,
      filters: Object.freeze({}),
      mutate: false
    });
    if (!Array.isArray(results)) fail("INVALID_RETRIEVER_RESULT", "retriever", "Retriever must return an array", { tier, retrieverId: retriever.id });
    return results;
  } catch (error) {
    if (error instanceof RecallRouterError) throw error;
    fail("RETRIEVER_FAILURE", "retriever", "Retriever failed", { tier, retrieverId: retriever.id });
  }
}

function createRecallRouter(options) {
  assertAllowedKeys(options, ["coreRetriever", "warmRetriever", "deepRetriever", "policy"], "options");
  const coreRetriever = validateRetriever(options.coreRetriever, RECALL_TIERS.CORE, true);
  const warmRetriever = validateRetriever(options.warmRetriever, RECALL_TIERS.WARM, true);
  const deepRetriever = validateRetriever(options.deepRetriever, RECALL_TIERS.DEEP, false);
  const policy = validatePolicy(options.policy);

  return Object.freeze({
    async recall(input) {
      const request = validateRequest(input);
      const explicitDeep = request.includeDeep || request.mode === RECALL_MODES.FULL_HISTORY;
      if (explicitDeep && !deepRetriever) {
        fail("MISSING_DEEP_RETRIEVER", "routing", "Deep recall requires an explicit retriever", { tier: RECALL_TIERS.DEEP });
      }
      const [coreRaw, warmRaw] = await Promise.all([
        searchRetriever(coreRetriever, RECALL_TIERS.CORE, request),
        searchRetriever(warmRetriever, RECALL_TIERS.WARM, request)
      ]);
      let deepRaw = [];
      let deepUsed = false;
      let deepReasons = [];
      const prevalidated = [];
      const invalidResults = [];
      for (const [tier, retriever, items] of [
        [RECALL_TIERS.CORE, coreRetriever, coreRaw],
        [RECALL_TIERS.WARM, warmRetriever, warmRaw]
      ]) {
        items.forEach((item, index) => {
          const checked = validateResult(item, tier, retriever.id, index, []);
          if (checked.invalid) invalidResults.push(checked.invalid);
          else prevalidated.push(checked.result);
        });
      }
      if (explicitDeep) {
        deepReasons = [request.mode === RECALL_MODES.FULL_HISTORY
          ? RECALL_REASON_CODES.DEEP_FULL_HISTORY
          : RECALL_REASON_CODES.DEEP_EXPLICIT];
      } else if (request.deepFallback.enabled) {
        const bestScore = prevalidated.length === 0 ? null : Math.max(...prevalidated.map(({ finalScore }) => finalScore));
        if (request.deepFallback.minResults !== null && prevalidated.length < request.deepFallback.minResults) {
          deepReasons.push(RECALL_REASON_CODES.DEEP_FALLBACK_LOW_COUNT);
        }
        if (request.deepFallback.minBestScore !== null && (bestScore === null || bestScore < request.deepFallback.minBestScore)) {
          deepReasons.push(RECALL_REASON_CODES.DEEP_FALLBACK_LOW_SCORE);
        }
      }
      if (deepReasons.length > 0) {
        if (!deepRetriever) fail("MISSING_DEEP_RETRIEVER", "routing", "Triggered deep recall requires a retriever", { tier: RECALL_TIERS.DEEP });
        try {
          deepRaw = await searchRetriever(deepRetriever, RECALL_TIERS.DEEP, request);
          deepUsed = true;
        } catch (error) {
          if (explicitDeep) throw error;
          invalidResults.push(invalidDescriptor(
            RECALL_REASON_CODES.INVALID_RESULT, RECALL_TIERS.DEEP, deepRetriever.id, -1, null, error.code
          ));
        }
      } else deepReasons = [RECALL_REASON_CODES.DEEP_NOT_REQUESTED];
      deepRaw.forEach((item, index) => {
        const checked = validateResult(item, RECALL_TIERS.DEEP, deepRetriever.id, index, deepReasons);
        if (checked.invalid) invalidResults.push(checked.invalid);
        else prevalidated.push(checked.result);
      });
      const validBeforeDedupe = prevalidated.length;
      const deduped = dedupe(prevalidated);
      const covered = suppressCovered(deduped.results, policy.suppressCoveredSources);
      const ranked = covered.results.sort(compareResults);
      const beforeFinalLimit = ranked.length;
      const truncated = beforeFinalLimit > request.limit;
      const results = ranked.slice(0, request.limit).map(clone);
      const suppressed = [...deduped.suppressed, ...covered.suppressed];
      if (truncated) {
        for (const item of ranked.slice(request.limit)) {
          suppressed.push({
            id: item.id, reasonCode: RECALL_REASON_CODES.FINAL_LIMIT_APPLIED,
            keptId: null, retrievalTier: item.retrievalTier, retrieverId: item.retrieverId
          });
        }
      }
      suppressed.sort((a, b) => compareTechnical(
        { ...a, tier: a.retrievalTier, index: 0 },
        { ...b, tier: b.retrievalTier, index: 0 }
      ));
      invalidResults.sort(compareTechnical);
      const invokedTiers = [RECALL_TIERS.CORE, RECALL_TIERS.WARM, ...(deepUsed ? [RECALL_TIERS.DEEP] : [])];
      const output = {
        schemaVersion: RECALL_ROUTER_SCHEMA_VERSION,
        query: request.query,
        mode: request.mode,
        readOnly: true,
        reinforcementApplied: false,
        routing: {
          requestedTiers: [RECALL_TIERS.CORE, RECALL_TIERS.WARM, ...(explicitDeep ? [RECALL_TIERS.DEEP] : [])],
          invokedTiers,
          deepRequested: explicitDeep,
          deepUsed,
          deepReasonCodes: [...deepReasons],
          suppressCoveredSources: policy.suppressCoveredSources,
          limit: request.limit,
          truncated
        },
        results,
        suppressed,
        invalidResults,
        stats: {
          coreReturned: coreRaw.length,
          warmReturned: warmRaw.length,
          deepReturned: deepRaw.length,
          validBeforeDedupe,
          duplicateIdCount: deduped.suppressed.filter(({ reasonCode }) => reasonCode === RECALL_REASON_CODES.DUPLICATE_ID_SUPPRESSED).length,
          duplicateContentCount: deduped.suppressed.filter(({ reasonCode }) => reasonCode === RECALL_REASON_CODES.DUPLICATE_CONTENT_SUPPRESSED).length,
          coveredSourceCount: covered.suppressed.length,
          beforeFinalLimit,
          finalCount: results.length
        },
        reinforcementPendingIds: results.map(({ id }) => id)
      };
      return deepFreeze(output);
    }
  });
}

module.exports = {
  RECALL_ROUTER_SCHEMA_VERSION,
  RECALL_MODES,
  RECALL_TIERS,
  RECALL_REASON_CODES,
  DEFAULT_RECALL_POLICY,
  RecallRouterError,
  createRecallRouter
};
