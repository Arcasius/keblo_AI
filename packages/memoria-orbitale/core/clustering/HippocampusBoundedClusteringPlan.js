"use strict";

const { createHash } = require("node:crypto");

const BOUNDED_CLUSTERING_PLAN_SCHEMA_VERSION = 1;
const GLOBAL_IDENTITY_SNAPSHOT_SCHEMA_VERSION = 1;
const BOUNDED_CLUSTERING_POLICY_VERSION = 1;
const BOUNDED_CLUSTERING_ALGORITHM_VERSION = "hippocampus-bounded-complete-link-v1";
const BOUNDED_CLUSTERING_COMPARISON = "GREATER_THAN_OR_EQUAL";
const PLANNER_CONTRACT_VERSION = "hippocampus-bounded-clustering-plan-v1";

const HEX_64 = /^[a-f0-9]{64}$/;
const UUID_V5 = /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

const BOUNDED_CLUSTERING_STATUSES = deepFreeze({
  COMPLETE: "COMPLETE",
  PARTIAL_DEFERRED: "PARTIAL_DEFERRED",
  DEFERRED: "DEFERRED"
});

const GLOBAL_BARRIER_STATUSES = deepFreeze({
  COMPLETE: "COMPLETE",
  INCOMPLETE: "INCOMPLETE"
});

const DISCOVERY_COMPLETENESS = deepFreeze({
  COMPLETE_ABOVE_THRESHOLD: "COMPLETE_ABOVE_THRESHOLD",
  INCOMPLETE_TRUNCATED: "INCOMPLETE_TRUNCATED",
  INCOMPLETE_UNCERTIFIED: "INCOMPLETE_UNCERTIFIED",
  FAILED: "FAILED"
});

const TIMESTAMP_QUALITY = deepFreeze({
  NOT_EVALUATED: "NOT_EVALUATED",
  COMPLETE: "COMPLETE",
  PARTIAL_MISSING: "PARTIAL_MISSING",
  PARTIAL_INVALID: "PARTIAL_INVALID",
  UNKNOWN: "UNKNOWN"
});

const BOUNDED_CLUSTERING_REASON_CODES = deepFreeze({
  DEFERRED_GLOBAL_BARRIER: "DEFERRED_GLOBAL_BARRIER",
  DEFERRED_INCOMPLETE_NEIGHBOR_DISCOVERY: "DEFERRED_INCOMPLETE_NEIGHBOR_DISCOVERY",
  DEFERRED_DENSE_COMPONENT: "DEFERRED_DENSE_COMPONENT",
  DEFERRED_PAIRWISE_BUDGET: "DEFERRED_PAIRWISE_BUDGET",
  DEFERRED_EDGE_BUDGET: "DEFERRED_EDGE_BUDGET",
  DEFERRED_TIMEOUT: "DEFERRED_TIMEOUT",
  DEFERRED_RSS_BUDGET: "DEFERRED_RSS_BUDGET",
  DEFERRED_OVERSIZED_CLUSTER: "DEFERRED_OVERSIZED_CLUSTER",
  UNCLUSTERED_BELOW_MIN_SIZE: "UNCLUSTERED_BELOW_MIN_SIZE",
  STALE_IDENTITY_REJECTED: "STALE_IDENTITY_REJECTED"
});

const DEFAULT_BOUNDED_CLUSTERING_POLICY = deepFreeze({
  policyVersion: BOUNDED_CLUSTERING_POLICY_VERSION,
  clusterThreshold: 0.70,
  minClusterSize: 3,
  comparison: BOUNDED_CLUSTERING_COMPARISON
});

