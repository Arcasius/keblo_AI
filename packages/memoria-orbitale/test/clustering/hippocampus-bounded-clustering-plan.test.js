"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const contract = require("../../core/clustering/HippocampusBoundedClusteringPlan");

const {
  BOUNDED_CLUSTERING_PLAN_SCHEMA_VERSION,
  GLOBAL_IDENTITY_SNAPSHOT_SCHEMA_VERSION,
  BOUNDED_CLUSTERING_POLICY_VERSION,
  BOUNDED_CLUSTERING_ALGORITHM_VERSION,
  BOUNDED_CLUSTERING_COMPARISON,
  BOUNDED_CLUSTERING_STATUSES,
  GLOBAL_BARRIER_STATUSES,
  DISCOVERY_COMPLETENESS,
  TIMESTAMP_QUALITY,
  BOUNDED_CLUSTERING_REASON_CODES: REASONS,
  DEFAULT_BOUNDED_CLUSTERING_POLICY,
  HippocampusBoundedClusteringPlanError,
  createGlobalIdentitySnapshot,
  validateGlobalIdentitySnapshot,
  createBoundedClusteringPlan,
  validateBoundedClusteringPlan
} = contract;

const MODEL = "BAAI/bge-m3";
const REVISION = "5617a9f61b028005a4858fdac845db406aefb181";
const PRIVATE = "PRIVATE_TEXT PRIVATE_USER SECRET_ENDPOINT API_KEY";

