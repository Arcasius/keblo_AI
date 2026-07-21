"use strict";

const { createHash } = require("node:crypto");
const { validateEmbedding, fingerprintEmbedding } = require("./ClusterMath");

const CLUSTER_RECORD_SCHEMA_VERSION = 1;
const HEX_64 = /^[a-f0-9]{64}$/;
const RECORD_KEYS = Object.freeze([
  "schema_version", "id", "idempotency_key", "record_fingerprint",
  "user_id", "candidate_cluster_id", "plan_id", "algorithm_version",
  "policy", "source_memory_ids", "embedding", "centroid",
  "centroid_fingerprint", "density", "created_at", "updated_at", "persisted"
]);
const CANDIDATE_KEYS = Object.freeze([
  "schemaVersion", "algorithmVersion", "clusterId", "memberIds",
  "embeddingDimension", "centroid", "centroidFingerprint", "density",
  "policy", "reasonCodes", "persisted"
]);

class ClusterRecordError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ClusterRecordError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ClusterRecordError(code, message);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.keys(value).map((key) => [key, clone(value[key])]));
  }
  return value;
}

function deepFreeze(value) {
  Object.freeze(value);
  for (const child of Object.values(value)) {
    if (child && typeof child === "object" && !Object.isFrozen(child)) deepFreeze(child);
  }
  return value;
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${stableStringify(value[key])}`
  ).join(",")}}`;
}

function sha256(value) {
  return createHash("sha256").update(stableStringify(value), "utf8").digest("hex");
}