const SNAPSHOT_KEYS = Object.freeze([
  "schemaVersion", "snapshotFingerprint", "userIdHash", "identityCount", "identities"
]);
const SNAPSHOT_INPUT_KEYS = Object.freeze(["userIdHash", "identities"]);
const IDENTITY_KEYS = Object.freeze([
  "memoryId", "contentHash", "pointId", "model", "revision"
]);
const POLICY_KEYS = Object.freeze([
  "policyVersion", "clusterThreshold", "minClusterSize", "comparison"
]);
const BUDGET_KEYS = Object.freeze([
  "neighborLimit", "overfetchFactor", "scoreThreshold",
  "maxComponentVectorsInMemory", "maxPairwiseComparisons", "maxCandidateEdges",
  "maxClusterSize", "timeoutMs", "maxRssDeltaBytes"
]);
const PROVENANCE_INPUT_KEYS = Object.freeze([
  "cacheSchemaVersion", "embeddingModel", "embeddingRevision", "globalBarrierStatus"
]);
const PROVENANCE_KEYS = Object.freeze([
  "identitySnapshotFingerprint", "identityCount", "cacheSchemaVersion",
  "embeddingModel", "embeddingRevision", "plannerContractVersion", "globalBarrierStatus"
]);
const CLUSTER_INPUT_KEYS = Object.freeze([
  "memberIds", "minimumPairSimilarity", "discoveryCompleteness", "temporal"
]);
const CLUSTER_KEYS = Object.freeze([
  "clusterId", "memberIds", "orderedSourceIds", "unresolvedSourceIds",
  "temporalStart", "temporalEnd", "timestampQuality", "minimumPairSimilarity",
  "discoveryCompleteness"
]);
const TEMPORAL_KEYS = Object.freeze([
  "orderedSourceIds", "unresolvedSourceIds", "temporalStart", "temporalEnd",
  "timestampQuality"
]);
const COMPONENT_INPUT_KEYS = Object.freeze([
  "memberIds", "reasonCode", "discoveryCompleteness"
]);
const COMPONENT_KEYS = Object.freeze([
  "componentId", "memberIds", "memberCount", "reasonCode", "discoveryCompleteness"
]);
const METRIC_KEYS = Object.freeze([
  "identityCount", "finalizedIdentityCount", "deferredIdentityCount",
  "unclusteredIdentityCount", "neighborQueryCount", "candidateEdgeCount",
  "canonicalEdgeCount", "componentCount", "completedComponentCount",
  "deferredComponentCount", "unclusteredComponentCount", "pairwiseComparisonCount",
  "maximumComponentSize", "maximumVectorsInMemory", "elapsedMs", "rssStartBytes",
  "rssPeakBytes", "rssDeltaBytes", "reasonCounts"
]);
const PLAN_INPUT_KEYS = Object.freeze([
  "identitySnapshot", "policy", "budgets", "provenance", "clusters",
  "deferredComponents", "unclusteredComponents", "metrics"
]);
const PLAN_KEYS = Object.freeze([
  "schemaVersion", "algorithmVersion", "planId", "status", "policy", "budgets",
  "provenance", "clusters", "deferredComponents", "unclusteredComponents",
  "metrics", "persisted"
]);

const DEFERRED_REASONS = new Set([
  BOUNDED_CLUSTERING_REASON_CODES.DEFERRED_GLOBAL_BARRIER,
  BOUNDED_CLUSTERING_REASON_CODES.DEFERRED_INCOMPLETE_NEIGHBOR_DISCOVERY,
  BOUNDED_CLUSTERING_REASON_CODES.DEFERRED_DENSE_COMPONENT,
  BOUNDED_CLUSTERING_REASON_CODES.DEFERRED_PAIRWISE_BUDGET,
  BOUNDED_CLUSTERING_REASON_CODES.DEFERRED_EDGE_BUDGET,
  BOUNDED_CLUSTERING_REASON_CODES.DEFERRED_TIMEOUT,
  BOUNDED_CLUSTERING_REASON_CODES.DEFERRED_RSS_BUDGET,
  BOUNDED_CLUSTERING_REASON_CODES.DEFERRED_OVERSIZED_CLUSTER
]);
const DISCOVERY_VALUES = new Set(Object.values(DISCOVERY_COMPLETENESS));
const TIMESTAMP_QUALITY_VALUES = new Set(Object.values(TIMESTAMP_QUALITY));
const REASON_VALUES = Object.values(BOUNDED_CLUSTERING_REASON_CODES);

class HippocampusBoundedClusteringPlanError extends Error {
  constructor(code, phase = "contract") {
    super("Hippocampus bounded clustering plan validation failed");
    this.name = "HippocampusBoundedClusteringPlanError";
    this.code = code;
    this.phase = phase;
    this.retryable = false;
  }
}

function fail(code, phase) {
  throw new HippocampusBoundedClusteringPlanError(code, phase);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze(value) {
  Object.freeze(value);
  for (const child of Object.values(value)) {
    if (child && typeof child === "object" && !Object.isFrozen(child)) deepFreeze(child);
  }
  return value;
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)]));
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

function hasExactKeys(value, keys) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function assertNonEmptyString(value, code) {
  if (typeof value !== "string" || value.trim().length === 0) fail(code);
}

function assertSafeNonNegativeInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) fail(code);
}

function assertPositiveInteger(value, code) {
  if (!Number.isSafeInteger(value) || value <= 0) fail(code);
}

