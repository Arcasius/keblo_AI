"use strict";

const { createHash } = require("node:crypto");
const { normalizeMemory } = require("../MemoryContractNormalizer");
const { validateConsolidationPlan } = require("../consolidation/ConsolidationPlan");
const {
  validateEmbedding,
  cosineSimilarity,
  calculateCentroid,
  calculateInternalDensity,
  fingerprintEmbedding
} = require("./ClusterMath");

const CLUSTER_ADAPTER_SCHEMA_VERSION = 1;
const CLUSTER_ALGORITHM_VERSION = "complete-link-greedy-v1";

function deepFreeze(value) {
  Object.freeze(value);
  for (const child of Object.values(value)) {
    if (child && typeof child === "object" && !Object.isFrozen(child)) deepFreeze(child);
  }
  return value;
}

const CLUSTER_REASON_CODES = deepFreeze({
  CLUSTERED: "CLUSTERED",
  UNCLUSTERED_BELOW_MIN_SIZE: "UNCLUSTERED_BELOW_MIN_SIZE",
  EMBEDDING_PROVIDER_FAILED: "EMBEDDING_PROVIDER_FAILED",
  INVALID_EMBEDDING: "INVALID_EMBEDDING",
  EMBEDDING_DIMENSION_MISMATCH: "EMBEDDING_DIMENSION_MISMATCH",
  CANDIDATE_MEMORY_NOT_FOUND: "CANDIDATE_MEMORY_NOT_FOUND",
  OVERSIZED_CLUSTER_DEFERRED: "OVERSIZED_CLUSTER_DEFERRED",
  INVALID_CONSOLIDATION_PLAN: "INVALID_CONSOLIDATION_PLAN"
});

const DEFAULT_CLUSTER_POLICY = deepFreeze({
  similarityThreshold: 0.70,
  minClusterSize: 3,
  maxClusterSize: null
});

class ClusterEngineAdapterError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ClusterEngineAdapterError";
    this.code = code;
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${stableStringify(value[key])}`
  ).join(",")}}`;
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function normalizePolicy(policy) {
  if (policy === undefined) policy = {};
  if (!isPlainObject(policy)) throw new ClusterEngineAdapterError("INVALID_CLUSTER_POLICY", "Cluster policy must be a plain object");
  const allowed = new Set(["similarityThreshold", "minClusterSize", "maxClusterSize"]);
  for (const key of Object.keys(policy)) {
    if (!allowed.has(key)) throw new ClusterEngineAdapterError("INVALID_CLUSTER_POLICY", `Unsupported cluster policy property: ${key}`);
  }
  const normalized = {
    similarityThreshold: Object.hasOwn(policy, "similarityThreshold")
      ? policy.similarityThreshold
      : DEFAULT_CLUSTER_POLICY.similarityThreshold,
    minClusterSize: Object.hasOwn(policy, "minClusterSize")
      ? policy.minClusterSize
      : DEFAULT_CLUSTER_POLICY.minClusterSize,
    maxClusterSize: Object.hasOwn(policy, "maxClusterSize")
      ? policy.maxClusterSize
      : DEFAULT_CLUSTER_POLICY.maxClusterSize
  };
  if (typeof normalized.similarityThreshold !== "number" ||
      !Number.isFinite(normalized.similarityThreshold) ||
      normalized.similarityThreshold < -1 || normalized.similarityThreshold > 1) {
    throw new ClusterEngineAdapterError("INVALID_CLUSTER_POLICY", "similarityThreshold must be finite in [-1, 1]");
  }
  if (!Number.isInteger(normalized.minClusterSize) || normalized.minClusterSize < 2) {
    throw new ClusterEngineAdapterError("INVALID_CLUSTER_POLICY", "minClusterSize must be an integer >= 2");
  }
  if (normalized.maxClusterSize !== null &&
      (!Number.isInteger(normalized.maxClusterSize) ||
       normalized.maxClusterSize < normalized.minClusterSize)) {
    throw new ClusterEngineAdapterError("INVALID_CLUSTER_POLICY", "maxClusterSize must be null or an integer >= minClusterSize");
  }
  return normalized;
}

function validateProvider(provider) {
  if (!isPlainObject(provider) || provider.schemaVersion !== 1 ||
      typeof provider.getEmbedding !== "function") {
    throw new ClusterEngineAdapterError("INVALID_EMBEDDING_PROVIDER", "Embedding provider must expose schemaVersion 1 and callable getEmbedding");
  }
}

