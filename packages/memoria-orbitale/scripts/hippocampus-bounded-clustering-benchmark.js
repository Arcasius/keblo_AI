"use strict";

const { createHash } = require("node:crypto");
const { performance } = require("node:perf_hooks");
const {
  BOUNDED_CLUSTERING_REASON_CODES,
  DEFAULT_BOUNDED_CLUSTERING_POLICY,
  DISCOVERY_COMPLETENESS,
  compareCanonicalIdentities,
  createGlobalIdentitySnapshot
} = require("../core/clustering/HippocampusBoundedClusteringPlan");
const {
  createHippocampusCandidateGraphBuilder
} = require("../core/clustering/HippocampusCandidateGraphBuilder");
const {
  THRESHOLD_DISCOVERY_CERTIFICATE_VERSION,
  THRESHOLD_DISCOVERY_MODE
} = require("../core/clustering/HippocampusDiscoveryCompleteness");
const {
  VECTOR_DIMENSION,
  createHippocampusBoundedCompleteLinkRefiner
} = require("../core/clustering/HippocampusBoundedCompleteLinkRefiner");
const {
  createTemporalClusterProvenance
} = require("../core/clustering/HippocampusTemporalProvenance");

const COMPLETE = DISCOVERY_COMPLETENESS.COMPLETE_ABOVE_THRESHOLD;
const LEVELS = Object.freeze([100, 1000, 10000, 40000]);
const SYMBOLIC_BATCH_SIZES = Object.freeze([1, 2, 17, 50, 128]);
const DEFAULT_BENCHMARK_BUDGETS = Object.freeze({
  overallTimeoutMs: 180000,
  candidateTimeoutMs: 120000,
  refinementTimeoutMs: 120000,
  maxRssDeltaBytes: 536870912,
  maxComponentVectorsInMemory: 32,
  maxPairwiseComparisons: 10000,
  maxClusterSize: 8,
  maxCandidateEdgesFactor: 3,
  maxNeighborQueriesFactor: 1
});