function assertIdentity(identity) {
  if (!hasExactKeys(identity, IDENTITY_KEYS) ||
      typeof identity.memoryId !== "string" || identity.memoryId.trim().length === 0 ||
      !HEX_64.test(identity.contentHash || "") || !UUID_V5.test(identity.pointId || "") ||
      typeof identity.model !== "string" || identity.model.length === 0 ||
      typeof identity.revision !== "string" || identity.revision.length === 0) {
    fail("INVALID_SNAPSHOT_IDENTITY", "snapshot");
  }
}

function snapshotFingerprint(userIdHash, identities) {
  return sha256({
    domain: "hippocampus-global-identity-snapshot-v1",
    schemaVersion: GLOBAL_IDENTITY_SNAPSHOT_SCHEMA_VERSION,
    userIdHash,
    identities
  });
}

function normalizeSnapshotInput(input) {
  if (!hasExactKeys(input, SNAPSHOT_INPUT_KEYS) || !HEX_64.test(input.userIdHash || "") ||
      !Array.isArray(input.identities)) fail("INVALID_SNAPSHOT_INPUT", "snapshot");
  const identities = input.identities.map((identity) => {
    assertIdentity(identity);
    return clone(identity);
  }).sort(compareCanonicalIdentities);
  const memoryIds = new Set();
  const pointIds = new Set();
  let model = null;
  let revision = null;
  for (const identity of identities) {
    if (memoryIds.has(identity.memoryId) || pointIds.has(identity.pointId)) {
      fail("DUPLICATE_SNAPSHOT_IDENTITY", "snapshot");
    }
    memoryIds.add(identity.memoryId);
    pointIds.add(identity.pointId);
    model ??= identity.model;
    revision ??= identity.revision;
    if (identity.model !== model || identity.revision !== revision) {
      fail("MIXED_SNAPSHOT_PROVENANCE", "snapshot");
    }
  }
  return { userIdHash: input.userIdHash, identities };
}

function compareCanonicalIdentities(left, right) {
  return left.pointId.localeCompare(right.pointId) ||
    left.memoryId.localeCompare(right.memoryId);
}

function createGlobalIdentitySnapshot(input) {
  const normalized = normalizeSnapshotInput(input);
  return deepFreeze({
    schemaVersion: GLOBAL_IDENTITY_SNAPSHOT_SCHEMA_VERSION,
    snapshotFingerprint: snapshotFingerprint(normalized.userIdHash, normalized.identities),
    userIdHash: normalized.userIdHash,
    identityCount: normalized.identities.length,
    identities: normalized.identities
  });
}

function assertGlobalIdentitySnapshot(snapshot) {
  if (!hasExactKeys(snapshot, SNAPSHOT_KEYS) ||
      snapshot.schemaVersion !== GLOBAL_IDENTITY_SNAPSHOT_SCHEMA_VERSION ||
      !HEX_64.test(snapshot.snapshotFingerprint || "") ||
      !Number.isSafeInteger(snapshot.identityCount) || snapshot.identityCount < 0) {
    fail("INVALID_IDENTITY_SNAPSHOT", "snapshot");
  }
  const recreated = createGlobalIdentitySnapshot({
    userIdHash: snapshot.userIdHash,
    identities: snapshot.identities
  });
  if (recreated.identityCount !== snapshot.identityCount ||
      recreated.snapshotFingerprint !== snapshot.snapshotFingerprint ||
      stableStringify(recreated.identities) !== stableStringify(snapshot.identities)) {
    fail("SNAPSHOT_FINGERPRINT_MISMATCH", "snapshot");
  }
  return recreated;
}

function validateGlobalIdentitySnapshot(snapshot) {
  try {
    assertGlobalIdentitySnapshot(snapshot);
    return deepFreeze({ valid: true, errors: [] });
  } catch (error) {
    const code = error instanceof HippocampusBoundedClusteringPlanError
      ? error.code
      : "INVALID_IDENTITY_SNAPSHOT";
    return deepFreeze({ valid: false, errors: [code] });
  }
}

function normalizePolicy(policy) {
  if (!hasExactKeys(policy, POLICY_KEYS) ||
      policy.policyVersion !== BOUNDED_CLUSTERING_POLICY_VERSION ||
      policy.clusterThreshold !== DEFAULT_BOUNDED_CLUSTERING_POLICY.clusterThreshold ||
      policy.minClusterSize !== DEFAULT_BOUNDED_CLUSTERING_POLICY.minClusterSize ||
      policy.comparison !== BOUNDED_CLUSTERING_COMPARISON) {
    fail("INVALID_BOUNDED_CLUSTERING_POLICY", "policy");
  }
  return clone(policy);
}