function hash(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function pointId(index) {
  const value = index.toString(16).padStart(32, "0");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-5${value.slice(13, 16)}-` +
    `8${value.slice(17, 20)}-${value.slice(20, 32)}`;
}

function identity(index) {
  return {
    memoryId: `memory-${index.toString().padStart(2, "0")}`,
    contentHash: hash(`synthetic-content-${index}`),
    pointId: pointId(index + 1),
    model: MODEL,
    revision: REVISION
  };
}

function snapshot(count = 7, reverse = false) {
  const identities = Array.from({ length: count }, (_, index) => identity(index));
  return createGlobalIdentitySnapshot({
    userIdHash: hash("synthetic-bounded-user"),
    identities: reverse ? identities.reverse() : identities
  });
}

function budgets(overrides = {}) {
  return {
    neighborLimit: 64,
    overfetchFactor: 4,
    scoreThreshold: 0.65,
    maxComponentVectorsInMemory: 128,
    maxPairwiseComparisons: 10000,
    maxCandidateEdges: 50000,
    maxClusterSize: 64,
    timeoutMs: 30000,
    maxRssDeltaBytes: 128 * 1024 * 1024,
    ...overrides
  };
}

function provenance(globalBarrierStatus = GLOBAL_BARRIER_STATUSES.COMPLETE) {
  return {
    cacheSchemaVersion: 1,
    embeddingModel: MODEL,
    embeddingRevision: REVISION,
    globalBarrierStatus
  };
}

function temporal(memberIds, overrides = {}) {
  return {
    orderedSourceIds: [],
    unresolvedSourceIds: [...memberIds].sort(),
    temporalStart: null,
    temporalEnd: null,
    timestampQuality: TIMESTAMP_QUALITY.NOT_EVALUATED,
    ...overrides
  };
}

function cluster(memberIds, overrides = {}) {
  return {
    memberIds,
    minimumPairSimilarity: 0.70,
    discoveryCompleteness: DISCOVERY_COMPLETENESS.COMPLETE_ABOVE_THRESHOLD,
    temporal: temporal(memberIds),
    ...overrides
  };
}

function deferred(memberIds, reasonCode, discoveryCompleteness) {
  return { memberIds, reasonCode, discoveryCompleteness };
}

function reasonCounts(deferredComponents = [], unclusteredComponents = [], stale = 0) {
  const counts = Object.fromEntries(Object.values(REASONS).map((reason) => [reason, 0]));
  for (const item of [...deferredComponents, ...unclusteredComponents]) counts[item.reasonCode] += 1;
  counts[REASONS.STALE_IDENTITY_REJECTED] = stale;
  return counts;
}

function metrics(sourceSnapshot, clusters, deferredComponents, unclusteredComponents, overrides = {}) {
  const sizes = [...clusters, ...deferredComponents, ...unclusteredComponents]
    .map((item) => item.memberIds.length);
  return {
    identityCount: sourceSnapshot.identityCount,
    finalizedIdentityCount: clusters.reduce((sum, item) => sum + item.memberIds.length, 0),
    deferredIdentityCount: deferredComponents.reduce((sum, item) => sum + item.memberIds.length, 0),
    unclusteredIdentityCount: unclusteredComponents.reduce((sum, item) => sum + item.memberIds.length, 0),
    neighborQueryCount: sourceSnapshot.identityCount,
    candidateEdgeCount: 8,
    canonicalEdgeCount: 4,
    componentCount: sizes.length,
    completedComponentCount: clusters.length,
    deferredComponentCount: deferredComponents.length,
    unclusteredComponentCount: unclusteredComponents.length,
    pairwiseComparisonCount: 3,
    maximumComponentSize: sizes.length === 0 ? 0 : Math.max(...sizes),
    maximumVectorsInMemory: sizes.length === 0 ? 0 : Math.max(...sizes),
    elapsedMs: 12.5,
    rssStartBytes: 1000,
    rssPeakBytes: 1400,
    rssDeltaBytes: 400,
    reasonCounts: reasonCounts(deferredComponents, unclusteredComponents),
    ...overrides
  };
}

function partialInput(overrides = {}) {
  const sourceSnapshot = overrides.identitySnapshot || snapshot();
  const clusters = overrides.clusters || [cluster(["memory-02", "memory-00", "memory-01"])];
  const deferredComponents = overrides.deferredComponents || [deferred(
    ["memory-04", "memory-03"],
    REASONS.DEFERRED_INCOMPLETE_NEIGHBOR_DISCOVERY,
    DISCOVERY_COMPLETENESS.INCOMPLETE_TRUNCATED
  )];
  const unclusteredComponents = overrides.unclusteredComponents || [deferred(
    ["memory-06", "memory-05"],
    REASONS.UNCLUSTERED_BELOW_MIN_SIZE,
    DISCOVERY_COMPLETENESS.COMPLETE_ABOVE_THRESHOLD
  )];
  return {
    identitySnapshot: sourceSnapshot,
    policy: overrides.policy || { ...DEFAULT_BOUNDED_CLUSTERING_POLICY },
    budgets: overrides.budgets || budgets(),
    provenance: overrides.provenance || provenance(),
    clusters,
    deferredComponents,
    unclusteredComponents,
    metrics: overrides.metrics || metrics(
      sourceSnapshot, clusters, deferredComponents, unclusteredComponents
    )
  };
}

function createPartial(overrides = {}) {
  return createBoundedClusteringPlan(partialInput(overrides));
}

test("exports the frozen BC-1 vocabulary and approved complete-link policy", () => {
  assert.equal(BOUNDED_CLUSTERING_PLAN_SCHEMA_VERSION, 1);
  assert.equal(GLOBAL_IDENTITY_SNAPSHOT_SCHEMA_VERSION, 1);
  assert.equal(BOUNDED_CLUSTERING_POLICY_VERSION, 1);
  assert.equal(BOUNDED_CLUSTERING_ALGORITHM_VERSION, "hippocampus-bounded-complete-link-v1");
  assert.equal(BOUNDED_CLUSTERING_COMPARISON, "GREATER_THAN_OR_EQUAL");
  assert.deepEqual(DEFAULT_BOUNDED_CLUSTERING_POLICY, {
    policyVersion: 1, clusterThreshold: 0.70, minClusterSize: 3,
    comparison: "GREATER_THAN_OR_EQUAL"
  });
  for (const value of [BOUNDED_CLUSTERING_STATUSES, GLOBAL_BARRIER_STATUSES,
    DISCOVERY_COMPLETENESS, TIMESTAMP_QUALITY, REASONS,
    DEFAULT_BOUNDED_CLUSTERING_POLICY]) assert.equal(Object.isFrozen(value), true);
  assert.deepEqual(Object.values(REASONS).sort(), [
    "DEFERRED_DENSE_COMPONENT", "DEFERRED_EDGE_BUDGET", "DEFERRED_GLOBAL_BARRIER",
    "DEFERRED_INCOMPLETE_NEIGHBOR_DISCOVERY", "DEFERRED_OVERSIZED_CLUSTER",
    "DEFERRED_PAIRWISE_BUDGET", "DEFERRED_RSS_BUDGET", "DEFERRED_TIMEOUT",
    "STALE_IDENTITY_REJECTED", "UNCLUSTERED_BELOW_MIN_SIZE"
  ]);
});

test("global identity snapshot is canonical, deterministic and contains no clear user", () => {
  const direct = snapshot(7, false);
  const reversed = snapshot(7, true);
  assert.deepEqual(direct, reversed);
  assert.equal(direct.identityCount, 7);
  assert.match(direct.snapshotFingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(direct.identities.map((item) => item.memoryId),
    Array.from({ length: 7 }, (_, index) => `memory-${index.toString().padStart(2, "0")}`));
  assert.equal(JSON.stringify(direct).includes("synthetic-bounded-user"), false);
  assert.equal(Object.isFrozen(direct), true);
  assert.equal(Object.isFrozen(direct.identities[0]), true);
  assert.deepEqual(validateGlobalIdentitySnapshot(direct), { valid: true, errors: [] });
});

test("snapshot fingerprint rejects tampering, duplicates and mixed provenance", () => {
  const valid = snapshot();
  assert.deepEqual(validateGlobalIdentitySnapshot({
    ...valid, snapshotFingerprint: hash("tampered")
  }), { valid: false, errors: ["SNAPSHOT_FINGERPRINT_MISMATCH"] });
  assert.throws(() => createGlobalIdentitySnapshot({
    userIdHash: hash("user"), identities: [identity(0), identity(0)]
  }), { code: "DUPLICATE_SNAPSHOT_IDENTITY" });
  assert.throws(() => createGlobalIdentitySnapshot({
    userIdHash: hash("user"), identities: [identity(0), { ...identity(1), revision: "other" }]
  }), { code: "MIXED_SNAPSHOT_PROVENANCE" });
});

test("PARTIAL_DEFERRED output is closed, immutable and has total disjoint coverage", () => {
  const plan = createPartial();
  assert.equal(plan.status, BOUNDED_CLUSTERING_STATUSES.PARTIAL_DEFERRED);
  assert.equal(plan.algorithmVersion, BOUNDED_CLUSTERING_ALGORITHM_VERSION);
  assert.equal(plan.persisted, false);
  assert.equal(plan.clusters.length, 1);
  assert.equal(plan.deferredComponents.length, 1);
  assert.equal(plan.unclusteredComponents.length, 1);
  assert.deepEqual(plan.clusters[0].memberIds, ["memory-00", "memory-01", "memory-02"]);
  assert.equal(plan.clusters[0].minimumPairSimilarity, 0.70);
  assert.equal(plan.deferredComponents[0].memberCount, 2);
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(Object.isFrozen(plan.metrics.reasonCounts), true);
  assert.deepEqual(validateBoundedClusteringPlan(plan, partialInput().identitySnapshot), {
    valid: true, errors: []
  });
});

test("threshold is inclusive and final clusters require complete discovery", () => {
  assert.equal(createPartial().clusters[0].minimumPairSimilarity, 0.70);
  assert.throws(() => createPartial({ clusters: [cluster(
    ["memory-00", "memory-01", "memory-02"],
    { minimumPairSimilarity: 0.699999 }
  )] }), { code: "INVALID_FINAL_CLUSTER" });
  assert.throws(() => createPartial({ clusters: [cluster(
    ["memory-00", "memory-01", "memory-02"],
    { discoveryCompleteness: DISCOVERY_COMPLETENESS.INCOMPLETE_UNCERTIFIED }
  )] }), { code: "INVALID_FINAL_CLUSTER" });
});

test("identity dispositions cannot overlap or omit a current identity", () => {
  assert.throws(() => createPartial({
    deferredComponents: [deferred(
      ["memory-02", "memory-03", "memory-04"],
      REASONS.DEFERRED_DENSE_COMPONENT,
      DISCOVERY_COMPLETENESS.COMPLETE_ABOVE_THRESHOLD
    )]
  }), { code: "OVERLAPPING_IDENTITY_DISPOSITION" });
  assert.throws(() => createPartial({ unclusteredComponents: [] }), {
    code: "INCOMPLETE_IDENTITY_COVERAGE"
  });
});

test("incomplete global barrier permits only wholly deferred identities", () => {
  const sourceSnapshot = snapshot(4);
  const deferredComponents = [deferred(
    sourceSnapshot.identities.map((item) => item.memoryId),
    REASONS.DEFERRED_GLOBAL_BARRIER,
    DISCOVERY_COMPLETENESS.INCOMPLETE_UNCERTIFIED
  )];
  const plan = createBoundedClusteringPlan({
    identitySnapshot: sourceSnapshot,
    policy: { ...DEFAULT_BOUNDED_CLUSTERING_POLICY },
    budgets: budgets(),
    provenance: provenance(GLOBAL_BARRIER_STATUSES.INCOMPLETE),
    clusters: [],
    deferredComponents,
    unclusteredComponents: [],
    metrics: metrics(sourceSnapshot, [], deferredComponents, [])
  });
  assert.equal(plan.status, BOUNDED_CLUSTERING_STATUSES.DEFERRED);
  assert.throws(() => createPartial({
    provenance: provenance(GLOBAL_BARRIER_STATUSES.INCOMPLETE)
  }), { code: "INCOHERENT_GLOBAL_BARRIER" });
});

test("a complete plan may contain final clusters and terminal below-minimum groups", () => {
  const sourceSnapshot = snapshot(5);
  const clusters = [cluster(["memory-00", "memory-01", "memory-02"])];
  const unclusteredComponents = [deferred(
    ["memory-03", "memory-04"],
    REASONS.UNCLUSTERED_BELOW_MIN_SIZE,
    DISCOVERY_COMPLETENESS.COMPLETE_ABOVE_THRESHOLD
  )];
  const plan = createBoundedClusteringPlan({
    identitySnapshot: sourceSnapshot,
    policy: { ...DEFAULT_BOUNDED_CLUSTERING_POLICY },
    budgets: budgets(),
    provenance: provenance(),
    clusters,
    deferredComponents: [],
    unclusteredComponents,
    metrics: metrics(sourceSnapshot, clusters, [], unclusteredComponents)
  });
  assert.equal(plan.status, BOUNDED_CLUSTERING_STATUSES.COMPLETE);
});

test("input and disposition order do not affect snapshot, clusters or plan identity", () => {
  const baseline = createPartial();
  const reversedSnapshot = snapshot(7, true);
  const reversed = createBoundedClusteringPlan(partialInput({
    identitySnapshot: reversedSnapshot,
    clusters: [cluster(["memory-01", "memory-02", "memory-00"])],
    deferredComponents: [deferred(
      ["memory-03", "memory-04"],
      REASONS.DEFERRED_INCOMPLETE_NEIGHBOR_DISCOVERY,
      DISCOVERY_COMPLETENESS.INCOMPLETE_TRUNCATED
    )],
    unclusteredComponents: [deferred(
      ["memory-05", "memory-06"],
      REASONS.UNCLUSTERED_BELOW_MIN_SIZE,
      DISCOVERY_COMPLETENESS.COMPLETE_ABOVE_THRESHOLD
    )]
  }));
  assert.deepEqual(reversed, baseline);
});

test("operational metrics affect neither clusterId nor planId", () => {
  const first = createPartial();
  const input = partialInput();
  input.metrics = {
    ...input.metrics,
    elapsedMs: 999,
    rssStartBytes: 2000,
    rssPeakBytes: 2700,
    rssDeltaBytes: 700
  };
  const second = createBoundedClusteringPlan(input);
  assert.equal(first.clusters[0].clusterId, second.clusters[0].clusterId);
  assert.equal(first.planId, second.planId);
  assert.notDeepEqual(first.metrics, second.metrics);
});

test("temporal fields are separate from semantic cluster identity", () => {
  const first = createPartial();
  const input = partialInput();
  input.clusters = [cluster(["memory-00", "memory-01", "memory-02"], {
    temporal: temporal(["memory-00", "memory-01", "memory-02"], {
      orderedSourceIds: ["memory-02", "memory-00", "memory-01"],
      unresolvedSourceIds: [],
      temporalStart: 100,
      temporalEnd: 300,
      timestampQuality: TIMESTAMP_QUALITY.COMPLETE
    })
  })];
  input.metrics = metrics(input.identitySnapshot, input.clusters,
    input.deferredComponents, input.unclusteredComponents);
  const second = createBoundedClusteringPlan(input);
  assert.equal(first.clusters[0].clusterId, second.clusters[0].clusterId);
  assert.notEqual(first.planId, second.planId);
});

test("temporal descriptor requires an exact partition and explicit unknown state", () => {
  assert.throws(() => createPartial({ clusters: [cluster(
    ["memory-00", "memory-01", "memory-02"],
    { temporal: temporal(["memory-00", "memory-01" ]) }
  )] }), { code: "INVALID_TEMPORAL_PARTITION" });
  assert.throws(() => createPartial({ clusters: [cluster(
    ["memory-00", "memory-01", "memory-02"],
    { temporal: temporal(["memory-00", "memory-01", "memory-02"], {
      orderedSourceIds: ["memory-00"], timestampQuality: TIMESTAMP_QUALITY.NOT_EVALUATED
    }) }
  )] }), { code: "INVALID_TEMPORAL_PARTITION" });
});

test("policy is frozen at 0.70/minimum three and budgets have no implicit five", () => {
  for (const policy of [
    { ...DEFAULT_BOUNDED_CLUSTERING_POLICY, clusterThreshold: 0.71 },
    { ...DEFAULT_BOUNDED_CLUSTERING_POLICY, minClusterSize: 2 },
    { ...DEFAULT_BOUNDED_CLUSTERING_POLICY, comparison: "GREATER_THAN" }
  ]) assert.throws(() => createPartial({ policy }), { code: "INVALID_BOUNDED_CLUSTERING_POLICY" });
  assert.equal(createPartial({ budgets: budgets({ neighborLimit: 1 }) }).budgets.neighborLimit, 1);
  assert.equal(createPartial({ budgets: budgets({ neighborLimit: 500 }) }).budgets.neighborLimit, 500);
  assert.throws(() => createPartial({ budgets: budgets({ scoreThreshold: 0.71 }) }), {
    code: "INVALID_BOUNDED_CLUSTERING_BUDGETS"
  });
});

test("maxClusterSize is a safety gate and never truncates final membership", () => {
  assert.throws(() => createPartial({ budgets: budgets({ maxClusterSize: 2 }) }), {
    code: "INVALID_BOUNDED_CLUSTERING_BUDGETS"
  });
  assert.throws(() => createPartial({ budgets: budgets({ maxClusterSize: 3 }), clusters: [cluster(
    ["memory-00", "memory-01", "memory-02", "memory-03"]
  )] }), { code: "INVALID_FINAL_CLUSTER_SIZE" });
});

test("failed or truncated discovery can only be represented as deferred", () => {
  const input = partialInput();
  input.deferredComponents = [deferred(
    ["memory-03", "memory-04"],
    REASONS.DEFERRED_INCOMPLETE_NEIGHBOR_DISCOVERY,
    DISCOVERY_COMPLETENESS.FAILED
  )];
  input.metrics = metrics(input.identitySnapshot, input.clusters,
    input.deferredComponents, input.unclusteredComponents);
  assert.equal(createBoundedClusteringPlan(input).status, BOUNDED_CLUSTERING_STATUSES.PARTIAL_DEFERRED);
  assert.throws(() => createPartial({ deferredComponents: [deferred(
    ["memory-03", "memory-04"],
    REASONS.DEFERRED_DENSE_COMPONENT,
    DISCOVERY_COMPLETENESS.FAILED
  )] }), { code: "INCOHERENT_DISCOVERY_DISPOSITION" });
});

test("metrics are closed, bounded and coherent with component dispositions", () => {
  const input = partialInput();
  input.metrics = { ...input.metrics, pairwiseComparisonCount: 10001 };
  assert.throws(() => createBoundedClusteringPlan(input), { code: "INCOHERENT_PLAN_METRICS" });
  const wrong = partialInput();
  wrong.metrics = { ...wrong.metrics, deferredIdentityCount: 1 };
  assert.throws(() => createBoundedClusteringPlan(wrong), { code: "INCOHERENT_PLAN_METRICS" });
  const unknown = partialInput();
  unknown.metrics = { ...unknown.metrics, privateMetric: 1 };
  assert.throws(() => createBoundedClusteringPlan(unknown), { code: "INVALID_PLAN_METRICS" });
});

test("plan validator rejects shape, planId and snapshot binding tampering", () => {
  const input = partialInput();
  const plan = createBoundedClusteringPlan(input);
  assert.equal(validateBoundedClusteringPlan({ ...plan, private: true }, input.identitySnapshot).valid, false);
  assert.equal(validateBoundedClusteringPlan({ ...plan, planId: hash("tampered") }, input.identitySnapshot).valid, false);
  assert.equal(validateBoundedClusteringPlan(plan, snapshot(8)).valid, false);
});

test("empty authoritative snapshot produces a deterministic complete empty plan", () => {
  const sourceSnapshot = snapshot(0);
  const plan = createBoundedClusteringPlan({
    identitySnapshot: sourceSnapshot,
    policy: { ...DEFAULT_BOUNDED_CLUSTERING_POLICY },
    budgets: budgets(),
    provenance: provenance(),
    clusters: [], deferredComponents: [], unclusteredComponents: [],
    metrics: metrics(sourceSnapshot, [], [], [], {
      neighborQueryCount: 0, candidateEdgeCount: 0, canonicalEdgeCount: 0,
      pairwiseComparisonCount: 0, elapsedMs: 0, rssStartBytes: 0,
      rssPeakBytes: 0, rssDeltaBytes: 0
    })
  });
  assert.equal(plan.status, BOUNDED_CLUSTERING_STATUSES.COMPLETE);
  assert.equal(plan.metrics.identityCount, 0);
});

test("output and errors expose no text, vectors, centroid, userId, endpoint or secret", () => {
  const plan = createPartial();
  const serialized = JSON.stringify(plan);
  assert.equal(serialized.includes(PRIVATE), false);
  const forbiddenKeys = new Set([
    "text", "vector", "centroid", "userId", "endpoint", "apiKey", "payload"
  ]);
  function inspect(value) {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      assert.equal(value.length === 1024 && value.every((item) => typeof item === "number"), false);
      for (const item of value) inspect(item);
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      assert.equal(forbiddenKeys.has(key), false);
      inspect(child);
    }
  }
  inspect(plan);
  try {
    createGlobalIdentitySnapshot({ userIdHash: PRIVATE, identities: [] });
    assert.fail("expected failure");
  } catch (error) {
    assert.equal(error instanceof HippocampusBoundedClusteringPlanError, true);
    assert.equal(JSON.stringify(error).includes(PRIVATE), false);
    assert.equal(error.retryable, false);
  }
});

test("BC-1 module is pure and imports no runtime, provider, storage or legacy cluster", () => {
  const source = fs.readFileSync(path.join(
    __dirname, "../../core/clustering/HippocampusBoundedClusteringPlan.js"
  ), "utf8");
  assert.doesNotMatch(source, /ClusterEngineAdapter|ClusterRecord|HippocampusDaemon|RecallRouter/);
  assert.doesNotMatch(source, /Qdrant|BgeM3|Qwen|Ollama|JsonMemoryStorage|Keblomemory/);
  assert.doesNotMatch(source, /fetch\s*\(|https?:|process\.env|Promise\.all|Date\.now|randomUUID/);
  assert.doesNotMatch(source, /deletePoints|upsertPoints|createCollection|writeMemory|commit/);
  assert.deepEqual([...source.matchAll(/require\(([^)]+)\)/g)].map((match) => match[1]), ["\"node:crypto\""]);
});
