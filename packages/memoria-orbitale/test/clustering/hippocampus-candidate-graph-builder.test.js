"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  BOUNDED_CLUSTERING_ALGORITHM_VERSION,
  BOUNDED_CLUSTERING_REASON_CODES,
  BOUNDED_CLUSTERING_STATUSES,
  DEFAULT_BOUNDED_CLUSTERING_POLICY,
  DISCOVERY_COMPLETENESS,
  createGlobalIdentitySnapshot
} = require("../../core/clustering/HippocampusBoundedClusteringPlan");
const {
  CANDIDATE_GRAPH_SCHEMA_VERSION,
  CANDIDATE_GRAPH_VERSION,
  createHippocampusCandidateGraphBuilder
} = require("../../core/clustering/HippocampusCandidateGraphBuilder");

const COMPLETE = DISCOVERY_COMPLETENESS.COMPLETE_ABOVE_THRESHOLD;

function hash(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function pointId(value) {
  const hex = hash(`point:${value}`);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}` +
    `-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function identity(index) {
  return {
    memoryId: `synthetic-memory-${index}`,
    contentHash: hash(`synthetic-content-${index}`),
    pointId: pointId(index),
    model: "synthetic-model",
    revision: "synthetic-revision"
  };
}

function snapshot(count = 6, order = "direct") {
  const identities = Array.from({ length: count }, (_, index) => identity(index));
  if (order === "inverse") identities.reverse();
  return createGlobalIdentitySnapshot({ userIdHash: hash("synthetic-user"), identities });
}

function hit(target, score, overrides = {}) {
  return { ...target, score, ...overrides };
}

function response(hits = [], discoveryCompleteness = COMPLETE) {
  return { discoveryCompleteness, hits };
}

function provider(responses, calls = []) {
  return {
    async discoverNeighbors(request) {
      calls.push(request);
      const value = responses.get(request.queryIdentity.pointId);
      return typeof value === "function" ? value(request) : value || response();
    }
  };
}

function builder(discoveryProvider, overrides = {}) {
  return createHippocampusCandidateGraphBuilder({
    discoveryProvider,
    maxNeighborQueries: 100,
    maxCandidateEdges: 100,
    timeoutMs: 1000,
    ...overrides
  });
}

function signal() {
  return new AbortController().signal;
}

async function buildGraph(identitySnapshot, responses, overrides = {}) {
  return builder(provider(responses), overrides).build({ identitySnapshot, signal: signal() });
}

function componentMembers(graph) {
  return graph.components.map((component) => component.memberIds);
}

function deepFreeze(value) {
  Object.freeze(value);
  for (const child of Object.values(value)) {
    if (child && typeof child === "object" && !Object.isFrozen(child)) deepFreeze(child);
  }
  return value;
}

test("exports BC-1 semantics instead of duplicating or changing them", () => {
  const graphModule = require("../../core/clustering/HippocampusCandidateGraphBuilder");
  assert.equal(CANDIDATE_GRAPH_SCHEMA_VERSION, 1);
  assert.equal(CANDIDATE_GRAPH_VERSION, "hippocampus-candidate-graph-v1");
  assert.equal(BOUNDED_CLUSTERING_ALGORITHM_VERSION,
    "hippocampus-bounded-complete-link-v1");
  assert.equal(DEFAULT_BOUNDED_CLUSTERING_POLICY.clusterThreshold, 0.70);
  assert.equal(DEFAULT_BOUNDED_CLUSTERING_POLICY.minClusterSize, 3);
  assert.equal(Object.hasOwn(graphModule, "DEFAULT_BOUNDED_CLUSTERING_POLICY"), false);
});

test("queries every identity sequentially in canonical snapshot order with AbortSignal", async () => {
  const current = snapshot(6, "inverse");
  const calls = [];
  let active = 0;
  let maximumActive = 0;
  const discoveryProvider = {
    async discoverNeighbors(request) {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await Promise.resolve();
      active -= 1;
      calls.push(request);
      return response();
    }
  };
  const graph = await builder(discoveryProvider).build({ identitySnapshot: current, signal: signal() });
  assert.deepEqual(calls.map((call) => call.queryIdentity.pointId),
    current.identities.map((item) => item.pointId));
  assert.equal(maximumActive, 1);
  assert.equal(calls.every((call) => call.signal instanceof AbortSignal), true);
  assert.equal(graph.metrics.neighborQueryCount, 6);
});

test("candidate build prepares one isolated discovery context for all queries", async () => {
  const current = snapshot(40);
  const graphBuilder = builder(provider(new Map()), {
    maxNeighborQueries: 40,
    timeoutMs: 5000
  });
  await graphBuilder.build({ identitySnapshot: current, signal: signal() });
  assert.deepEqual(graphBuilder.getLastPreparationDiagnostics(), {
    preparationCount: 1,
    snapshotValidationCount: 1,
    globalOrderingCount: 1,
    globalFingerprintCalculationCount: 1,
    certificateEvaluationCount: 40,
    certificateQueryLookupCount: 40,
    pointLookupCount: 0,
    memoryLookupCount: 0
  });

  const second = snapshot(3);
  await graphBuilder.build({ identitySnapshot: second, signal: signal() });
  assert.equal(graphBuilder.getLastPreparationDiagnostics().certificateEvaluationCount, 3);
  assert.equal(graphBuilder.getLastPreparationDiagnostics().snapshotValidationCount, 1);
});

test("zero-edge preparation and lookup work grows linearly through 1000 identities", async () => {
  for (const identityCount of [100, 250, 500, 1000]) {
    const current = snapshot(identityCount);
    const graphBuilder = builder(provider(new Map()), {
      maxNeighborQueries: identityCount,
      maxCandidateEdges: identityCount,
      timeoutMs: 30000
    });
    const graph = await graphBuilder.build({ identitySnapshot: current, signal: signal() });
    const diagnostics = graphBuilder.getLastPreparationDiagnostics();
    assert.equal(graph.metrics.neighborQueryCount, identityCount);
    assert.equal(diagnostics.snapshotValidationCount, 1);
    assert.equal(diagnostics.globalOrderingCount, 1);
    assert.equal(diagnostics.globalFingerprintCalculationCount, 1);
    assert.equal(diagnostics.certificateQueryLookupCount, identityCount);
    assert.equal(diagnostics.pointLookupCount, 0);
  }
});

test("stale snapshot fails before the first provider call", async () => {
  const stale = JSON.parse(JSON.stringify(snapshot(4)));
  stale.identities[0].contentHash = hash("stale-snapshot-content");
  deepFreeze(stale);
  let calls = 0;
  const graphBuilder = builder({
    async discoverNeighbors() {
      calls += 1;
      return response();
    }
  });
  await assert.rejects(graphBuilder.build({ identitySnapshot: stale, signal: signal() }), {
    code: "SNAPSHOT_FINGERPRINT_MISMATCH"
  });
  assert.equal(calls, 0);
  assert.equal(graphBuilder.getLastPreparationDiagnostics(), null);
});

test("canonicalizes direction, deduplicates A→B/B→A and keeps maximum score", async () => {
  const current = snapshot(3);
  const [a, b] = current.identities;
  const responses = new Map([
    [a.pointId, response([hit(b, 0.72), hit(b, 0.81), hit(b, 0.75)].reverse())],
    [b.pointId, response([hit(a, 0.79), hit(a, 0.84)])]
  ]);
  const graph = await buildGraph(current, responses);
  assert.equal(graph.edges.length, 1);
  assert.deepEqual([graph.edges[0].pointIdA, graph.edges[0].pointIdB],
    [a.pointId, b.pointId].sort());
  assert.equal(graph.edges[0].maximumObservedScore, 0.84);
  assert.equal(graph.metrics.acceptedObservationCount, 5);
  assert.equal(graph.metrics.duplicateObservationCount, 4);
});

test("excludes a valid self-hit and counts it", async () => {
  const current = snapshot(1);
  const only = current.identities[0];
  const graph = await buildGraph(current, new Map([
    [only.pointId, response([hit(only, 1)])]
  ]));
  assert.equal(graph.edges.length, 0);
  assert.equal(graph.metrics.selfHitCount, 1);
});

test("rejects and counts stale, foreign and incompatible-provenance hits", async () => {
  const current = snapshot(3);
  const [query, staleTarget, provenanceTarget] = current.identities;
  const stalePoint = { ...staleTarget, pointId: pointId("old") };
  const foreign = identity("foreign");
  const responses = new Map([[query.pointId, response([
    hit(stalePoint, 0.9),
    hit(foreign, 0.9),
    hit(provenanceTarget, 0.9, { revision: "stale-revision" })
  ])]]);
  const graph = await buildGraph(current, responses);
  assert.equal(graph.edges.length, 0);
  assert.equal(graph.metrics.staleIdentityHitCount, 1);
  assert.equal(graph.metrics.foreignPointHitCount, 1);
  assert.equal(graph.metrics.incompatibleProvenanceHitCount, 1);
});

test("uses inclusive threshold: below 0.70 is excluded and exactly 0.70 is included", async () => {
  const current = snapshot(3);
  const [a, b, c] = current.identities;
  const graph = await buildGraph(current, new Map([[a.pointId, response([
    hit(b, 0.699999), hit(c, 0.70)
  ])]]));
  assert.equal(graph.edges.length, 1);
  assert.equal(graph.edges[0].maximumObservedScore, 0.70);
  assert.equal(graph.metrics.belowThresholdHitCount, 1);
});

test("union-find returns separate deterministic components including isolated identities", async () => {
  const current = snapshot(6);
  const [a, b, c, d, e, f] = current.identities;
  const graph = await buildGraph(current, new Map([
    [a.pointId, response([hit(b, 0.8)])],
    [b.pointId, response([hit(c, 0.8)])],
    [d.pointId, response([hit(e, 0.9)])]
  ]));
  assert.deepEqual(componentMembers(graph), [
    [a.pointId, b.pointId, c.pointId].sort(),
    [d.pointId, e.pointId].sort(),
    [f.pointId]
  ].sort((left, right) => left[0].localeCompare(right[0])));
  assert.equal(graph.metrics.maximumComponentSize, 3);
});

test("explicit budgets allow more than five candidate edges without an implicit cap", async () => {
  const current = snapshot(13);
  const [seed, ...targets] = current.identities;
  const graph = await buildGraph(current, new Map([[
    seed.pointId, response(targets.map((target, index) => hit(target, 0.71 + index / 1000)))
  ]]));
  assert.equal(graph.edges.length, 12);
  assert.equal(graph.components.length, 1);
  assert.equal(graph.components[0].memberCount, 13);
});

test("A–B–C is only a candidate component and never a finalized cluster", async () => {
  const current = snapshot(3);
  const [a, b, c] = current.identities;
  const graph = await buildGraph(current, new Map([
    [a.pointId, response([hit(b, 0.8)])],
    [b.pointId, response([hit(c, 0.8)])]
  ]));
  assert.deepEqual(graph.components[0].memberIds, [a.pointId, b.pointId, c.pointId].sort());
  assert.equal(graph.finalizationAuthorized, false);
  assert.equal(Object.hasOwn(graph, "clusters"), false);
  assert.equal(Object.hasOwn(graph.components[0], "minimumPairSimilarity"), false);
});

test("batch labels 1, 17 and 50 cannot affect a cross-batch graph", async () => {
  const batches = new Map([[0, 1], [1, 17], [2, 50]]);
  const current = createGlobalIdentitySnapshot({
    userIdHash: hash("synthetic-user"),
    identities: [...batches.keys()].map(identity).reverse()
  });
  const [a, b, c] = current.identities;
  const responses = new Map([
    [a.pointId, response([hit(c, 0.78)])],
    [c.pointId, response([hit(a, 0.78)])]
  ]);
  const graph = await buildGraph(current, responses);
  assert.equal(graph.edges.length, 1);
  assert.deepEqual(graph.components.find((item) => item.memberCount === 2).memberIds,
    [a.pointId, c.pointId].sort());
  assert.doesNotMatch(JSON.stringify(graph), /batch|\b17\b|\b50\b/iu);
});

test("input inversion, edge direction and randomized response order yield one canonical graph", async () => {
  const direct = snapshot(4, "direct");
  const inverse = snapshot(4, "inverse");
  assert.equal(direct.snapshotFingerprint, inverse.snapshotFingerprint);
  const [a, b, c] = direct.identities;
  const forward = new Map([
    [a.pointId, response([hit(c, 0.74), hit(b, 0.82)].reverse())],
    [b.pointId, response([hit(c, 0.76)])]
  ]);
  const reverse = new Map([
    [b.pointId, response([hit(a, 0.82)])],
    [c.pointId, response([hit(b, 0.76), hit(a, 0.74)].reverse())]
  ]);
  const first = await buildGraph(direct, forward);
  const second = await buildGraph(inverse, reverse);
  assert.deepEqual(first, second);
});

test("maxCandidateEdges defers with a visibly truncated graph", async () => {
  const current = snapshot(4);
  const [a, b, c] = current.identities;
  const graph = await buildGraph(current, new Map([[a.pointId, response([
    hit(c, 0.9), hit(b, 0.8)
  ])]]), { maxCandidateEdges: 1 });
  assert.equal(graph.edges.length, 1);
  assert.equal(graph.status, BOUNDED_CLUSTERING_STATUSES.DEFERRED);
  assert.equal(graph.reasonCode, BOUNDED_CLUSTERING_REASON_CODES.DEFERRED_EDGE_BUDGET);
  assert.equal(graph.discoveryCompleteness,
    DISCOVERY_COMPLETENESS.INCOMPLETE_TRUNCATED);
  assert.equal(graph.components.every((component) =>
    component.discoveryCompleteness !== COMPLETE), true);
});

test("maxNeighborQueries is mandatory and defers before exceeding its bound", async () => {
  const current = snapshot(4);
  const calls = [];
  const graph = await builder(provider(new Map(), calls), {
    maxNeighborQueries: 2
  }).build({ identitySnapshot: current, signal: signal() });
  assert.equal(calls.length, 2);
  assert.equal(graph.metrics.neighborQueryCount, 2);
  assert.equal(graph.metrics.unqueriedIdentityCount, 2);
  assert.equal(graph.reasonCode,
    BOUNDED_CLUSTERING_REASON_CODES.DEFERRED_INCOMPLETE_NEIGHBOR_DISCOVERY);
  assert.equal(graph.discoveryCompleteness,
    DISCOVERY_COMPLETENESS.INCOMPLETE_UNCERTIFIED);
});

test("timeout aborts a cooperative provider and returns DEFERRED_TIMEOUT without retry", async () => {
  const current = snapshot(2);
  let calls = 0;
  let observedAbort = false;
  const discoveryProvider = {
    discoverNeighbors({ signal: providerSignal }) {
      calls += 1;
      return new Promise((resolve, reject) => providerSignal.addEventListener("abort", () => {
        observedAbort = true;
        reject(new Error("private provider detail"));
      }, { once: true }));
    }
  };
  const graph = await builder(discoveryProvider, { timeoutMs: 10 }).build({
    identitySnapshot: current, signal: signal()
  });
  assert.equal(calls, 1);
  assert.equal(observedAbort, true);
  assert.equal(graph.reasonCode, BOUNDED_CLUSTERING_REASON_CODES.DEFERRED_TIMEOUT);
  assert.equal(graph.status, BOUNDED_CLUSTERING_STATUSES.DEFERRED);
});

test("timeout also bounds a non-cooperative provider", async () => {
  const current = snapshot(1);
  const graph = await builder({ discoverNeighbors: () => new Promise(() => {}) }, {
    timeoutMs: 10
  }).build({ identitySnapshot: current, signal: signal() });
  assert.equal(graph.reasonCode, BOUNDED_CLUSTERING_REASON_CODES.DEFERRED_TIMEOUT);
  assert.equal(graph.metrics.neighborQueryCount, 0);
});

test("caller abort is mandatory, propagated and fails closed with a sanitized error", async () => {
  const current = snapshot(1);
  const controller = new AbortController();
  controller.abort(new Error("private abort reason"));
  await assert.rejects(builder(provider(new Map())).build({
    identitySnapshot: current, signal: controller.signal
  }), (error) => {
    assert.equal(error.code, "CANDIDATE_GRAPH_ABORTED");
    assert.doesNotMatch(error.message, /private|reason/iu);
    return true;
  });
});

test("truncated, uncertified and failed discovery states remain recognizable", async () => {
  for (const completeness of [
    DISCOVERY_COMPLETENESS.INCOMPLETE_TRUNCATED,
    DISCOVERY_COMPLETENESS.INCOMPLETE_UNCERTIFIED,
    DISCOVERY_COMPLETENESS.FAILED
  ]) {
    const current = snapshot(1);
    const graph = await buildGraph(current, new Map([[
      current.identities[0].pointId, response([], completeness)
    ]]));
    assert.equal(graph.discoveryCompleteness, completeness);
    assert.equal(graph.components[0].discoveryCompleteness, completeness);
    assert.equal(graph.status, BOUNDED_CLUSTERING_STATUSES.DEFERRED);
    assert.equal(graph.reasonCode,
      BOUNDED_CLUSTERING_REASON_CODES.DEFERRED_INCOMPLETE_NEIGHBOR_DISCOVERY);
  }
});

test("invalid response shape and non-finite scores fail closed", async () => {
  const current = snapshot(1);
  const queryId = current.identities[0].pointId;
  await assert.rejects(buildGraph(current, new Map([[queryId, {
    discoveryCompleteness: COMPLETE, hits: [], payload: "forbidden"
  }]])), { code: "INVALID_DISCOVERY_RESPONSE" });
  await assert.rejects(buildGraph(current, new Map([[queryId, response([
    hit(current.identities[0], Number.NaN)
  ])]])), { code: "INVALID_DISCOVERY_HIT" });
});

test("provider exceptions are sanitized and never retried", async () => {
  const current = snapshot(1);
  let calls = 0;
  await assert.rejects(builder({
    async discoverNeighbors() {
      calls += 1;
      throw new Error("secret endpoint and payload");
    }
  }).build({ identitySnapshot: current, signal: signal() }), (error) => {
    assert.equal(error.code, "DISCOVERY_PROVIDER_FAILED");
    assert.doesNotMatch(error.message, /secret|endpoint|payload/iu);
    return true;
  });
  assert.equal(calls, 1);
});

test("options, signal and immutable BC-1 snapshot contracts are mandatory and closed", async () => {
  assert.throws(() => createHippocampusCandidateGraphBuilder({
    discoveryProvider: provider(new Map()), maxNeighborQueries: 1,
    maxCandidateEdges: 1, timeoutMs: 1, retry: true
  }), { code: "INVALID_CANDIDATE_GRAPH_OPTIONS" });
  const mutable = JSON.parse(JSON.stringify(snapshot(1)));
  await assert.rejects(builder(provider(new Map())).build({
    identitySnapshot: mutable, signal: signal()
  }), { code: "MUTABLE_IDENTITY_SNAPSHOT" });
  await assert.rejects(builder(provider(new Map())).build({
    identitySnapshot: snapshot(1), signal: signal(), fallback: true
  }), { code: "INVALID_CANDIDATE_GRAPH_INPUT" });
});

test("output is deeply frozen, vectorless and contains no sensitive or provider payload fields", async () => {
  const current = snapshot(3);
  const graph = await buildGraph(current, new Map());
  function inspect(value) {
    if (!value || typeof value !== "object") return;
    assert.equal(Object.isFrozen(value), true);
    for (const [key, child] of Object.entries(value)) {
      assert.equal(new Set([
        "text", "content", "userId", "user_id", "vector", "centroid", "payload",
        "endpoint", "secret", "apiKey", "batch", "clusterId", "clusters"
      ]).has(key), false, `forbidden output key: ${key}`);
      inspect(child);
    }
  }
  inspect(graph);
  assert.equal(JSON.stringify(graph).includes("synthetic-user"), false);
  assert.equal(graph.finalizationAuthorized, false);
});

test("module imports only node:crypto and the pure BC-1/BC-3 contracts", () => {
  const source = fs.readFileSync(path.join(__dirname,
    "../../core/clustering/HippocampusCandidateGraphBuilder.js"), "utf8");
  const imports = [...source.matchAll(/require\(([^)]+)\)/gu)].map((match) => match[1]);
  assert.deepEqual(imports, [
    '"node:crypto"', '"./HippocampusBoundedClusteringPlan"',
    '"./HippocampusDiscoveryCompleteness"'
  ]);
  assert.doesNotMatch(source,
    /ClusterEngineAdapter|HippocampusDaemon|RecallRouter|Qdrant|BgeM3|Qwen|storage|delete\s*\(|upsert\s*\(|\bfetch\s*\(/u);
});