function normalizeBudgets(budgets, policy) {
  if (!hasExactKeys(budgets, BUDGET_KEYS)) fail("INVALID_BOUNDED_CLUSTERING_BUDGETS", "budget");
  for (const key of [
    "neighborLimit", "overfetchFactor", "maxComponentVectorsInMemory",
    "maxPairwiseComparisons", "maxCandidateEdges", "timeoutMs", "maxRssDeltaBytes"
  ]) assertPositiveInteger(budgets[key], "INVALID_BOUNDED_CLUSTERING_BUDGETS");
  if (typeof budgets.scoreThreshold !== "number" || !Number.isFinite(budgets.scoreThreshold) ||
      budgets.scoreThreshold < -1 || budgets.scoreThreshold > policy.clusterThreshold ||
      budgets.maxClusterSize !== null &&
        (!Number.isSafeInteger(budgets.maxClusterSize) ||
         budgets.maxClusterSize < policy.minClusterSize)) {
    fail("INVALID_BOUNDED_CLUSTERING_BUDGETS", "budget");
  }
  return clone(budgets);
}

function validateBoundedClusteringConfiguration(policy, budgets) {
  try {
    const normalizedPolicy = normalizePolicy(policy);
    normalizeBudgets(budgets, normalizedPolicy);
    return deepFreeze({ valid: true, errors: [] });
  } catch (error) {
    const code = error instanceof HippocampusBoundedClusteringPlanError
      ? error.code
      : "INVALID_BOUNDED_CLUSTERING_CONFIGURATION";
    return deepFreeze({ valid: false, errors: [code] });
  }
}

function normalizeProvenance(provenance, snapshot) {
  if (!hasExactKeys(provenance, PROVENANCE_INPUT_KEYS) ||
      !Number.isSafeInteger(provenance.cacheSchemaVersion) || provenance.cacheSchemaVersion <= 0 ||
      typeof provenance.embeddingModel !== "string" || provenance.embeddingModel.length === 0 ||
      typeof provenance.embeddingRevision !== "string" || provenance.embeddingRevision.length === 0 ||
      !Object.values(GLOBAL_BARRIER_STATUSES).includes(provenance.globalBarrierStatus)) {
    fail("INVALID_PLAN_PROVENANCE", "provenance");
  }
  if (snapshot.identities.length > 0 && snapshot.identities.some((identity) =>
    identity.model !== provenance.embeddingModel ||
    identity.revision !== provenance.embeddingRevision)) {
    fail("PLAN_PROVENANCE_MISMATCH", "provenance");
  }
  return {
    identitySnapshotFingerprint: snapshot.snapshotFingerprint,
    identityCount: snapshot.identityCount,
    cacheSchemaVersion: provenance.cacheSchemaVersion,
    embeddingModel: provenance.embeddingModel,
    embeddingRevision: provenance.embeddingRevision,
    plannerContractVersion: PLANNER_CONTRACT_VERSION,
    globalBarrierStatus: provenance.globalBarrierStatus
  };
}

function normalizeMemberIds(memberIds, snapshotIds) {
  if (!Array.isArray(memberIds) || memberIds.length === 0 ||
      memberIds.some((id) => typeof id !== "string" || id.trim().length === 0)) {
    fail("INVALID_COMPONENT_MEMBERSHIP", "membership");
  }
  const sorted = [...memberIds].sort();
  if (new Set(sorted).size !== sorted.length || sorted.some((id) => !snapshotIds.has(id))) {
    fail("INVALID_COMPONENT_MEMBERSHIP", "membership");
  }
  return sorted;
}

