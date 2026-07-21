"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  BOUNDED_CLUSTERING_REASON_CODES,
  BOUNDED_CLUSTERING_STATUSES,
  DEFAULT_BOUNDED_CLUSTERING_POLICY,
  DISCOVERY_COMPLETENESS,
  createGlobalIdentitySnapshot
} = require("../../core/clustering/HippocampusBoundedClusteringPlan");
const {
  createHippocampusCandidateGraphBuilder
} = require("../../core/clustering/HippocampusCandidateGraphBuilder");
const {
  THRESHOLD_DISCOVERY_CERTIFICATE_VERSION,
  THRESHOLD_DISCOVERY_MODE,
  CERTIFICATE_STATUSES,
  CERTIFICATE_REASON_CODES,
  COMPONENT_CLOSURE_STATUSES,
  prepareThresholdDiscoveryContext,
  evaluateThresholdDiscoveryCertificate
} = require("../../core/clustering/HippocampusDiscoveryCompleteness");

const COMPLETE = DISCOVERY_COMPLETENESS.COMPLETE_ABOVE_THRESHOLD;

function hash(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function pointId(value) {
  const hex = hash(`bc3-point:${value}`);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}` +
    `-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function identity(index) {
  return {
    memoryId: `bc3-synthetic-memory-${index}`,
    contentHash: hash(`bc3-synthetic-content-${index}`),
    pointId: pointId(index),
    model: "bc3-synthetic-model",
    revision: "bc3-synthetic-revision"
  };
}

function snapshot(count = 4, order = "direct", user = "bc3-synthetic-user") {
  const identities = Array.from({ length: count }, (_, index) => identity(index));
  if (order === "inverse") identities.reverse();
  return createGlobalIdentitySnapshot({ userIdHash: hash(user), identities });
}

function certificate(current, query, enumeratedAboveThresholdCount, overrides = {}) {
  return {
    certificateVersion: THRESHOLD_DISCOVERY_CERTIFICATE_VERSION,
    mode: THRESHOLD_DISCOVERY_MODE,
    identityIndexFingerprint: current.snapshotFingerprint,
    queryPointId: query.pointId,
    clusterThreshold: DEFAULT_BOUNDED_CLUSTERING_POLICY.clusterThreshold,
    embeddingModel: query.model,
    embeddingRevision: query.revision,
    eligibleIdentityCount: Math.max(0, current.identityCount - 1),
    enumeratedAboveThresholdCount,
    exhausted: true,
    truncated: false,
    continuation: null,
    ...overrides
  };
}

function hit(target, score = 0.8) {
  return { ...target, score };
}

function response(hits = [], discoveryCompleteness = COMPLETE, queryCertificate) {
  const base = { discoveryCompleteness, hits };
  return queryCertificate === undefined ? base : { ...base, certificate: queryCertificate };
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

async function build(current, responses, overrides = {}) {
  return builder(provider(responses), overrides).build({
    identitySnapshot: current,
    signal: signal()
  });
}

function evaluate(current, query, queryCertificate, observed = 0,
  providerCompleteness = COMPLETE) {
  return evaluateThresholdDiscoveryCertificate({
    identitySnapshot: current,
    queryPointId: query.pointId,
    providerCompleteness,
    certificate: queryCertificate,
    observedAboveThresholdCount: observed
  });
}

test("prepared context validates, orders and fingerprints globally once for N O(1) queries", () => {
  const current = snapshot(64);
  const context = prepareThresholdDiscoveryContext(current);
  for (const query of current.identities) {
    const result = context.evaluate({
      queryPointId: query.pointId,
      providerCompleteness: COMPLETE,
      certificate: certificate(current, query, 0),
      observedAboveThresholdCount: 0
    });
    assert.equal(result.certificateStatus, CERTIFICATE_STATUSES.VALID);
  }
  assert.deepEqual(context.diagnostics(), {
    preparationCount: 1,
    snapshotValidationCount: 1,
    globalOrderingCount: 1,
    globalFingerprintCalculationCount: 1,
    certificateEvaluationCount: 64,
    certificateQueryLookupCount: 64,
    pointLookupCount: 0,
    memoryLookupCount: 0
  });
  assert.equal(Object.isFrozen(context), true);
  assert.equal(Object.isFrozen(context.diagnostics()), true);
  assert.equal(Object.hasOwn(context, "byPointId"), false);
  assert.equal(Object.hasOwn(context, "byMemoryId"), false);
});

test("prepared context clones identities and rejects a foreign query without rescanning", () => {
  const current = snapshot(3);
  const mutable = JSON.parse(JSON.stringify(current));
  const context = prepareThresholdDiscoveryContext(mutable);
  mutable.identities[0].contentHash = hash("mutation-after-preparation");
  const query = current.identities[0];
  assert.equal(context.findIdentityByPointId(query.pointId).contentHash, query.contentHash);
  const result = context.evaluate({
    queryPointId: pointId("foreign"),
    providerCompleteness: COMPLETE,
    certificate: null,
    observedAboveThresholdCount: 0
  });
  assert.equal(result.reasonCode, CERTIFICATE_REASON_CODES.CERTIFICATE_QUERY_NOT_CURRENT);
  assert.equal(context.diagnostics().certificateQueryLookupCount, 1);
});

test("valid exact-enumeration certificate is complete, fingerprinted and immutable", () => {
  const current = snapshot(3);
  const query = current.identities[0];
  const result = evaluate(current, query, certificate(current, query, 1), 1);
  assert.deepEqual(result, {
    certificateStatus: CERTIFICATE_STATUSES.VALID,
    reasonCode: null,
    discoveryCompleteness: COMPLETE,
    certificateFingerprint: result.certificateFingerprint
  });
  assert.match(result.certificateFingerprint, /^[a-f0-9]{64}$/u);
  assert.equal(Object.isFrozen(result), true);
});

test("ordinary top-k without a certificate remains INCOMPLETE_UNCERTIFIED", async () => {
  const current = snapshot(1);
  const query = current.identities[0];
  const direct = evaluate(current, query, null, 0, COMPLETE);
  assert.equal(direct.certificateStatus, CERTIFICATE_STATUSES.ABSENT);
  assert.equal(direct.reasonCode, CERTIFICATE_REASON_CODES.CERTIFICATE_ABSENT);
  assert.equal(direct.discoveryCompleteness,
    DISCOVERY_COMPLETENESS.INCOMPLETE_UNCERTIFIED);
  const graph = await build(current, new Map([[query.pointId, response()]]));
  assert.equal(graph.discoveryCompleteness,
    DISCOVERY_COMPLETENESS.INCOMPLETE_UNCERTIFIED);
  assert.equal(graph.finalizationAuthorized, false);
});

test("truncated:false and continuation:null without the full certificate prove nothing", () => {
  const current = snapshot(1);
  const query = current.identities[0];
  const pseudoCertificate = { truncated: false, continuation: null, resultCount: 0, limit: 10 };
  const result = evaluate(current, query, pseudoCertificate);
  assert.equal(result.certificateStatus, CERTIFICATE_STATUSES.INVALID);
  assert.equal(result.reasonCode,
    CERTIFICATE_REASON_CODES.MALFORMED_DISCOVERY_CERTIFICATE);
  assert.equal(result.discoveryCompleteness,
    DISCOVERY_COMPLETENESS.INCOMPLETE_UNCERTIFIED);
});

test("unknown certificate version and mode fail closed", () => {
  const current = snapshot(1);
  const query = current.identities[0];
  const cases = [
    [{ certificateVersion: "unknown" }, CERTIFICATE_REASON_CODES.UNKNOWN_CERTIFICATE_VERSION],
    [{ mode: "TOP_K" }, CERTIFICATE_REASON_CODES.UNKNOWN_CERTIFICATE_MODE]
  ];
  for (const [overrides, reasonCode] of cases) {
    const result = evaluate(current, query, certificate(current, query, 0, overrides));
    assert.equal(result.certificateStatus, CERTIFICATE_STATUSES.INVALID);
    assert.equal(result.reasonCode, reasonCode);
    assert.equal(result.discoveryCompleteness,
      DISCOVERY_COMPLETENESS.INCOMPLETE_UNCERTIFIED);
  }
});

test("certificate bound to a different snapshot is uncertified", () => {
  const current = snapshot(2);
  const other = snapshot(2, "direct", "another-synthetic-user");
  const query = current.identities[0];
  const result = evaluate(current, query, certificate(other, other.identities[0], 0, {
    queryPointId: query.pointId,
    embeddingModel: query.model,
    embeddingRevision: query.revision,
    eligibleIdentityCount: 1
  }));
  assert.equal(result.reasonCode, CERTIFICATE_REASON_CODES.CERTIFICATE_SNAPSHOT_MISMATCH);
  assert.equal(result.discoveryCompleteness,
    DISCOVERY_COMPLETENESS.INCOMPLETE_UNCERTIFIED);
});

test("stale or foreign query point cannot be certified", () => {
  const current = snapshot(2);
  const foreign = identity("foreign");
  const result = evaluateThresholdDiscoveryCertificate({
    identitySnapshot: current,
    queryPointId: foreign.pointId,
    providerCompleteness: COMPLETE,
    certificate: certificate(current, foreign, 0),
    observedAboveThresholdCount: 0
  });
  assert.equal(result.reasonCode,
    CERTIFICATE_REASON_CODES.CERTIFICATE_QUERY_NOT_CURRENT);
  const query = current.identities[0];
  const mismatch = evaluate(current, query, certificate(current, query, 0, {
    queryPointId: current.identities[1].pointId
  }));
  assert.equal(mismatch.reasonCode, CERTIFICATE_REASON_CODES.CERTIFICATE_QUERY_MISMATCH);
});

test("model, revision and threshold mismatches are rejected", () => {
  const current = snapshot(1);
  const query = current.identities[0];
  const cases = [
    [{ embeddingModel: "other" }, CERTIFICATE_REASON_CODES.CERTIFICATE_PROVENANCE_MISMATCH],
    [{ embeddingRevision: "other" }, CERTIFICATE_REASON_CODES.CERTIFICATE_PROVENANCE_MISMATCH],
    [{ clusterThreshold: 0.69 }, CERTIFICATE_REASON_CODES.CERTIFICATE_THRESHOLD_MISMATCH]
  ];
  for (const [overrides, reasonCode] of cases) {
    assert.equal(evaluate(current, query,
      certificate(current, query, 0, overrides)).reasonCode, reasonCode);
  }
});

test("exhausted must be true, truncated false and continuation null", () => {
  const current = snapshot(1);
  const query = current.identities[0];
  const cases = [
    [{ exhausted: false }, CERTIFICATE_REASON_CODES.CERTIFICATE_NOT_EXHAUSTED],
    [{ truncated: true }, CERTIFICATE_REASON_CODES.CERTIFICATE_TRUNCATED],
    [{ continuation: "opaque" }, CERTIFICATE_REASON_CODES.CERTIFICATE_CONTINUATION_PRESENT]
  ];
  for (const [overrides, reasonCode] of cases) {
    assert.equal(evaluate(current, query,
      certificate(current, query, 0, overrides)).reasonCode, reasonCode);
  }
});

test("certificate counters are exact, bounded and match observed unique neighbors", () => {
  const current = snapshot(3);
  const query = current.identities[0];
  const invalidCounters = [
    { eligibleIdentityCount: 99 },
    { enumeratedAboveThresholdCount: -1 },
    { enumeratedAboveThresholdCount: 3 }
  ];
  for (const overrides of invalidCounters) {
    assert.equal(evaluate(current, query,
      certificate(current, query, 0, overrides)).reasonCode,
    CERTIFICATE_REASON_CODES.CERTIFICATE_COUNTERS_INVALID);
  }
  assert.equal(evaluate(current, query, certificate(current, query, 1), 0).reasonCode,
    CERTIFICATE_REASON_CODES.CERTIFICATE_ENUMERATION_COUNT_MISMATCH);
});

test("FAILED and INCOMPLETE_TRUNCATED cannot be promoted by a valid certificate", () => {
  const current = snapshot(1);
  const query = current.identities[0];
  for (const providerCompleteness of [
    DISCOVERY_COMPLETENESS.FAILED,
    DISCOVERY_COMPLETENESS.INCOMPLETE_TRUNCATED
  ]) {
    const result = evaluate(
      current, query, certificate(current, query, 0), 0, providerCompleteness
    );
    assert.equal(result.reasonCode,
      CERTIFICATE_REASON_CODES.PROVIDER_DISCOVERY_NOT_CERTIFIABLE);
    assert.equal(result.discoveryCompleteness, providerCompleteness);
  }
});

test("component with every member certified is authorized only for BC-4", async () => {
  const current = snapshot(3);
  const [a, b, c] = current.identities;
  const responses = new Map([
    [a.pointId, response([hit(b)], COMPLETE, certificate(current, a, 1))],
    [b.pointId, response([hit(a), hit(c)], COMPLETE, certificate(current, b, 2))],
    [c.pointId, response([hit(b)], COMPLETE, certificate(current, c, 1))]
  ]);
  const graph = await build(current, responses);
  assert.equal(graph.components.length, 1);
  assert.equal(graph.components[0].closureStatus,
    COMPONENT_CLOSURE_STATUSES.AUTHORIZED_FOR_REFINEMENT);
  assert.equal(graph.components[0].finalizationAuthorized, true);
  assert.equal(graph.finalizationAuthorized, true);
  assert.equal(graph.status, BOUNDED_CLUSTERING_STATUSES.COMPLETE);
  assert.equal(Object.hasOwn(graph, "clusters"), false);
});

test("one uncertified member defers the whole candidate component", async () => {
  const current = snapshot(3);
  const [a, b, c] = current.identities;
  const responses = new Map([
    [a.pointId, response([hit(b)], COMPLETE, certificate(current, a, 1))],
    [b.pointId, response([hit(a), hit(c)], COMPLETE, certificate(current, b, 2))],
    [c.pointId, response([hit(b)])]
  ]);
  const graph = await build(current, responses);
  assert.equal(graph.components.length, 1);
  assert.equal(graph.components[0].memberCount, 3);
  assert.equal(graph.components[0].closureStatus, COMPONENT_CLOSURE_STATUSES.DEFERRED);
  assert.equal(graph.components[0].reasonCode,
    BOUNDED_CLUSTERING_REASON_CODES.DEFERRED_INCOMPLETE_NEIGHBOR_DISCOVERY);
  assert.equal(graph.components[0].finalizationAuthorized, false);
  assert.equal(graph.finalizationAuthorized, false);
});

test("disjoint certified and uncertified components produce PARTIAL_DEFERRED", async () => {
  const current = snapshot(4);
  const [a, b, c, d] = current.identities;
  const responses = new Map([
    [a.pointId, response([hit(b)], COMPLETE, certificate(current, a, 1))],
    [b.pointId, response([hit(a)], COMPLETE, certificate(current, b, 1))],
    [c.pointId, response([hit(d)])],
    [d.pointId, response([hit(c)])]
  ]);
  const graph = await build(current, responses);
  assert.equal(graph.status, BOUNDED_CLUSTERING_STATUSES.PARTIAL_DEFERRED);
  assert.equal(graph.finalizationAuthorized, true);
  assert.equal(graph.components.filter((item) => item.finalizationAuthorized).length, 1);
  assert.equal(graph.components.filter((item) => !item.finalizationAuthorized).length, 1);
});

test("certified A–B–C chain is not a cluster and exposes no complete-link claim", async () => {
  const current = snapshot(3);
  const [a, b, c] = current.identities;
  const graph = await build(current, new Map([
    [a.pointId, response([hit(b)], COMPLETE, certificate(current, a, 1))],
    [b.pointId, response([hit(a), hit(c)], COMPLETE, certificate(current, b, 2))],
    [c.pointId, response([hit(b)], COMPLETE, certificate(current, c, 1))]
  ]));
  assert.equal(graph.components[0].finalizationAuthorized, true);
  assert.equal(Object.hasOwn(graph, "clusters"), false);
  assert.equal(Object.hasOwn(graph.components[0], "minimumPairSimilarity"), false);
  assert.equal(Object.hasOwn(graph.components[0], "clusterId"), false);
});

test("an edge without certificates never closes its component", async () => {
  const current = snapshot(2);
  const [a, b] = current.identities;
  const graph = await build(current, new Map([
    [a.pointId, response([hit(b)])],
    [b.pointId, response([hit(a)])]
  ]));
  assert.equal(graph.edges.length, 1);
  assert.equal(graph.components[0].finalizationAuthorized, false);
  assert.equal(graph.discoveryCompleteness,
    DISCOVERY_COMPLETENESS.INCOMPLETE_UNCERTIFIED);
});

test("query budget preserves a disjoint already-certified component only as PARTIAL_DEFERRED", async () => {
  const current = snapshot(4);
  const [a, b] = current.identities;
  const graph = await build(current, new Map([
    [a.pointId, response([hit(b)], COMPLETE, certificate(current, a, 1))],
    [b.pointId, response([hit(a)], COMPLETE, certificate(current, b, 1))]
  ]), { maxNeighborQueries: 2 });
  assert.equal(graph.reasonCode,
    BOUNDED_CLUSTERING_REASON_CODES.DEFERRED_INCOMPLETE_NEIGHBOR_DISCOVERY);
  assert.equal(graph.status, BOUNDED_CLUSTERING_STATUSES.PARTIAL_DEFERRED);
  assert.equal(graph.components.some((item) => item.finalizationAuthorized), true);
  assert.equal(graph.queryDiscoveries.filter((item) =>
    item.reasonCode === CERTIFICATE_REASON_CODES.QUERY_NOT_COMPLETED).length, 2);
});

test("edge budget makes every candidate component visibly truncated and unauthorized", async () => {
  const current = snapshot(3);
  const [a, b, c] = current.identities;
  const graph = await build(current, new Map([[
    a.pointId,
    response([hit(b), hit(c)], COMPLETE, certificate(current, a, 2))
  ]]), { maxCandidateEdges: 1 });
  assert.equal(graph.reasonCode, BOUNDED_CLUSTERING_REASON_CODES.DEFERRED_EDGE_BUDGET);
  assert.equal(graph.discoveryCompleteness,
    DISCOVERY_COMPLETENESS.INCOMPLETE_TRUNCATED);
  assert.equal(graph.components.every((item) => !item.finalizationAuthorized), true);
});

test("timeout cannot certify the unfinished query but preserves a closed disjoint component", async () => {
  const current = snapshot(3);
  const [a, b, c] = current.identities;
  let calls = 0;
  const discoveryProvider = {
    discoverNeighbors(request) {
      calls += 1;
      if (request.queryIdentity.pointId === a.pointId) {
        return response([hit(b)], COMPLETE, certificate(current, a, 1));
      }
      if (request.queryIdentity.pointId === b.pointId) {
        return response([hit(a)], COMPLETE, certificate(current, b, 1));
      }
      assert.equal(request.queryIdentity.pointId, c.pointId);
      return new Promise(() => {});
    }
  };
  const graph = await builder(discoveryProvider, { timeoutMs: 15 }).build({
    identitySnapshot: current, signal: signal()
  });
  assert.equal(calls, 3);
  assert.equal(graph.reasonCode, BOUNDED_CLUSTERING_REASON_CODES.DEFERRED_TIMEOUT);
  assert.equal(graph.status, BOUNDED_CLUSTERING_STATUSES.PARTIAL_DEFERRED);
  assert.equal(graph.components.some((item) => item.finalizationAuthorized), true);
  assert.equal(graph.queryDiscoveries.find((item) => item.queryPointId === c.pointId)
    .discoveryCompleteness, DISCOVERY_COMPLETENESS.INCOMPLETE_UNCERTIFIED);
});

test("certified graph is deterministic for inverted input and randomized hit order", async () => {
  const direct = snapshot(3, "direct");
  const inverse = snapshot(3, "inverse");
  const [a, b, c] = direct.identities;
  const first = new Map([
    [a.pointId, response([hit(c, 0.75), hit(b, 0.85)], COMPLETE,
      certificate(direct, a, 2))],
    [b.pointId, response([hit(a, 0.85)], COMPLETE, certificate(direct, b, 1))],
    [c.pointId, response([hit(a, 0.75)], COMPLETE, certificate(direct, c, 1))]
  ]);
  const second = new Map([
    [a.pointId, response([hit(b, 0.85), hit(c, 0.75)].reverse(), COMPLETE,
      certificate(inverse, a, 2))],
    [b.pointId, response([hit(a, 0.85)], COMPLETE, certificate(inverse, b, 1))],
    [c.pointId, response([hit(a, 0.75)], COMPLETE, certificate(inverse, c, 1))]
  ]);
  assert.deepEqual(await build(direct, first), await build(inverse, second));
});

test("certification and closure are cross-batch and contain no batch identity", async () => {
  const symbolicBatches = new Map([[0, 1], [1, 17], [2, 50]]);
  const current = createGlobalIdentitySnapshot({
    userIdHash: hash("bc3-synthetic-user"),
    identities: [...symbolicBatches.keys()].map(identity).reverse()
  });
  const [a, b, c] = current.identities;
  const graph = await build(current, new Map([
    [a.pointId, response([hit(c)], COMPLETE, certificate(current, a, 1))],
    [b.pointId, response([], COMPLETE, certificate(current, b, 0))],
    [c.pointId, response([hit(a)], COMPLETE, certificate(current, c, 1))]
  ]));
  assert.equal(graph.components.find((item) => item.memberCount === 2)
    .finalizationAuthorized, true);
  assert.doesNotMatch(JSON.stringify(graph), /batch|\b17\b|\b50\b/iu);
});

test("query summaries contain only certificate fingerprints, never raw certificates", async () => {
  const current = snapshot(1);
  const query = current.identities[0];
  const rawCertificate = certificate(current, query, 0);
  const graph = await build(current, new Map([[
    query.pointId, response([], COMPLETE, rawCertificate)
  ]]));
  assert.equal(graph.queryDiscoveries[0].certificateStatus, CERTIFICATE_STATUSES.VALID);
  assert.match(graph.queryDiscoveries[0].certificateFingerprint, /^[a-f0-9]{64}$/u);
  assert.equal(JSON.stringify(graph).includes(THRESHOLD_DISCOVERY_MODE), false);
  assert.equal(JSON.stringify(graph).includes(rawCertificate.embeddingModel), false);
});

test("output is closed, frozen and contains no sensitive runtime data", async () => {
  const current = snapshot(2);
  const graph = await build(current, new Map());
  const forbidden = new Set([
    "text", "content", "userId", "user_id", "vector", "centroid", "payload",
    "endpoint", "secret", "apiKey", "batch", "clusterId", "clusters"
  ]);
  function inspect(value) {
    if (!value || typeof value !== "object") return;
    assert.equal(Object.isFrozen(value), true);
    for (const [key, child] of Object.entries(value)) {
      assert.equal(forbidden.has(key), false, `forbidden key: ${key}`);
      inspect(child);
    }
  }
  inspect(graph);
  assert.equal(JSON.stringify(graph).includes("bc3-synthetic-user"), false);
});

test("BC-3 modules use only pure contracts and no runtime or destructive imports", () => {
  const directory = path.join(__dirname, "../../core/clustering");
  const certificateSource = fs.readFileSync(path.join(directory,
    "HippocampusDiscoveryCompleteness.js"), "utf8");
  const graphSource = fs.readFileSync(path.join(directory,
    "HippocampusCandidateGraphBuilder.js"), "utf8");
  assert.deepEqual([...certificateSource.matchAll(/require\(([^)]+)\)/gu)]
    .map((match) => match[1]), [
    '"node:crypto"', '"./HippocampusBoundedClusteringPlan"'
  ]);
  assert.doesNotMatch(`${certificateSource}\n${graphSource}`,
    /ClusterEngineAdapter|HippocampusDaemon|RecallRouter|Qdrant|BgeM3|Qwen|JsonMemoryStorage|Synthesis|SuperMemory|\bfetch\s*\(|\bdelete\s*\(|\bupsert\s*\(/u);
});