function normalizeCandidateMemories(memories, candidateIds) {
  if (!Array.isArray(memories) && !isPlainObject(memories)) {
    throw new ClusterEngineAdapterError("INVALID_MEMORY_COLLECTION", "Memories must be an array or plain object map");
  }
  const source = Array.isArray(memories)
    ? memories
    : Object.keys(memories).sort().map((key) => memories[key]);
  const candidateSet = new Set(candidateIds);
  const resolved = new Map();
  for (const memory of source) {
    if (!isPlainObject(memory)) continue;
    let normalized;
    try {
      normalized = normalizeMemory(memory);
    } catch {
      continue;
    }
    if (!candidateSet.has(normalized.id)) continue;
    if (resolved.has(normalized.id)) {
      throw new ClusterEngineAdapterError("DUPLICATE_CANDIDATE_MEMORY", "Candidate memory ID is duplicated");
    }
    resolved.set(normalized.id, {
      memoryId: normalized.id,
      embeddingRef: normalized.embeddingRef
    });
  }
  for (const memoryId of candidateIds) {
    if (!resolved.has(memoryId)) {
      throw new ClusterEngineAdapterError(
        CLUSTER_REASON_CODES.CANDIDATE_MEMORY_NOT_FOUND,
        `Candidate memory cannot be resolved: ${memoryId}`
      );
    }
  }
  return candidateIds.map((memoryId) => resolved.get(memoryId));
}

function embeddingFailure(memoryId, reasonCode) {
  return { memoryId, reasonCodes: [reasonCode] };
}

async function resolveEmbeddings(descriptors, provider) {
  const settled = await Promise.all(descriptors.map(async (descriptor) => {
    const request = Object.freeze({
      memoryId: descriptor.memoryId,
      embeddingRef: descriptor.embeddingRef
    });
    try {
      const embedding = await provider.getEmbedding(request);
      try {
        validateEmbedding(embedding);
      } catch {
        return { failure: embeddingFailure(descriptor.memoryId, CLUSTER_REASON_CODES.INVALID_EMBEDDING) };
      }
      return {
        memoryId: descriptor.memoryId,
        embedding: [...embedding],
        embeddingFingerprint: fingerprintEmbedding(embedding)
      };
    } catch {
      return { failure: embeddingFailure(descriptor.memoryId, CLUSTER_REASON_CODES.EMBEDDING_PROVIDER_FAILED) };
    }
  }));

  const valid = [];
  const failures = [];
  let dimension = null;
  for (const item of settled) {
    if (item.failure) {
      failures.push(item.failure);
      continue;
    }
    if (dimension === null) dimension = item.embedding.length;
    if (item.embedding.length !== dimension) {
      failures.push(embeddingFailure(item.memoryId, CLUSTER_REASON_CODES.EMBEDDING_DIMENSION_MISMATCH));
      continue;
    }
    valid.push(item);
  }
  return { valid, failures, dimension };
}

function completeLinkGroups(items, threshold) {
  const assigned = new Set();
  const groups = [];
  for (const seed of items) {
    if (assigned.has(seed.memoryId)) continue;
    const group = [seed];
    assigned.add(seed.memoryId);
    for (const candidate of items) {
      if (assigned.has(candidate.memoryId)) continue;
      const compatible = group.every((member) =>
        cosineSimilarity(candidate.embedding, member.embedding) >= threshold
      );
      if (compatible) {
        group.push(candidate);
        assigned.add(candidate.memoryId);
      }
    }
    groups.push(group);
  }
  return groups;
}

function buildCluster(group, policy) {
  const memberIds = group.map((item) => item.memoryId).sort();
  const embeddings = group.map((item) => item.embedding);
  const centroid = calculateCentroid(embeddings);
  const centroidFingerprint = fingerprintEmbedding(centroid);
  const clusterIdentity = {
    schemaVersion: CLUSTER_ADAPTER_SCHEMA_VERSION,
    algorithmVersion: CLUSTER_ALGORITHM_VERSION,
    policy,
    memberIds,
    centroidFingerprint,
    embeddingFingerprints: group.map((item) => ({
      memoryId: item.memoryId,
      fingerprint: item.embeddingFingerprint
    }))
  };
  return {
    schemaVersion: CLUSTER_ADAPTER_SCHEMA_VERSION,
    algorithmVersion: CLUSTER_ALGORITHM_VERSION,
    clusterId: sha256(stableStringify(clusterIdentity)),
    memberIds,
    embeddingDimension: centroid.length,
    centroid,
    centroidFingerprint,
    density: calculateInternalDensity(embeddings, centroid),
    policy: { ...policy },
    reasonCodes: [CLUSTER_REASON_CODES.CLUSTERED],
    persisted: false
  };
}