function assertTemporalPartition(temporal, memberIds) {
  if (!hasExactKeys(temporal, TEMPORAL_KEYS) ||
      !Array.isArray(temporal.orderedSourceIds) ||
      !Array.isArray(temporal.unresolvedSourceIds) ||
      !TIMESTAMP_QUALITY_VALUES.has(temporal.timestampQuality)) {
    fail("INVALID_TEMPORAL_DESCRIPTOR", "temporal");
  }
  const ordered = [...temporal.orderedSourceIds];
  const unresolved = [...temporal.unresolvedSourceIds];
  if ([...ordered, ...unresolved].some((id) => typeof id !== "string" || !memberIds.includes(id)) ||
      new Set([...ordered, ...unresolved]).size !== memberIds.length ||
      [...ordered, ...unresolved].sort().some((id, index) => id !== memberIds[index]) ||
      [...unresolved].sort().some((id, index) => id !== unresolved[index])) {
    fail("INVALID_TEMPORAL_PARTITION", "temporal");
  }
  const bothNull = temporal.temporalStart === null && temporal.temporalEnd === null;
  const bothValid = Number.isSafeInteger(temporal.temporalStart) && temporal.temporalStart >= 0 &&
    Number.isSafeInteger(temporal.temporalEnd) && temporal.temporalEnd >= temporal.temporalStart;
  if (!bothNull && !bothValid) fail("INVALID_TEMPORAL_RANGE", "temporal");
  if (temporal.timestampQuality === TIMESTAMP_QUALITY.NOT_EVALUATED &&
      (ordered.length !== 0 || unresolved.length !== memberIds.length || !bothNull) ||
      temporal.timestampQuality === TIMESTAMP_QUALITY.COMPLETE &&
      (unresolved.length !== 0 || ordered.length !== memberIds.length || !bothValid) ||
      temporal.timestampQuality === TIMESTAMP_QUALITY.UNKNOWN &&
      (ordered.length !== 0 || unresolved.length !== memberIds.length || !bothNull)) {
    fail("INCOHERENT_TIMESTAMP_QUALITY", "temporal");
  }
  return {
    orderedSourceIds: ordered,
    unresolvedSourceIds: unresolved,
    temporalStart: temporal.temporalStart,
    temporalEnd: temporal.temporalEnd,
    timestampQuality: temporal.timestampQuality
  };
}

function clusterId(policy, snapshotFingerprintValue, memberIds) {
  return sha256({
    domain: "hippocampus-bounded-cluster-v1",
    algorithmVersion: BOUNDED_CLUSTERING_ALGORITHM_VERSION,
    policy,
    identitySnapshotFingerprint: snapshotFingerprintValue,
    memberIds
  });
}

function componentId(snapshotFingerprintValue, memberIds) {
  return sha256({
    domain: "hippocampus-bounded-component-v1",
    identitySnapshotFingerprint: snapshotFingerprintValue,
    memberIds
  });
}

function normalizeCluster(input, context) {
  if (!hasExactKeys(input, CLUSTER_INPUT_KEYS) ||
      input.discoveryCompleteness !== DISCOVERY_COMPLETENESS.COMPLETE_ABOVE_THRESHOLD ||
      typeof input.minimumPairSimilarity !== "number" ||
      !Number.isFinite(input.minimumPairSimilarity) ||
      input.minimumPairSimilarity < context.policy.clusterThreshold ||
      input.minimumPairSimilarity > 1) {
    fail("INVALID_FINAL_CLUSTER", "cluster");
  }
  const memberIds = normalizeMemberIds(input.memberIds, context.snapshotIds);
  if (memberIds.length < context.policy.minClusterSize ||
      context.budgets.maxClusterSize !== null &&
        memberIds.length > context.budgets.maxClusterSize) {
    fail("INVALID_FINAL_CLUSTER_SIZE", "cluster");
  }
  const temporal = assertTemporalPartition(input.temporal, memberIds);
  return {
    clusterId: clusterId(context.policy, context.snapshot.snapshotFingerprint, memberIds),
    memberIds,
    ...temporal,
    minimumPairSimilarity: input.minimumPairSimilarity,
    discoveryCompleteness: input.discoveryCompleteness
  };
}

function normalizeDeferredComponent(input, context) {
  if (!hasExactKeys(input, COMPONENT_INPUT_KEYS) || !DEFERRED_REASONS.has(input.reasonCode) ||
      !DISCOVERY_VALUES.has(input.discoveryCompleteness)) {
    fail("INVALID_DEFERRED_COMPONENT", "component");
  }
  if (input.reasonCode === BOUNDED_CLUSTERING_REASON_CODES.DEFERRED_INCOMPLETE_NEIGHBOR_DISCOVERY &&
      input.discoveryCompleteness === DISCOVERY_COMPLETENESS.COMPLETE_ABOVE_THRESHOLD ||
      input.discoveryCompleteness === DISCOVERY_COMPLETENESS.FAILED &&
      input.reasonCode !== BOUNDED_CLUSTERING_REASON_CODES.DEFERRED_INCOMPLETE_NEIGHBOR_DISCOVERY) {
    fail("INCOHERENT_DISCOVERY_DISPOSITION", "component");
  }
  const memberIds = normalizeMemberIds(input.memberIds, context.snapshotIds);
  return {
    componentId: componentId(context.snapshot.snapshotFingerprint, memberIds),
    memberIds,
    memberCount: memberIds.length,
    reasonCode: input.reasonCode,
    discoveryCompleteness: input.discoveryCompleteness
  };
}