function assertExactKeys(value, expected, label) {
  if (!isPlainObject(value)) fail("INVALID_PLAIN_OBJECT", `${label} must be a plain object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail("INVALID_PROPERTIES", `${label} has missing or unknown properties`);
  }
}

function assertString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail("INVALID_STRING", `${label} must be a non-empty string`);
  }
}

function assertTimestamp(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail("INVALID_TIMESTAMP", `${label} must be an epoch millisecond integer >= 0`);
  }
}

function validatePolicy(policy) {
  assertExactKeys(policy, ["similarityThreshold", "minClusterSize", "maxClusterSize"], "policy");
  if (typeof policy.similarityThreshold !== "number" ||
      !Number.isFinite(policy.similarityThreshold) ||
      policy.similarityThreshold < -1 || policy.similarityThreshold > 1) {
    fail("INVALID_POLICY", "policy.similarityThreshold must be finite in [-1, 1]");
  }
  if (!Number.isInteger(policy.minClusterSize) || policy.minClusterSize < 2) {
    fail("INVALID_POLICY", "policy.minClusterSize must be an integer >= 2");
  }
  if (policy.maxClusterSize !== null &&
      (!Number.isInteger(policy.maxClusterSize) ||
       policy.maxClusterSize < policy.minClusterSize)) {
    fail("INVALID_POLICY", "policy.maxClusterSize is invalid");
  }
}

function validateSourceIds(sourceIds, { requireSorted = true } = {}) {
  if (!Array.isArray(sourceIds) || sourceIds.length === 0) {
    fail("INVALID_SOURCE_MEMORY_IDS", "source_memory_ids must be a non-empty array");
  }
  for (const id of sourceIds) assertString(id, "source memory ID");
  if (new Set(sourceIds).size !== sourceIds.length) {
    fail("DUPLICATE_SOURCE_MEMORY_ID", "source memory IDs must be unique");
  }
  const sorted = [...sourceIds].sort();
  if (requireSorted && sorted.some((id, index) => id !== sourceIds[index])) {
    fail("UNSORTED_SOURCE_MEMORY_IDS", "source memory IDs must be sorted");
  }
  return sorted;
}

function validateEmbeddingMetadata(embedding, centroid) {
  assertExactKeys(embedding, ["provider_id", "model", "version", "dimension"], "embedding");
  assertString(embedding.provider_id, "embedding.provider_id");
  assertString(embedding.model, "embedding.model");
  assertString(embedding.version, "embedding.version");
  if (!Number.isInteger(embedding.dimension) || embedding.dimension <= 0) {
    fail("INVALID_EMBEDDING_DIMENSION", "embedding.dimension must be a positive integer");
  }
  if (centroid !== undefined) {
    try {
      validateEmbedding(centroid);
    } catch {
      fail("INVALID_CENTROID", "centroid must be a valid embedding");
    }
    if (centroid.length !== embedding.dimension) {
      fail("EMBEDDING_DIMENSION_MISMATCH", "embedding dimension must match centroid");
    }
  }
}

function validateDensity(density, memberCount) {
  assertExactKeys(
    density,
    ["average_similarity", "minimum_similarity", "maximum_similarity", "member_count"],
    "density"
  );
  const values = [density.average_similarity, density.minimum_similarity, density.maximum_similarity];
  if (values.some((value) => typeof value !== "number" || !Number.isFinite(value) ||
      value < -1 || value > 1)) {
    fail("INVALID_DENSITY", "density similarities must be finite in [-1, 1]");
  }
  if (density.minimum_similarity > density.average_similarity ||
      density.average_similarity > density.maximum_similarity) {
    fail("INVALID_DENSITY_ORDER", "density must satisfy minimum <= average <= maximum");
  }
  if (!Number.isInteger(density.member_count) || density.member_count !== memberCount) {
    fail("INVALID_DENSITY_MEMBER_COUNT", "density.member_count must match source memories");
  }
}

function idempotencyPayload(input) {
  return {
    schema_version: CLUSTER_RECORD_SCHEMA_VERSION,
    user_id: input.user_id,
    algorithm_version: input.algorithm_version,
    policy: input.policy,
    source_memory_ids: input.source_memory_ids,
    embedding: input.embedding,
    centroid_fingerprint: input.centroid_fingerprint
  };
}

function computeClusterIdempotencyKey(input) {
  if (!isPlainObject(input)) fail("INVALID_IDEMPOTENCY_INPUT", "Idempotency input must be a plain object");
  const normalized = {
    user_id: input.user_id ?? input.userId,
    algorithm_version: input.algorithm_version ?? input.algorithmVersion,
    policy: input.policy,
    source_memory_ids: input.source_memory_ids ?? input.sourceMemoryIds,
    embedding: input.embedding && {
      provider_id: input.embedding.provider_id ?? input.embedding.providerId,
      model: input.embedding.model,
      version: input.embedding.version,
      dimension: input.embedding.dimension
    },
    centroid_fingerprint: input.centroid_fingerprint ?? input.centroidFingerprint
  };
  assertString(normalized.user_id, "user_id");
  assertString(normalized.algorithm_version, "algorithm_version");
  validatePolicy(normalized.policy);
  validateSourceIds(normalized.source_memory_ids);
  validateEmbeddingMetadata(normalized.embedding);
  if (!HEX_64.test(normalized.centroid_fingerprint)) {
    fail("INVALID_CENTROID_FINGERPRINT", "centroid_fingerprint must be SHA-256");
  }
  return sha256(idempotencyPayload(normalized));
}

function fingerprintPayload(record) {
  return {
    schema_version: record.schema_version,
    id: record.id,
    idempotency_key: record.idempotency_key,
    user_id: record.user_id,
    candidate_cluster_id: record.candidate_cluster_id,
    algorithm_version: record.algorithm_version,
    policy: record.policy,
    source_memory_ids: record.source_memory_ids,
    embedding: record.embedding,
    centroid_fingerprint: record.centroid_fingerprint,
    density: record.density,
    persisted: record.persisted
  };
}

function computeClusterRecordFingerprint(record) {
  if (!isPlainObject(record)) fail("INVALID_RECORD", "Cluster record must be a plain object");
  return sha256(fingerprintPayload(record));
}

function validateCandidate(candidate) {
  assertExactKeys(candidate, CANDIDATE_KEYS, "clusterCandidate");
  if (candidate.schemaVersion !== 1 || candidate.persisted !== false) {
    fail("INVALID_CLUSTER_CANDIDATE", "Cluster candidate must be an unpersisted FIX 7 V1 candidate");
  }
  assertString(candidate.algorithmVersion, "clusterCandidate.algorithmVersion");
  if (!HEX_64.test(candidate.clusterId)) fail("INVALID_CLUSTER_CANDIDATE", "candidate cluster ID must be SHA-256");
  const memberIds = validateSourceIds(candidate.memberIds, { requireSorted: false });
  validatePolicy(candidate.policy);
  if (!Array.isArray(candidate.reasonCodes) || candidate.reasonCodes.length !== 1 ||
      candidate.reasonCodes[0] !== "CLUSTERED") {
    fail("INVALID_CLUSTER_CANDIDATE", "candidate reasonCodes must contain CLUSTERED");
  }
  if (!Number.isInteger(candidate.embeddingDimension) || candidate.embeddingDimension <= 0) {
    fail("INVALID_EMBEDDING_DIMENSION", "candidate embedding dimension is invalid");
  }
  try { validateEmbedding(candidate.centroid); } catch {
    fail("INVALID_CENTROID", "candidate centroid is invalid");
  }
  if (candidate.centroid.length !== candidate.embeddingDimension ||
      fingerprintEmbedding(candidate.centroid) !== candidate.centroidFingerprint) {
    fail("INVALID_CENTROID_FINGERPRINT", "candidate centroid fingerprint is inconsistent");
  }
  assertExactKeys(
    candidate.density,
    ["averageSimilarity", "minimumSimilarity", "maximumSimilarity", "memberCount"],
    "clusterCandidate.density"
  );
  validateDensity({
    average_similarity: candidate.density.averageSimilarity,
    minimum_similarity: candidate.density.minimumSimilarity,
    maximum_similarity: candidate.density.maximumSimilarity,
    member_count: candidate.density.memberCount
  }, memberIds.length);
  return memberIds;
}

function createClusterRecord(input) {
  assertExactKeys(input, ["userId", "clusterCandidate", "planId", "createdAt", "embedding"], "input");
  assertString(input.userId, "userId");
  if (!HEX_64.test(input.planId)) fail("INVALID_PLAN_ID", "planId must be SHA-256");
  assertTimestamp(input.createdAt, "createdAt");
  const sourceMemoryIds = validateCandidate(input.clusterCandidate);
  assertExactKeys(input.embedding, ["providerId", "model", "version"], "embedding input");
  const embedding = {
    provider_id: input.embedding.providerId,
    model: input.embedding.model,
    version: input.embedding.version,
    dimension: input.clusterCandidate.embeddingDimension
  };
  validateEmbeddingMetadata(embedding, input.clusterCandidate.centroid);
  const density = {
    average_similarity: input.clusterCandidate.density.averageSimilarity,
    minimum_similarity: input.clusterCandidate.density.minimumSimilarity,
    maximum_similarity: input.clusterCandidate.density.maximumSimilarity,
    member_count: input.clusterCandidate.density.memberCount
  };
  const record = {
    schema_version: CLUSTER_RECORD_SCHEMA_VERSION,
    id: "",
    idempotency_key: "",
    record_fingerprint: "",
    user_id: input.userId,
    candidate_cluster_id: input.clusterCandidate.clusterId,
    plan_id: input.planId,
    algorithm_version: input.clusterCandidate.algorithmVersion,
    policy: clone(input.clusterCandidate.policy),
    source_memory_ids: sourceMemoryIds,
    embedding,
    centroid: [...input.clusterCandidate.centroid],
    centroid_fingerprint: input.clusterCandidate.centroidFingerprint,
    density,
    created_at: input.createdAt,
    updated_at: input.createdAt,
    persisted: true
  };
  record.idempotency_key = computeClusterIdempotencyKey(record);
  record.id = `clp_${record.idempotency_key}`;
  record.record_fingerprint = computeClusterRecordFingerprint(record);
  return validateClusterRecord(record);
}

function validateClusterRecord(record) {
  assertExactKeys(record, RECORD_KEYS, "cluster record");
  const copy = clone(record);
  if (copy.schema_version !== CLUSTER_RECORD_SCHEMA_VERSION) {
    fail("INVALID_SCHEMA_VERSION", "cluster record schema_version must be 1");
  }
  assertString(copy.user_id, "user_id");
  if (!HEX_64.test(copy.candidate_cluster_id)) fail("INVALID_CANDIDATE_CLUSTER_ID", "candidate_cluster_id must be SHA-256");
  if (!HEX_64.test(copy.plan_id)) fail("INVALID_PLAN_ID", "plan_id must be SHA-256");
  assertString(copy.algorithm_version, "algorithm_version");
  validatePolicy(copy.policy);
  validateSourceIds(copy.source_memory_ids);
  validateEmbeddingMetadata(copy.embedding, copy.centroid);
  const centroidFingerprint = fingerprintEmbedding(copy.centroid);
  if (copy.centroid_fingerprint !== centroidFingerprint) {
    fail("INVALID_CENTROID_FINGERPRINT", "centroid_fingerprint does not match centroid");
  }
  validateDensity(copy.density, copy.source_memory_ids.length);
  assertTimestamp(copy.created_at, "created_at");
  assertTimestamp(copy.updated_at, "updated_at");
  if (copy.updated_at < copy.created_at) fail("INVALID_TIMESTAMP", "updated_at must not precede created_at");
  if (copy.persisted !== true) fail("INVALID_PERSISTED_FLAG", "persisted must be true");
  const expectedKey = computeClusterIdempotencyKey(copy);
  if (copy.idempotency_key !== expectedKey) fail("INVALID_IDEMPOTENCY_KEY", "idempotency_key is inconsistent");
  if (copy.id !== `clp_${expectedKey}`) fail("INVALID_CLUSTER_ID", "cluster ID is inconsistent");
  const expectedFingerprint = computeClusterRecordFingerprint(copy);
  if (copy.record_fingerprint !== expectedFingerprint) {
    fail("INVALID_RECORD_FINGERPRINT", "record_fingerprint is inconsistent");
  }
  return deepFreeze(copy);
}

module.exports = {
  CLUSTER_RECORD_SCHEMA_VERSION,
  ClusterRecordError,
  createClusterRecord,
  validateClusterRecord,
  computeClusterIdempotencyKey,
  computeClusterRecordFingerprint
};