function sha256(value) {
  return createHash("sha256").update(typeof value === "string"
    ? value
    : stableStringify(value), "utf8").digest("hex");
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function pointId(index) {
  const hex = sha256(`bc6-point-${index}`);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}` +
    `-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function makeIdentity(index) {
  return {
    memoryId: `bc6-memory-${String(index).padStart(5, "0")}`,
    contentHash: sha256(`bc6-content-${index}`),
    pointId: pointId(index),
    model: "bc6-synthetic-model",
    revision: "bc6-synthetic-revision"
  };
}

function neighborsFor(index, identityCount) {
  if (index < 9) {
    const start = Math.floor(index / 3) * 3;
    return [start, start + 1, start + 2].filter((candidate) => candidate !== index);
  }
  if (index === 9) return [10];
  if (index === 10) return [9, 11];
  if (index === 11) return [10];
  if (index === 12) return [13];
  if (index === 13) return [12];
  if (index === 14) return [15];
  if (index === 15) return [14];
  const neighbors = [];
  if (index > 16) neighbors.push(index - 1);
  if (index + 1 < identityCount) neighbors.push(index + 1);
  return neighbors;
}

function unit(x, y) {
  const vector = new Array(VECTOR_DIMENSION).fill(0);
  vector[0] = x;
  vector[1] = y;
  return vector;
}

function vectorFor(index) {
  if (index === 9) return unit(1, 0);
  if (index === 10) return unit(0.8, 0.6);
  if (index === 11) return unit(0.28, 0.96);
  if (index === 12 || index === 13) return unit(0, 1);
  return unit(1, 0);
}

function createSyntheticDataset(identityCount, order = "direct") {
  if (!Number.isSafeInteger(identityCount) || identityCount < 100) {
    throw new Error("BC6_IDENTITY_COUNT_TOO_SMALL");
  }
  const raw = Array.from({ length: identityCount }, (_, index) => makeIdentity(index));
  if (order === "inverse") raw.reverse();
  const identitySnapshot = createGlobalIdentitySnapshot({
    userIdHash: sha256("bc6-synthetic-user"),
    identities: raw
  });
  const indexByPointId = new Map(Array.from({ length: identityCount }, (_, index) =>
    [pointId(index), index]));
  const identityByIndex = new Map(identitySnapshot.identities.map((identity) =>
    [indexByPointId.get(identity.pointId), identity]));
  return Object.freeze({ identityCount, identitySnapshot, indexByPointId, identityByIndex });
}

function verifySymbolicBatchInvariance(identityCount = 100) {
  const expected = createSyntheticDataset(identityCount).identitySnapshot.snapshotFingerprint;
  return SYMBOLIC_BATCH_SIZES.every((batchSize) => {
    const identities = [];
    for (let start = 0; start < identityCount; start += batchSize) {
      const end = Math.min(identityCount, start + batchSize);
      for (let index = start; index < end; index += 1) identities.push(makeIdentity(index));
    }
    return createGlobalIdentitySnapshot({
      userIdHash: sha256("bc6-synthetic-user"), identities
    }).snapshotFingerprint === expected;
  });
}

function certificate(dataset, query, count) {
  return {
    certificateVersion: THRESHOLD_DISCOVERY_CERTIFICATE_VERSION,
    mode: THRESHOLD_DISCOVERY_MODE,
    identityIndexFingerprint: dataset.identitySnapshot.snapshotFingerprint,
    queryPointId: query.pointId,
    clusterThreshold: DEFAULT_BOUNDED_CLUSTERING_POLICY.clusterThreshold,
    embeddingModel: query.model,
    embeddingRevision: query.revision,
    eligibleIdentityCount: dataset.identityCount - 1,
    enumeratedAboveThresholdCount: count,
    exhausted: true,
    truncated: false,
    continuation: null
  };
}

function makeDiscoveryProvider(dataset, variant) {
  return {
    async discoverNeighbors({ queryIdentity }) {
      const index = dataset.indexByPointId.get(queryIdentity.pointId);
      const neighborIndexes = neighborsFor(index, dataset.identityCount);
      let hits = neighborIndexes.map((neighborIndex) => ({
        ...dataset.identityByIndex.get(neighborIndex), score: 0.8
      }));
      if ((variant + index) % 2 === 1) hits.reverse();
      if (index % 97 === 0 && hits.length > 0) hits.push({ ...hits[0] });
      if (index === 0) {
        hits.push({
          ...dataset.identityByIndex.get(1),
          pointId: pointId(dataset.identityCount + 1),
          score: 0.9
        });
      }
      if (index === 14) {
        return {
          discoveryCompleteness: DISCOVERY_COMPLETENESS.INCOMPLETE_TRUNCATED,
          hits
        };
      }
      if (index === 15) return { discoveryCompleteness: COMPLETE, hits };
      const uniqueCount = new Set(neighborIndexes).size;
      const queryCertificate = certificate(dataset, queryIdentity, uniqueCount);
      if ((variant + index) % 3 === 0) {
        return { certificate: queryCertificate, hits, discoveryCompleteness: COMPLETE };
      }
      return { discoveryCompleteness: COMPLETE, hits, certificate: queryCertificate };
    }
  };
}

function makeEmbeddingResolver(dataset, variant) {
  let callCount = 0;
  return {
    cacheSchemaVersion: 1,
    get callCount() { return callCount; },
    async resolveEmbedding({ identity, identitySnapshotFingerprint }) {
      callCount += 1;
      if ((variant + callCount) % 2 === 0) await Promise.resolve();
      const index = dataset.indexByPointId.get(identity.pointId);
      return {
        provenance: {
          cacheSchemaVersion: 1,
          identitySnapshotFingerprint,
          pointId: identity.pointId,
          memoryId: identity.memoryId,
          contentHash: identity.contentHash,
          model: identity.model,
          revision: identity.revision,
          dimension: VECTOR_DIMENSION,
          normalized: true
        },
        vector: vectorFor(index)
      };
    }
  };
}

function cosine(left, right) {
  let sum = 0;
  for (let index = 0; index < VECTOR_DIMENSION; index += 1) sum += left[index] * right[index];
  return sum;
}

function dispositions(plan) {
  return {
    clusters: plan.clusters.map((cluster) => ({
      memberIds: cluster.memberIds,
      minimumPairSimilarity: cluster.minimumPairSimilarity
    })),
    deferred: plan.deferredComponents.map((item) => ({
      memberIds: item.memberIds,
      reasonCode: item.reasonCode
    })),
    unclustered: plan.unclusteredComponents.map((item) => ({
      memberIds: item.memberIds,
      reasonCode: item.reasonCode
    }))
  };
}

function referenceCompleteLink(dataset, graph, budgets) {
  const byPointId = new Map(dataset.identitySnapshot.identities.map((identity) =>
    [identity.pointId, identity]));
  const result = { clusters: [], deferred: [], unclustered: [] };
  for (const component of graph.components) {
    const identities = component.memberIds.map((id) => byPointId.get(id))
      .sort(compareCanonicalIdentities);
    const memberIds = identities.map((identity) => identity.memoryId).sort();
    if (!component.finalizationAuthorized) {
      result.deferred.push({ memberIds, reasonCode: BOUNDED_CLUSTERING_REASON_CODES
        .DEFERRED_INCOMPLETE_NEIGHBOR_DISCOVERY });
      continue;
    }
    if (identities.length > budgets.maxComponentVectorsInMemory) {
      result.deferred.push({ memberIds, reasonCode: BOUNDED_CLUSTERING_REASON_CODES
        .DEFERRED_DENSE_COMPONENT });
      continue;
    }
    const assigned = new Set();
    for (const seed of identities) {
      if (assigned.has(seed.pointId)) continue;
      const group = [seed];
      assigned.add(seed.pointId);
      for (const candidate of identities) {
        if (assigned.has(candidate.pointId)) continue;
        const accepted = group.every((existing) => cosine(
          vectorFor(dataset.indexByPointId.get(candidate.pointId)),
          vectorFor(dataset.indexByPointId.get(existing.pointId))
        ) >= DEFAULT_BOUNDED_CLUSTERING_POLICY.clusterThreshold);
        if (accepted) {
          group.push(candidate);
          assigned.add(candidate.pointId);
        }
      }
      const groupIds = group.map((identity) => identity.memoryId).sort();
      if (group.length < DEFAULT_BOUNDED_CLUSTERING_POLICY.minClusterSize) {
        result.unclustered.push({ memberIds: groupIds, reasonCode: BOUNDED_CLUSTERING_REASON_CODES
          .UNCLUSTERED_BELOW_MIN_SIZE });
      } else if (group.length > budgets.maxClusterSize) {
        result.deferred.push({ memberIds: groupIds, reasonCode: BOUNDED_CLUSTERING_REASON_CODES
          .DEFERRED_OVERSIZED_CLUSTER });
      } else {
        let minimumPairSimilarity = 1;
        for (let left = 0; left < group.length; left += 1) {
          for (let right = left + 1; right < group.length; right += 1) {
            minimumPairSimilarity = Math.min(minimumPairSimilarity, cosine(
              vectorFor(dataset.indexByPointId.get(group[left].pointId)),
              vectorFor(dataset.indexByPointId.get(group[right].pointId))
            ));
          }
        }
        result.clusters.push({ memberIds: groupIds, minimumPairSimilarity });
      }
    }
  }
  for (const values of Object.values(result)) values.sort((left, right) =>
    left.memberIds[0].localeCompare(right.memberIds[0]));
  return result;
}

function temporalSources(cluster, dataset, clusterIndex) {
  return cluster.memberIds.map((memoryId, memberIndex) => {
    const identity = dataset.identitySnapshot.identities.find((item) =>
      item.memoryId === memoryId);
    let timestamp = 1700000000000 + memberIndex;
    if (clusterIndex === 1 && memberIndex === 1) timestamp = null;
    if (clusterIndex === 2 && memberIndex === 1) timestamp = "invalid";
    if (clusterIndex === 2 && memberIndex === 2) timestamp = null;
    return {
      memoryId,
      contentHash: identity.contentHash,
      sourceContract: "flat",
      timestamp,
      lastAccess: 9999999999999,
      eventTimeEvidence: null
    };
  });
}

function semanticProjection(graph, plan, temporal) {
  return {
    graphId: graph.graphId,
    components: graph.components.map((component) => ({
      componentId: component.componentId,
      memberIds: component.memberIds,
      reasonCode: component.reasonCode
    })),
    clusters: plan.clusters.map((cluster) => ({
      clusterId: cluster.clusterId,
      memberIds: cluster.memberIds,
      minimumPairSimilarity: cluster.minimumPairSimilarity
    })),
    deferred: plan.deferredComponents.map((item) => ({
      memberIds: item.memberIds, reasonCode: item.reasonCode
    })),
    unclustered: plan.unclusteredComponents.map((item) => ({
      memberIds: item.memberIds, reasonCode: item.reasonCode
    })),
    temporal: temporal.map((item) => ({
      clusterId: item.clusterId,
      timestampQuality: item.timestampQuality,
      chronologicalSourceIds: item.chronologicalSourceIds,
      undatedSourceIds: item.undatedSourceIds
    }))
  };
}

async function runBenchmarkLevel(identityCount, options = {}) {
  const variant = options.variant || 0;
  const rssRead = options.rssRead || (() => process.memoryUsage().rss);
  const now = options.now || (() => performance.now());
  const budgets = { ...DEFAULT_BENCHMARK_BUDGETS, ...(options.budgets || {}) };
  const startedAt = now();
  const rssStartBytes = rssRead();
  let rssPeakBytes = rssStartBytes;
  const observeRss = () => {
    const value = rssRead();
    rssPeakBytes = Math.max(rssPeakBytes, value);
    return value;
  };
  const dataset = createSyntheticDataset(identityCount, variant % 2 ? "inverse" : "direct");
  observeRss();
  const graphBuilder = createHippocampusCandidateGraphBuilder({
    discoveryProvider: makeDiscoveryProvider(dataset, variant),
    maxNeighborQueries: identityCount * budgets.maxNeighborQueriesFactor,
    maxCandidateEdges: identityCount * budgets.maxCandidateEdgesFactor,
    timeoutMs: budgets.candidateTimeoutMs
  });
  const graph = await graphBuilder.build({
    identitySnapshot: dataset.identitySnapshot,
    signal: new AbortController().signal
  });
  observeRss();
  const resolver = makeEmbeddingResolver(dataset, variant);
  const refiner = createHippocampusBoundedCompleteLinkRefiner({
    embeddingResolver: resolver,
    rssReader: { readRssBytes: observeRss },
    clock: { now }
  });
  const refinementBudgets = {
    neighborLimit: 128,
    overfetchFactor: 4,
    scoreThreshold: 0.65,
    maxComponentVectorsInMemory: budgets.maxComponentVectorsInMemory,
    maxPairwiseComparisons: budgets.maxPairwiseComparisons,
    maxCandidateEdges: identityCount * budgets.maxCandidateEdgesFactor,
    maxClusterSize: budgets.maxClusterSize,
    timeoutMs: budgets.refinementTimeoutMs,
    maxRssDeltaBytes: budgets.maxRssDeltaBytes
  };
  const plan = await refiner.refine({
    identitySnapshot: dataset.identitySnapshot,
    candidateGraph: graph,
    policy: DEFAULT_BOUNDED_CLUSTERING_POLICY,
    budgets: refinementBudgets,
    signal: new AbortController().signal
  });
  const temporal = plan.clusters.map((cluster, index) => createTemporalClusterProvenance({
    identitySnapshot: dataset.identitySnapshot,
    boundedClusteringPlan: plan,
    clusterId: cluster.clusterId,
    sources: temporalSources(cluster, dataset, index)
  }));
  observeRss();
  const projection = semanticProjection(graph, plan, temporal);
  const chainIds = [9, 10, 11].map((index) => dataset.identityByIndex.get(index).memoryId);
  const chainRejected = !plan.clusters.some((cluster) =>
    chainIds.every((memoryId) => cluster.memberIds.includes(memoryId)));
  const denseDeferred = plan.deferredComponents.some((item) =>
    item.reasonCode === BOUNDED_CLUSTERING_REASON_CODES.DEFERRED_DENSE_COMPONENT &&
    item.memberIds.length === identityCount - 16);
  const incompleteDeferred = plan.deferredComponents.some((item) =>
    item.reasonCode === BOUNDED_CLUSTERING_REASON_CODES
      .DEFERRED_INCOMPLETE_NEIGHBOR_DISCOVERY);
  const referenceEquivalent = identityCount === 100
    ? stableStringify(dispositions(plan)) ===
      stableStringify(referenceCompleteLink(dataset, graph, refinementBudgets))
    : null;
  const finishedAt = now();
  const report = {
    identityCount,
    budgets: {
      overallTimeoutMs: budgets.overallTimeoutMs,
      candidateTimeoutMs: budgets.candidateTimeoutMs,
      refinementTimeoutMs: budgets.refinementTimeoutMs,
      maxRssDeltaBytes: budgets.maxRssDeltaBytes,
      maxComponentVectorsInMemory: budgets.maxComponentVectorsInMemory,
      maxPairwiseComparisons: budgets.maxPairwiseComparisons,
      maxClusterSize: budgets.maxClusterSize,
      maxCandidateEdges: identityCount * budgets.maxCandidateEdgesFactor,
      maxNeighborQueries: identityCount * budgets.maxNeighborQueriesFactor
    },
    metrics: {
      identityCount,
      neighborQueryCount: graph.metrics.neighborQueryCount,
      candidateEdgeCount: graph.metrics.acceptedObservationCount,
      canonicalEdgeCount: graph.edges.length,
      componentCount: graph.components.length,
      completedComponentCount: plan.clusters.length,
      deferredComponentCount: plan.deferredComponents.length,
      pairwiseComparisonCount: plan.metrics.pairwiseComparisonCount,
      maximumComponentSize: graph.metrics.maximumComponentSize,
      maximumVectorsInMemory: plan.metrics.maximumVectorsInMemory,
      elapsedMs: finishedAt - startedAt,
      rssStartBytes,
      rssPeakBytes,
      rssDeltaBytes: rssPeakBytes - rssStartBytes
    },
    checks: {
      referenceEquivalent,
      chainRejected,
      denseDeferred,
      incompleteDeferred,
      vectorRetrieveCount: resolver.callCount,
      preparedSnapshotValidationCount: graphBuilder.getLastPreparationDiagnostics()
        .snapshotValidationCount,
      preparedCertificateQueryLookupCount: graphBuilder.getLastPreparationDiagnostics()
        .certificateQueryLookupCount,
      symbolicBatchInvariant: identityCount === 100
        ? verifySymbolicBatchInvariance(identityCount)
        : null,
      crossBatchAffinity1To50: identityCount === 100 && neighborsFor(0, identityCount).includes(1)
    },
    semanticDigest: sha256(projection)
  };
  return report;
}

async function runAllBenchmarks() {
  const results = [];
  for (const identityCount of LEVELS) {
    const baseline = await runBenchmarkLevel(identityCount, { variant: 0 });
    let deterministic = null;
    if (identityCount <= 1000) {
      const inverse = await runBenchmarkLevel(identityCount, { variant: 1 });
      deterministic = baseline.semanticDigest === inverse.semanticDigest;
    }
    results.push({ ...baseline, checks: { ...baseline.checks, deterministic } });
  }
  return { benchmarkVersion: 1, levels: results };
}

if (require.main === module) {
  runAllBenchmarks().then((report) => {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error && error.code || error.message || "BC6_BENCHMARK_FAILED"}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_BENCHMARK_BUDGETS,
  LEVELS,
  SYMBOLIC_BATCH_SIZES,
  createSyntheticDataset,
  verifySymbolicBatchInvariance,
  runBenchmarkLevel,
  runAllBenchmarks
};