function normalizeUnclusteredComponent(input, context) {
  if (!hasExactKeys(input, COMPONENT_INPUT_KEYS) ||
      input.reasonCode !== BOUNDED_CLUSTERING_REASON_CODES.UNCLUSTERED_BELOW_MIN_SIZE ||
      input.discoveryCompleteness !== DISCOVERY_COMPLETENESS.COMPLETE_ABOVE_THRESHOLD) {
    fail("INVALID_UNCLUSTERED_COMPONENT", "component");
  }
  const memberIds = normalizeMemberIds(input.memberIds, context.snapshotIds);
  if (memberIds.length >= context.policy.minClusterSize) {
    fail("INVALID_UNCLUSTERED_COMPONENT_SIZE", "component");
  }
  return {
    componentId: componentId(context.snapshot.snapshotFingerprint, memberIds),
    memberIds,
    memberCount: memberIds.length,
    reasonCode: input.reasonCode,
    discoveryCompleteness: input.discoveryCompleteness
  };
}

function sortDisposition(left, right) {
  return left.memberIds[0].localeCompare(right.memberIds[0]) ||
    (left.clusterId || left.componentId).localeCompare(right.clusterId || right.componentId);
}

function assertCoverage(snapshot, clusters, deferred, unclustered) {
  const expected = new Set(snapshot.identities.map((identity) => identity.memoryId));
  const seen = new Set();
  for (const disposition of [...clusters, ...deferred, ...unclustered]) {
    for (const memoryId of disposition.memberIds) {
      if (seen.has(memoryId)) fail("OVERLAPPING_IDENTITY_DISPOSITION", "coverage");
      seen.add(memoryId);
    }
  }
  if (seen.size !== expected.size || [...expected].some((memoryId) => !seen.has(memoryId))) {
    fail("INCOMPLETE_IDENTITY_COVERAGE", "coverage");
  }
}

function normalizeReasonCounts(reasonCounts, deferred, unclustered) {
  if (!isPlainObject(reasonCounts) ||
      Object.keys(reasonCounts).sort().join("\0") !== [...REASON_VALUES].sort().join("\0")) {
    fail("INVALID_REASON_COUNTS", "metrics");
  }
  const normalized = {};
  for (const reason of REASON_VALUES) {
    assertSafeNonNegativeInteger(reasonCounts[reason], "INVALID_REASON_COUNTS");
    normalized[reason] = reasonCounts[reason];
  }
  for (const reason of REASON_VALUES) {
    if (reason === BOUNDED_CLUSTERING_REASON_CODES.STALE_IDENTITY_REJECTED) continue;
    const expected = deferred.filter((item) => item.reasonCode === reason).length +
      unclustered.filter((item) => item.reasonCode === reason).length;
    if (normalized[reason] !== expected) fail("INCOHERENT_REASON_COUNTS", "metrics");
  }
  return normalized;
}

function normalizeMetrics(metrics, context) {
  if (!hasExactKeys(metrics, METRIC_KEYS)) fail("INVALID_PLAN_METRICS", "metrics");
  for (const key of METRIC_KEYS.filter((key) => !["elapsedMs", "reasonCounts"].includes(key))) {
    assertSafeNonNegativeInteger(metrics[key], "INVALID_PLAN_METRICS");
  }
  if (typeof metrics.elapsedMs !== "number" || !Number.isFinite(metrics.elapsedMs) ||
      metrics.elapsedMs < 0 || metrics.rssPeakBytes < metrics.rssStartBytes ||
      metrics.rssDeltaBytes !== metrics.rssPeakBytes - metrics.rssStartBytes) {
    fail("INVALID_PLAN_METRICS", "metrics");
  }
  const finalizedIdentityCount = context.clusters.reduce((sum, item) => sum + item.memberIds.length, 0);
  const deferredIdentityCount = context.deferred.reduce((sum, item) => sum + item.memberIds.length, 0);
  const unclusteredIdentityCount = context.unclustered.reduce((sum, item) => sum + item.memberIds.length, 0);
  const componentSizes = [...context.clusters, ...context.deferred, ...context.unclustered]
    .map((item) => item.memberIds.length);
  const maximumDispositionSize = componentSizes.length === 0 ? 0 : Math.max(...componentSizes);
  if (metrics.identityCount !== context.snapshot.identityCount ||
      metrics.finalizedIdentityCount !== finalizedIdentityCount ||
      metrics.deferredIdentityCount !== deferredIdentityCount ||
      metrics.unclusteredIdentityCount !== unclusteredIdentityCount ||
      metrics.componentCount !== context.clusters.length + context.deferred.length + context.unclustered.length ||
      metrics.completedComponentCount !== context.clusters.length ||
      metrics.deferredComponentCount !== context.deferred.length ||
      metrics.unclusteredComponentCount !== context.unclustered.length ||
      metrics.maximumComponentSize < maximumDispositionSize ||
      metrics.maximumComponentSize > context.snapshot.identityCount ||
      componentSizes.length === 0 && metrics.maximumComponentSize !== 0 ||
      metrics.maximumVectorsInMemory > metrics.maximumComponentSize ||
      metrics.maximumVectorsInMemory > context.budgets.maxComponentVectorsInMemory ||
      metrics.pairwiseComparisonCount > context.budgets.maxPairwiseComparisons ||
      metrics.canonicalEdgeCount > context.budgets.maxCandidateEdges ||
      metrics.canonicalEdgeCount > metrics.candidateEdgeCount) {
    fail("INCOHERENT_PLAN_METRICS", "metrics");
  }
  return {
    ...clone(metrics),
    reasonCounts: normalizeReasonCounts(metrics.reasonCounts, context.deferred, context.unclustered)
  };
}

