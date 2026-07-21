"use strict";

const FAILURE_PHASES = Object.freeze([
  "PREFLIGHT", "AUTHORITATIVE_READ", "PROJECTION", "CACHE_LOOKUP",
  "EMBEDDING_MATERIALIZATION", "EXACT_DISCOVERY", "BOUNDED_REFINEMENT",
  "TEMPORAL_PROVENANCE", "QWEN_SYNTHESIS", "ARTIFACT_DELIVERY",
  "BACKUP", "COMMIT_PREPARE", "COMMIT", "RECALL_VERIFICATION"
]);
const FAILURE_PROVIDERS = Object.freeze([
  "AUTHORITATIVE_STORAGE", "QDRANT", "BGE_M3", "QWEN", "INTERNAL"
]);
const FAILURE_OPERATIONS = Object.freeze([
  "RUN_PREFLIGHT", "LOAD_CANDIDATES", "REREAD_CLUSTER_SOURCES", "PROJECT_CANDIDATES",
  "VERIFY_CACHE_COLLECTION", "GET_VALID_EMBEDDING", "EMBED_BATCH",
  "QUERY_NEIGHBORS", "REFINE_CLUSTERS", "BUILD_TEMPORAL_PROVENANCE",
  "GENERATE_SYNTHESIS", "FINALIZE_ARTIFACT", "CREATE_BACKUP",
  "PREPARE_COMMIT", "COMMIT_TRANSACTION", "VERIFY_RECALL"
]);
const PHASE_SET = new Set(FAILURE_PHASES);
const PROVIDER_SET = new Set(FAILURE_PROVIDERS);
const OPERATION_SET = new Set(FAILURE_OPERATIONS);
const METRIC_KEYS = Object.freeze([
  "candidateCountVerified", "cacheLookupCount", "cacheHitCount",
  "cacheMissCount", "neighborQueryCount", "exactCertificateCount",
  "clusterCount"
]);

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function sanitizeHact9Failure(value, fallback) {
  const source = value && typeof value === "object" ? value : {};
  const base = fallback && typeof fallback === "object" ? fallback : {};
  const pick = (set, candidate, alternate) => set.has(candidate)
    ? candidate : set.has(alternate) ? alternate : null;
  const failurePhase = pick(PHASE_SET, source.failurePhase, base.failurePhase);
  const failureProvider = pick(
    PROVIDER_SET, source.failureProvider, base.failureProvider
  );
  const failureOperation = pick(
    OPERATION_SET, source.failureOperation, base.failureOperation
  );
  const completed = source.lastCompletedPhase === "NONE"
    ? "NONE"
    : pick(PHASE_SET, source.lastCompletedPhase, base.lastCompletedPhase) || "NONE";
  const sanitized = {
    failurePhase: failurePhase || "ARTIFACT_DELIVERY",
    failureProvider: failureProvider || "INTERNAL",
    failureOperation: failureOperation || "FINALIZE_ARTIFACT",
    lastCompletedPhase: completed,
    elapsedMsAtFailure: count(source.elapsedMsAtFailure ?? base.elapsedMsAtFailure)
  };
  for (const key of METRIC_KEYS) sanitized[key] = count(source[key] ?? base[key]);
  return Object.freeze(sanitized);
}

module.exports = {
  FAILURE_PHASES,
  FAILURE_PROVIDERS,
  FAILURE_OPERATIONS,
  METRIC_KEYS,
  sanitizeHact9Failure
};
