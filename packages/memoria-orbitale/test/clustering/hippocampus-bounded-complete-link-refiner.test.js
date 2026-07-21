"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  BOUNDED_CLUSTERING_REASON_CODES: REASONS,
  DEFAULT_BOUNDED_CLUSTERING_POLICY,
  DISCOVERY_COMPLETENESS,
  TIMESTAMP_QUALITY,
  createGlobalIdentitySnapshot,
  validateBoundedClusteringPlan
} = require("../../core/clustering/HippocampusBoundedClusteringPlan");
const {
  createHippocampusCandidateGraphBuilder
} = require("../../core/clustering/HippocampusCandidateGraphBuilder");
const {
  THRESHOLD_DISCOVERY_CERTIFICATE_VERSION,
  THRESHOLD_DISCOVERY_MODE
} = require("../../core/clustering/HippocampusDiscoveryCompleteness");
const {
  VECTOR_DIMENSION,
  createHippocampusBoundedCompleteLinkRefiner
} = require("../../core/clustering/HippocampusBoundedCompleteLinkRefiner");

const COMPLETE = DISCOVERY_COMPLETENESS.COMPLETE_ABOVE_THRESHOLD;
const MODEL = "bc4-synthetic-model";
const REVISION = "bc4-synthetic-revision";

function hash(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function pointId(index) {
  const value = (index + 1).toString(16).padStart(32, "0");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-5${value.slice(13, 16)}-` +
    `8${value.slice(17, 20)}-${value.slice(20, 32)}`;
}

function identity(index) {
  return {
    memoryId: `bc4-memory-${String(index).padStart(2, "0")}`,
    contentHash: hash(`bc4-content-${index}`),
    pointId: pointId(index),
    model: MODEL,
    revision: REVISION
  };
}

function snapshot(count, reverse = false) {
  const identities = Array.from({ length: count }, (_, index) => identity(index));
  return createGlobalIdentitySnapshot({
    userIdHash: hash("bc4-private-synthetic-user"),
    identities: reverse ? identities.reverse() : identities
  });
}

function certificate(current, query, count) {
  return {
    certificateVersion: THRESHOLD_DISCOVERY_CERTIFICATE_VERSION,
    mode: THRESHOLD_DISCOVERY_MODE,
    identityIndexFingerprint: current.snapshotFingerprint,
    queryPointId: query.pointId,
    clusterThreshold: DEFAULT_BOUNDED_CLUSTERING_POLICY.clusterThreshold,
    embeddingModel: query.model,
    embeddingRevision: query.revision,
    eligibleIdentityCount: Math.max(0, current.identityCount - 1),
    enumeratedAboveThresholdCount: count,
    exhausted: true,
    truncated: false,
    continuation: null
  };
}

async function graph(current, links = [], uncertified = new Set()) {
  const neighbors = new Map(current.identities.map((item) => [item.pointId, []]));
  for (const [leftIndex, rightIndex] of links) {
    const left = current.identities[leftIndex];
    const right = current.identities[rightIndex];
    neighbors.get(left.pointId).push({ ...right, score: 0.8 });
    neighbors.get(right.pointId).push({ ...left, score: 0.8 });
  }
  const discoveryProvider = {
    async discoverNeighbors({ queryIdentity }) {
      const hits = neighbors.get(queryIdentity.pointId);
      if (uncertified.has(queryIdentity.pointId)) {
        return { discoveryCompleteness: COMPLETE, hits };
      }
      const query = current.identities.find((item) => item.pointId === queryIdentity.pointId);
      return {
        discoveryCompleteness: COMPLETE,
        hits,
        certificate: certificate(current, query, hits.length)
      };
    }
  };
  return createHippocampusCandidateGraphBuilder({
    discoveryProvider,
    maxNeighborQueries: 100,
    maxCandidateEdges: 100,
    timeoutMs: 1000
  }).build({ identitySnapshot: current, signal: new AbortController().signal });
}

function unit(x = 1, y = 0) {
  const vector = new Array(VECTOR_DIMENSION).fill(0);
  vector[0] = x;
  vector[1] = y;
  return vector;
}

function budgets(overrides = {}) {
  return {
    neighborLimit: 64,
    overfetchFactor: 4,
    scoreThreshold: 0.65,
    maxComponentVectorsInMemory: 100,
    maxPairwiseComparisons: 10000,
    maxCandidateEdges: 100,
    maxClusterSize: 100,
    timeoutMs: 1000,
    maxRssDeltaBytes: 1000000,
    ...overrides
  };
}

function response(current, item, vector, overrides = {}) {
  return {
    vector,
    provenance: {
      cacheSchemaVersion: 1,
      identitySnapshotFingerprint: current.snapshotFingerprint,
      pointId: item.pointId,
      memoryId: item.memoryId,
      contentHash: item.contentHash,
      model: item.model,
      revision: item.revision,
      dimension: VECTOR_DIMENSION,
      normalized: true,
      ...overrides
    }
  };
}

function resolver(current, vectors, calls = [], implementation) {
  return {
    cacheSchemaVersion: 1,
    async resolveEmbedding(request) {
      calls.push(request.identity.pointId);
      if (implementation) return implementation(request, calls.length - 1);
      return response(current, request.identity, vectors.get(request.identity.pointId));
    }
  };
}

function fixedRss(value = 1000) {
  return { readRssBytes: () => value };
}

function fixedClock(value = 0) {
  return { now: () => value };
}

function refiner(embeddingResolver, overrides = {}) {
  return createHippocampusBoundedCompleteLinkRefiner({
    embeddingResolver,
    rssReader: fixedRss(),
    clock: fixedClock(),
    ...overrides
  });
}

async function run(current, candidateGraph, vectors, overrides = {}) {
  const calls = overrides.calls || [];
  const embeddingResolver = overrides.embeddingResolver || resolver(current, vectors, calls);
  const plan = await refiner(embeddingResolver, overrides.options).refine({
    identitySnapshot: current,
    candidateGraph,
    policy: DEFAULT_BOUNDED_CLUSTERING_POLICY,
    budgets: budgets(overrides.budgets),
    signal: overrides.signal || new AbortController().signal
  });
  return { plan, calls };
}

function mapVectors(current, values) {
  return new Map(current.identities.map((item, index) => [item.pointId, values[index]]));
}

test("a certified clique of three produces one verified cluster", async () => {
  const current = snapshot(3);
  const candidateGraph = await graph(current, [[0, 1], [1, 2]]);
  const { plan } = await run(current, candidateGraph,
    mapVectors(current, [unit(), unit(), unit()]));
  assert.equal(plan.clusters.length, 1);
  assert.deepEqual(plan.clusters[0].memberIds,
    current.identities.map((item) => item.memoryId).sort());
  assert.equal(plan.clusters[0].minimumPairSimilarity, 1);
  assert.equal(plan.clusters[0].timestampQuality, TIMESTAMP_QUALITY.NOT_EVALUATED);
  assert.deepEqual(validateBoundedClusteringPlan(plan, current), { valid: true, errors: [] });
});

test("an affine pair remains unclustered when minClusterSize is three", async () => {
  const current = snapshot(2);
  const { plan } = await run(current, await graph(current, [[0, 1]]),
    mapVectors(current, [unit(), unit()]));
  assert.equal(plan.clusters.length, 0);
  assert.equal(plan.unclusteredComponents.length, 1);
  assert.equal(plan.unclusteredComponents[0].reasonCode,
    REASONS.UNCLUSTERED_BELOW_MIN_SIZE);
});

test("the certified A-B-C chain cannot become a three-member cluster", async () => {
  const current = snapshot(3);
  const chain = [unit(), unit(0.8, 0.6), unit(0.28, 0.96)];
  const { plan } = await run(current, await graph(current, [[0, 1], [1, 2]]),
    mapVectors(current, chain));
  assert.equal(plan.clusters.length, 0);
  assert.deepEqual(plan.unclusteredComponents.map((item) => item.memberCount), [2, 1]);
});

test("the inclusive threshold accepts cosine exactly 0.70", async () => {
  const current = snapshot(3);
  const boundary = unit(0.7, Math.sqrt(0.51));
  const { plan } = await run(current, await graph(current, [[0, 1], [1, 2]]),
    mapVectors(current, [unit(), boundary, boundary]));
  assert.equal(plan.clusters.length, 1);
  assert.equal(plan.clusters[0].minimumPairSimilarity, 0.7);
});

test("greedy V1 excludes a below-threshold member without reassignment", async () => {
  const current = snapshot(4);
  const values = [unit(), unit(), unit(), unit(0, 1)];
  const { plan } = await run(current, await graph(current, [[0, 1], [1, 2], [2, 3]]),
    mapVectors(current, values));
  assert.equal(plan.clusters.length, 1);
  assert.equal(plan.clusters[0].memberIds.length, 3);
  assert.equal(plan.unclusteredComponents[0].memberCount, 1);
});

test("one certified candidate component can yield two disjoint valid clusters", async () => {
  const current = snapshot(6);
  const values = [unit(), unit(), unit(), unit(0, 1), unit(0, 1), unit(0, 1)];
  const candidateGraph = await graph(current,
    [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5]]);
  const { plan } = await run(current, candidateGraph, mapVectors(current, values));
  assert.deepEqual(plan.clusters.map((item) => item.memberIds.length), [3, 3]);
  assert.equal(new Set(plan.clusters.flatMap((item) => item.memberIds)).size, 6);
});

test("an uncertified component is never retrieved", async () => {
  const current = snapshot(4);
  const uncertified = new Set([current.identities[3].pointId]);
  const candidateGraph = await graph(current, [[0, 1], [1, 2], [2, 3]], uncertified);
  const { plan, calls } = await run(current, candidateGraph,
    mapVectors(current, current.identities.map(() => unit())));
  assert.equal(calls.length, 0);
  assert.equal(plan.deferredComponents[0].reasonCode,
    REASONS.DEFERRED_INCOMPLETE_NEIGHBOR_DISCOVERY);
});

test("vector memory budget defers a dense component with zero retrieve", async () => {
  const current = snapshot(4);
  const { plan, calls } = await run(current,
    await graph(current, [[0, 1], [1, 2], [2, 3]]),
    mapVectors(current, current.identities.map(() => unit())),
    { budgets: { maxComponentVectorsInMemory: 3 } });
  assert.equal(calls.length, 0);
  assert.equal(plan.deferredComponents[0].reasonCode, REASONS.DEFERRED_DENSE_COMPONENT);
  assert.equal(plan.metrics.maximumVectorsInMemory, 0);
});

test("pairwise budget defers the entire component without partial clusters", async () => {
  const current = snapshot(3);
  const { plan } = await run(current, await graph(current, [[0, 1], [1, 2]]),
    mapVectors(current, [unit(), unit(), unit()]),
    { budgets: { maxPairwiseComparisons: 4 } });
  assert.equal(plan.clusters.length, 0);
  assert.equal(plan.unclusteredComponents.length, 0);
  assert.equal(plan.deferredComponents[0].memberCount, 3);
  assert.equal(plan.deferredComponents[0].reasonCode, REASONS.DEFERRED_PAIRWISE_BUDGET);
  assert.equal(plan.metrics.pairwiseComparisonCount, 4);
});

test("maxClusterSize defers an oversized greedy group integrally", async () => {
  const current = snapshot(4);
  const { plan } = await run(current,
    await graph(current, [[0, 1], [1, 2], [2, 3]]),
    mapVectors(current, current.identities.map(() => unit())),
    { budgets: { maxClusterSize: 3 } });
  assert.equal(plan.clusters.length, 0);
  assert.equal(plan.deferredComponents[0].memberCount, 4);
  assert.equal(plan.deferredComponents[0].reasonCode, REASONS.DEFERRED_OVERSIZED_CLUSTER);
});

test("stale identity, provenance and snapshot mismatches fail closed", async () => {
  const current = snapshot(1);
  const candidateGraph = await graph(current);
  for (const mismatch of [
    { pointId: pointId(99) }, { contentHash: hash("stale") },
    { model: "other" }, { revision: "other" },
    { identitySnapshotFingerprint: hash("other-snapshot") }
  ]) {
    const embeddingResolver = resolver(current, new Map(), [], (request) =>
      response(current, request.identity, unit(), mismatch));
    await assert.rejects(run(current, candidateGraph, new Map(), { embeddingResolver }),
      { code: "EMBEDDING_PROVENANCE_MISMATCH" });
  }
});

test("dimension, NaN, zero and non-normalized vectors are rejected", async () => {
  const current = snapshot(1);
  const candidateGraph = await graph(current);
  const cases = [
    [new Array(VECTOR_DIMENSION - 1).fill(0), "INVALID_EMBEDDING_DIMENSION"],
    [unit(Number.NaN, 0), "NON_FINITE_EMBEDDING_VECTOR"],
    [new Array(VECTOR_DIMENSION).fill(0), "NON_NORMALIZED_EMBEDDING_VECTOR"],
    [unit(0.5, 0), "NON_NORMALIZED_EMBEDDING_VECTOR"]
  ];
  for (const [vector, code] of cases) {
    const embeddingResolver = resolver(current, new Map(), [], (request) =>
      response(current, request.identity, vector));
    await assert.rejects(run(current, candidateGraph, new Map(), { embeddingResolver }),
      { code });
  }
});

test("retrieve is sequential, canonically ordered and never Promise.all", async () => {
  const current = snapshot(3, true);
  const candidateGraph = await graph(current, [[0, 1], [1, 2]]);
  let active = 0;
  let maximumActive = 0;
  const calls = [];
  const embeddingResolver = resolver(current, new Map(), calls, async (request) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setImmediate(resolve));
    active -= 1;
    return response(current, request.identity, unit());
  });
  const { plan } = await run(current, candidateGraph, new Map(), { embeddingResolver });
  assert.equal(maximumActive, 1);
  assert.deepEqual(calls, current.identities.map((item) => item.pointId));
  assert.equal(plan.metrics.maximumVectorsInMemory, 3);
  const source = fs.readFileSync(path.join(__dirname,
    "../../core/clustering/HippocampusBoundedCompleteLinkRefiner.js"), "utf8");
  assert.doesNotMatch(source, /Promise\.all/u);
  assert.match(source, /componentVectors\.clear\(\);\s*componentVectors = null;/u);
});

test("only one component vector set is retained at a time", async () => {
  const current = snapshot(6);
  const candidateGraph = await graph(current, [[0, 1], [1, 2], [3, 4], [4, 5]]);
  const { plan, calls } = await run(current, candidateGraph,
    mapVectors(current, current.identities.map(() => unit())));
  assert.equal(plan.clusters.length, 2);
  assert.equal(plan.metrics.maximumVectorsInMemory, 3);
  assert.deepEqual(calls, current.identities.map((item) => item.pointId));
});

test("timeout defers the whole current component", async () => {
  const current = snapshot(3);
  const candidateGraph = await graph(current, [[0, 1], [1, 2]]);
  const embeddingResolver = resolver(current, new Map(), [], () => new Promise(() => {}));
  const { plan } = await run(current, candidateGraph, new Map(), {
    embeddingResolver,
    budgets: { timeoutMs: 10 }
  });
  assert.equal(plan.clusters.length, 0);
  assert.equal(plan.deferredComponents[0].reasonCode, REASONS.DEFERRED_TIMEOUT);
});

test("abort fails closed and returns no partial plan", async () => {
  const current = snapshot(3);
  const candidateGraph = await graph(current, [[0, 1], [1, 2]]);
  const controller = new AbortController();
  const embeddingResolver = resolver(current, new Map(), [], (request) => {
    controller.abort(new Error("private abort detail"));
    return response(current, request.identity, unit());
  });
  await assert.rejects(run(current, candidateGraph, new Map(), {
    embeddingResolver, signal: controller.signal
  }), (error) => {
    assert.equal(error.code, "REFINEMENT_ABORTED");
    assert.doesNotMatch(error.message, /private|detail/iu);
    return true;
  });
});

test("injected deterministic RSS reader defers without machine RSS", async () => {
  const current = snapshot(3);
  const readings = [1000, 1000, 1200];
  const rssReader = { readRssBytes: () => readings.shift() ?? 1200 };
  const calls = [];
  const embeddingResolver = resolver(current,
    mapVectors(current, current.identities.map(() => unit())), calls);
  const plan = await refiner(embeddingResolver, { rssReader }).refine({
    identitySnapshot: current,
    candidateGraph: await graph(current, [[0, 1], [1, 2]]),
    policy: DEFAULT_BOUNDED_CLUSTERING_POLICY,
    budgets: budgets({ maxRssDeltaBytes: 100 }),
    signal: new AbortController().signal
  });
  assert.equal(calls.length, 1);
  assert.equal(plan.deferredComponents[0].reasonCode, REASONS.DEFERRED_RSS_BUDGET);
  assert.equal(plan.metrics.rssDeltaBytes, 200);
});

test("minimumPairSimilarity is the real verified pair minimum", async () => {
  const current = snapshot(3);
  const values = [unit(), unit(0.8, 0.6), unit(0.75, Math.sqrt(0.4375))];
  const { plan } = await run(current, await graph(current, [[0, 1], [1, 2]]),
    mapVectors(current, values));
  assert.equal(plan.clusters[0].minimumPairSimilarity, 0.75);
  assert.equal(plan.metrics.pairwiseComparisonCount, 6);
});

test("direct/inverse input and different async delays preserve identity and membership", async () => {
  const direct = snapshot(3);
  const inverse = snapshot(3, true);
  const firstGraph = await graph(direct, [[0, 1], [1, 2]]);
  const secondGraph = await graph(inverse, [[2, 1], [1, 0]]);
  const vectors = mapVectors(direct, [unit(), unit(), unit()]);
  const delayed = (current, delayByPoint) => resolver(current, vectors, [], async (request) => {
    await new Promise((resolve) => setTimeout(resolve, delayByPoint.get(request.identity.pointId)));
    return response(current, request.identity, vectors.get(request.identity.pointId));
  });
  const first = await run(direct, firstGraph, vectors, {
    embeddingResolver: delayed(direct, new Map(direct.identities.map((item, i) =>
      [item.pointId, 2 - i])))
  });
  const second = await run(inverse, secondGraph, vectors, {
    embeddingResolver: delayed(inverse, new Map(inverse.identities.map((item, i) =>
      [item.pointId, i])))
  });
  assert.equal(first.plan.planId, second.plan.planId);
  assert.deepEqual(first.plan.clusters, second.plan.clusters);
});

test("cross-batch labels 1 and 50 cannot affect output", async () => {
  const current = snapshot(3);
  const labels = new Map([[current.identities[0].pointId, 1],
    [current.identities[1].pointId, 50], [current.identities[2].pointId, 1]]);
  const calls = [];
  const { plan } = await run(current, await graph(current, [[0, 1], [1, 2]]),
    mapVectors(current, [unit(), unit(), unit()]), { calls });
  assert.deepEqual(calls.map((point) => labels.get(point)), [1, 50, 1]);
  assert.doesNotMatch(JSON.stringify(plan), /batch|"50"/iu);
});

test("output is deeply immutable, vectorless and free of sensitive fields", async () => {
  const current = snapshot(3);
  const { plan } = await run(current, await graph(current, [[0, 1], [1, 2]]),
    mapVectors(current, [unit(), unit(), unit()]));
  function inspect(value) {
    if (!value || typeof value !== "object") return;
    assert.equal(Object.isFrozen(value), true);
    for (const [key, child] of Object.entries(value)) {
      assert.equal(new Set(["text", "content", "vector", "centroid", "payload",
        "userId", "endpoint", "apiKey", "batch"]).has(key), false);
      inspect(child);
    }
  }
  inspect(plan);
  assert.doesNotMatch(JSON.stringify(plan), /private-synthetic-user|bc4-content/iu);
});

test("module imports only the pure BC-1 and BC-3 contracts", () => {
  const source = fs.readFileSync(path.join(__dirname,
    "../../core/clustering/HippocampusBoundedCompleteLinkRefiner.js"), "utf8");
  const imports = [...source.matchAll(/require\(([^)]+)\)/gu)].map((match) => match[1]);
  assert.deepEqual(imports, [
    '"./HippocampusBoundedClusteringPlan"',
    '"./HippocampusDiscoveryCompleteness"'
  ]);
  assert.doesNotMatch(source,
    /ClusterEngineAdapter|HippocampusDaemon|RecallRouter|Qdrant|BgeM3|Qwen|storage|synthesis|SuperMemory|process\.env|\bfetch\s*\(/u);
});