function deriveStatus(clusters, deferred) {
  if (deferred.length === 0) return BOUNDED_CLUSTERING_STATUSES.COMPLETE;
  return clusters.length === 0
    ? BOUNDED_CLUSTERING_STATUSES.DEFERRED
    : BOUNDED_CLUSTERING_STATUSES.PARTIAL_DEFERRED;
}

function assertBarrierDisposition(provenance, clusters, deferred, unclustered) {
  const barrierReason = BOUNDED_CLUSTERING_REASON_CODES.DEFERRED_GLOBAL_BARRIER;
  if (provenance.globalBarrierStatus === GLOBAL_BARRIER_STATUSES.INCOMPLETE) {
    if (clusters.length !== 0 || unclustered.length !== 0 ||
        deferred.length === 0 || deferred.some((item) => item.reasonCode !== barrierReason)) {
      fail("INCOHERENT_GLOBAL_BARRIER", "barrier");
    }
  } else if (deferred.some((item) => item.reasonCode === barrierReason)) {
    fail("INCOHERENT_GLOBAL_BARRIER", "barrier");
  }
}

function planIdentityPayload(plan) {
  return {
    schemaVersion: plan.schemaVersion,
    algorithmVersion: plan.algorithmVersion,
    status: plan.status,
    policy: plan.policy,
    budgets: plan.budgets,
    provenance: plan.provenance,
    clusters: plan.clusters,
    deferredComponents: plan.deferredComponents,
    unclusteredComponents: plan.unclusteredComponents,
    persisted: plan.persisted
  };
}

function createBoundedClusteringPlan(input) {
  if (!hasExactKeys(input, PLAN_INPUT_KEYS) || !Array.isArray(input.clusters) ||
      !Array.isArray(input.deferredComponents) || !Array.isArray(input.unclusteredComponents)) {
    fail("INVALID_PLAN_INPUT", "input");
  }
  const snapshot = assertGlobalIdentitySnapshot(input.identitySnapshot);
  const policy = normalizePolicy(input.policy);
  const budgets = normalizeBudgets(input.budgets, policy);
  const provenance = normalizeProvenance(input.provenance, snapshot);
  const snapshotIds = new Set(snapshot.identities.map((identity) => identity.memoryId));
  const context = { snapshot, snapshotIds, policy, budgets };
  const clusters = input.clusters.map((item) => normalizeCluster(item, context)).sort(sortDisposition);
  const deferredComponents = input.deferredComponents
    .map((item) => normalizeDeferredComponent(item, context)).sort(sortDisposition);
  const unclusteredComponents = input.unclusteredComponents
    .map((item) => normalizeUnclusteredComponent(item, context)).sort(sortDisposition);
  assertCoverage(snapshot, clusters, deferredComponents, unclusteredComponents);
  assertBarrierDisposition(provenance, clusters, deferredComponents, unclusteredComponents);
  const metrics = normalizeMetrics(input.metrics, {
    snapshot, budgets, clusters, deferred: deferredComponents, unclustered: unclusteredComponents
  });
  const plan = {
    schemaVersion: BOUNDED_CLUSTERING_PLAN_SCHEMA_VERSION,
    algorithmVersion: BOUNDED_CLUSTERING_ALGORITHM_VERSION,
    planId: "",
    status: deriveStatus(clusters, deferredComponents),
    policy,
    budgets,
    provenance,
    clusters,
    deferredComponents,
    unclusteredComponents,
    metrics,
    persisted: false
  };
  plan.planId = sha256({ domain: "hippocampus-bounded-clustering-plan-id-v1", ...planIdentityPayload(plan) });
  return deepFreeze(plan);
}