function createClusterEngineAdapter(options) {
  if (!isPlainObject(options)) throw new ClusterEngineAdapterError("INVALID_ADAPTER_OPTIONS", "Adapter options must be a plain object");
  const allowed = new Set(["embeddingProvider", "policy"]);
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) throw new ClusterEngineAdapterError("INVALID_ADAPTER_OPTIONS", `Unsupported adapter option: ${key}`);
  }
  validateProvider(options.embeddingProvider);
  const policy = deepFreeze(normalizePolicy(options.policy));
  const provider = options.embeddingProvider;

  return deepFreeze({
    async buildClusterCandidates(input) {
      if (!isPlainObject(input) || Object.keys(input).sort().join(",") !== "consolidationPlan,memories") {
        throw new ClusterEngineAdapterError("INVALID_ADAPTER_INPUT", "Input must contain only memories and consolidationPlan");
      }
      const planValidation = validateConsolidationPlan(input.consolidationPlan);
      if (!planValidation.valid) {
        throw new ClusterEngineAdapterError(
          CLUSTER_REASON_CODES.INVALID_CONSOLIDATION_PLAN,
          "A valid dry-run consolidation plan is required"
        );
      }
      const candidateIds = [...input.consolidationPlan.candidateIds].sort();
      if (new Set(candidateIds).size !== candidateIds.length) {
        throw new ClusterEngineAdapterError("DUPLICATE_CANDIDATE_ID", "Plan candidate IDs must be unique");
      }
      const descriptors = normalizeCandidateMemories(input.memories, candidateIds);
      const { valid, failures, dimension } = await resolveEmbeddings(descriptors, provider);
      const groups = completeLinkGroups(valid, policy.similarityThreshold);
      const clusters = [];
      const unclustered = [];
      let oversizedGroupCount = 0;
      for (const group of groups) {
        if (policy.maxClusterSize !== null && group.length > policy.maxClusterSize) {
          oversizedGroupCount += 1;
          for (const member of group) {
            unclustered.push({
              memoryId: member.memoryId,
              reasonCodes: [CLUSTER_REASON_CODES.OVERSIZED_CLUSTER_DEFERRED]
            });
          }
        } else if (group.length < policy.minClusterSize) {
          for (const member of group) {
            unclustered.push({
              memoryId: member.memoryId,
              reasonCodes: [CLUSTER_REASON_CODES.UNCLUSTERED_BELOW_MIN_SIZE]
            });
          }
        } else {
          clusters.push(buildCluster(group, policy));
        }
      }
      clusters.sort((left, right) => left.memberIds[0].localeCompare(right.memberIds[0]));
      unclustered.sort((left, right) => left.memoryId.localeCompare(right.memoryId));
      failures.sort((left, right) => left.memoryId.localeCompare(right.memoryId));
      const clusteredMemoryCount = clusters.reduce((sum, cluster) => sum + cluster.memberIds.length, 0);
      const invalidEmbeddingCount = failures.filter((failure) =>
        failure.reasonCodes[0] !== CLUSTER_REASON_CODES.EMBEDDING_PROVIDER_FAILED
      ).length;
      return deepFreeze({
        schemaVersion: CLUSTER_ADAPTER_SCHEMA_VERSION,
        algorithmVersion: CLUSTER_ALGORITHM_VERSION,
        planId: input.consolidationPlan.planId,
        policy: { ...policy },
        clusters,
        unclustered,
        embeddingFailures: failures,
        stats: {
          requestedCandidateCount: candidateIds.length,
          resolvedMemoryCount: descriptors.length,
          validEmbeddingCount: valid.length,
          invalidEmbeddingCount,
          providerFailureCount: failures.length - invalidEmbeddingCount,
          clusterCount: clusters.length,
          clusteredMemoryCount,
          unclusteredMemoryCount: unclustered.length,
          oversizedGroupCount,
          embeddingDimension: dimension
        },
        persisted: false
      });
    }
  });
}

module.exports = {
  CLUSTER_ADAPTER_SCHEMA_VERSION,
  CLUSTER_ALGORITHM_VERSION,
  CLUSTER_REASON_CODES,
  DEFAULT_CLUSTER_POLICY,
  ClusterEngineAdapterError,
  createClusterEngineAdapter
};