function planToInput(plan, snapshot) {
  return {
    identitySnapshot: snapshot,
    policy: plan.policy,
    budgets: plan.budgets,
    provenance: {
      cacheSchemaVersion: plan.provenance.cacheSchemaVersion,
      embeddingModel: plan.provenance.embeddingModel,
      embeddingRevision: plan.provenance.embeddingRevision,
      globalBarrierStatus: plan.provenance.globalBarrierStatus
    },
    clusters: plan.clusters.map((cluster) => ({
      memberIds: cluster.memberIds,
      minimumPairSimilarity: cluster.minimumPairSimilarity,
      discoveryCompleteness: cluster.discoveryCompleteness,
      temporal: {
        orderedSourceIds: cluster.orderedSourceIds,
        unresolvedSourceIds: cluster.unresolvedSourceIds,
        temporalStart: cluster.temporalStart,
        temporalEnd: cluster.temporalEnd,
        timestampQuality: cluster.timestampQuality
      }
    })),
    deferredComponents: plan.deferredComponents.map((component) => ({
      memberIds: component.memberIds,
      reasonCode: component.reasonCode,
      discoveryCompleteness: component.discoveryCompleteness
    })),
    unclusteredComponents: plan.unclusteredComponents.map((component) => ({
      memberIds: component.memberIds,
      reasonCode: component.reasonCode,
      discoveryCompleteness: component.discoveryCompleteness
    })),
    metrics: plan.metrics
  };
}

function validateBoundedClusteringPlan(plan, identitySnapshot) {
  try {
    if (!hasExactKeys(plan, PLAN_KEYS) ||
        plan.schemaVersion !== BOUNDED_CLUSTERING_PLAN_SCHEMA_VERSION ||
        plan.algorithmVersion !== BOUNDED_CLUSTERING_ALGORITHM_VERSION ||
        !HEX_64.test(plan.planId || "") || plan.persisted !== false ||
        !Object.values(BOUNDED_CLUSTERING_STATUSES).includes(plan.status) ||
        !hasExactKeys(plan.provenance, PROVENANCE_KEYS) ||
        plan.provenance.plannerContractVersion !== PLANNER_CONTRACT_VERSION ||
        !Array.isArray(plan.clusters) || plan.clusters.some((item) => !hasExactKeys(item, CLUSTER_KEYS)) ||
        !Array.isArray(plan.deferredComponents) ||
          plan.deferredComponents.some((item) => !hasExactKeys(item, COMPONENT_KEYS)) ||
        !Array.isArray(plan.unclusteredComponents) ||
          plan.unclusteredComponents.some((item) => !hasExactKeys(item, COMPONENT_KEYS))) {
      fail("INVALID_BOUNDED_CLUSTERING_PLAN", "validation");
    }
    const recreated = createBoundedClusteringPlan(planToInput(plan, identitySnapshot));
    if (stableStringify(recreated) !== stableStringify(plan)) {
      fail("BOUNDED_CLUSTERING_PLAN_MISMATCH", "validation");
    }
    return deepFreeze({ valid: true, errors: [] });
  } catch (error) {
    const code = error instanceof HippocampusBoundedClusteringPlanError
      ? error.code
      : "INVALID_BOUNDED_CLUSTERING_PLAN";
    return deepFreeze({ valid: false, errors: [code] });
  }
}

module.exports = {
  BOUNDED_CLUSTERING_PLAN_SCHEMA_VERSION,
  GLOBAL_IDENTITY_SNAPSHOT_SCHEMA_VERSION,
  BOUNDED_CLUSTERING_POLICY_VERSION,
  BOUNDED_CLUSTERING_ALGORITHM_VERSION,
  BOUNDED_CLUSTERING_COMPARISON,
  PLANNER_CONTRACT_VERSION,
  BOUNDED_CLUSTERING_STATUSES,
  GLOBAL_BARRIER_STATUSES,
  DISCOVERY_COMPLETENESS,
  TIMESTAMP_QUALITY,
  BOUNDED_CLUSTERING_REASON_CODES,
  DEFAULT_BOUNDED_CLUSTERING_POLICY,
  HippocampusBoundedClusteringPlanError,
  compareCanonicalIdentities,
  createGlobalIdentitySnapshot,
  validateGlobalIdentitySnapshot,
  validateBoundedClusteringConfiguration,
  createBoundedClusteringPlan,
  validateBoundedClusteringPlan
};
