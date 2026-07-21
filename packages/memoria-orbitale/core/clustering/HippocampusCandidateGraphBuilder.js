"use strict";

const { createHash } = require("node:crypto");
const {
  BOUNDED_CLUSTERING_ALGORITHM_VERSION,
  BOUNDED_CLUSTERING_REASON_CODES,
  BOUNDED_CLUSTERING_STATUSES,
  DEFAULT_BOUNDED_CLUSTERING_POLICY,
  DISCOVERY_COMPLETENESS
} = require("./HippocampusBoundedClusteringPlan");
const {
  COMPONENT_CLOSURE_STATUSES,
  createUnqueriedDiscoveryEvaluation,
  prepareThresholdDiscoveryContext
} = require("./HippocampusDiscoveryCompleteness");

const CANDIDATE_GRAPH_SCHEMA_VERSION = 1;
const CANDIDATE_GRAPH_VERSION = "hippocampus-candidate-graph-v1";

const HEX_64 = /^[a-f0-9]{64}$/;
const UUID_V5 = /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

const OPTIONS_KEYS = Object.freeze([
  "discoveryProvider", "maxNeighborQueries", "maxCandidateEdges", "timeoutMs"
]);
const BUILD_KEYS = Object.freeze(["identitySnapshot", "signal"]);
const RESPONSE_KEYS = Object.freeze(["discoveryCompleteness", "hits"]);
const CERTIFIED_RESPONSE_KEYS = Object.freeze([
  "discoveryCompleteness", "hits", "certificate"
]);
const HIT_KEYS = Object.freeze([
  "pointId", "memoryId", "contentHash", "model", "revision", "score"
]);

const COMPLETENESS_VALUES = new Set(Object.values(DISCOVERY_COMPLETENESS));
const COMPLETENESS_PRIORITY = new Map([
  [DISCOVERY_COMPLETENESS.COMPLETE_ABOVE_THRESHOLD, 0],
  [DISCOVERY_COMPLETENESS.INCOMPLETE_UNCERTIFIED, 1],
  [DISCOVERY_COMPLETENESS.INCOMPLETE_TRUNCATED, 2],
  [DISCOVERY_COMPLETENESS.FAILED, 3]
]);

class HippocampusCandidateGraphError extends Error {
  constructor(code, phase = "candidate_graph") {
    super("Hippocampus candidate graph operation failed");
    this.name = "HippocampusCandidateGraphError";
    this.code = code;
    this.phase = phase;
    this.retryable = false;
  }
}

function fail(code, phase) {
  throw new HippocampusCandidateGraphError(code, phase);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, keys) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function deepFreeze(value) {
  Object.freeze(value);
  for (const child of Object.values(value)) {
    if (child && typeof child === "object" && !Object.isFrozen(child)) deepFreeze(child);
  }
  return value;
}

function isDeepFrozen(value) {
  if (!value || typeof value !== "object" || !Object.isFrozen(value)) return false;
  return Object.values(value).every((child) =>
    !child || typeof child !== "object" || isDeepFrozen(child));
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

function isAbortSignal(signal) {
  return signal && typeof signal === "object" &&
    typeof signal.aborted === "boolean" &&
    typeof signal.addEventListener === "function" &&
    typeof signal.removeEventListener === "function";
}

function assertOptions(options) {
  if (!hasExactKeys(options, OPTIONS_KEYS) ||
      !options.discoveryProvider ||
      typeof options.discoveryProvider.discoverNeighbors !== "function") {
    fail("INVALID_CANDIDATE_GRAPH_OPTIONS", "configuration");
  }
  for (const key of ["maxNeighborQueries", "maxCandidateEdges", "timeoutMs"]) {
    if (!Number.isSafeInteger(options[key]) || options[key] <= 0) {
      fail("INVALID_CANDIDATE_GRAPH_BUDGET", "configuration");
    }
  }
}

function assertBuildInput(input) {
  if (!hasExactKeys(input, BUILD_KEYS) || !isAbortSignal(input.signal)) {
    fail("INVALID_CANDIDATE_GRAPH_INPUT", "validation");
  }
  if (!isDeepFrozen(input.identitySnapshot)) {
    fail("MUTABLE_IDENTITY_SNAPSHOT", "validation");
  }
}

function normalizeResponse(response) {
  if ((!hasExactKeys(response, RESPONSE_KEYS) &&
       !hasExactKeys(response, CERTIFIED_RESPONSE_KEYS)) ||
      !COMPLETENESS_VALUES.has(response.discoveryCompleteness) ||
      !Array.isArray(response.hits) ||
      response.discoveryCompleteness === DISCOVERY_COMPLETENESS.FAILED &&
        response.hits.length !== 0) {
    fail("INVALID_DISCOVERY_RESPONSE", "discovery");
  }
  const hits = response.hits.map((hit) => {
    if (!hasExactKeys(hit, HIT_KEYS) ||
        !UUID_V5.test(hit.pointId || "") ||
        typeof hit.memoryId !== "string" || hit.memoryId.trim().length === 0 ||
        !HEX_64.test(hit.contentHash || "") ||
        typeof hit.model !== "string" || hit.model.length === 0 ||
        typeof hit.revision !== "string" || hit.revision.length === 0 ||
        typeof hit.score !== "number" || !Number.isFinite(hit.score) ||
        hit.score < -1 || hit.score > 1) {
      fail("INVALID_DISCOVERY_HIT", "discovery");
    }
    return {
      pointId: hit.pointId,
      memoryId: hit.memoryId,
      contentHash: hit.contentHash,
      model: hit.model,
      revision: hit.revision,
      score: hit.score
    };
  }).sort((left, right) =>
    left.pointId.localeCompare(right.pointId) ||
    right.score - left.score ||
    left.memoryId.localeCompare(right.memoryId) ||
    left.contentHash.localeCompare(right.contentHash) ||
    left.model.localeCompare(right.model) ||
    left.revision.localeCompare(right.revision));
  return {
    discoveryCompleteness: response.discoveryCompleteness,
    hits,
    certificate: Object.hasOwn(response, "certificate") ? response.certificate : null
  };
}

function aggregateCompleteness(values) {
  let aggregate = DISCOVERY_COMPLETENESS.COMPLETE_ABOVE_THRESHOLD;
  for (const value of values) {
    if (COMPLETENESS_PRIORITY.get(value) > COMPLETENESS_PRIORITY.get(aggregate)) {
      aggregate = value;
    }
  }
  return aggregate;
}

function canonicalPair(left, right) {
  return left < right ? [left, right] : [right, left];
}

function edgeKey(left, right) {
  return `${left}\u0000${right}`;
}

function edgeId(snapshotFingerprint, pointIdA, pointIdB) {
  return sha256({
    domain: "hippocampus-candidate-edge-v1",
    algorithmVersion: BOUNDED_CLUSTERING_ALGORITHM_VERSION,
    identitySnapshotFingerprint: snapshotFingerprint,
    pointIdA,
    pointIdB
  });
}

function componentId(snapshotFingerprint, memberIds) {
  return sha256({
    domain: "hippocampus-candidate-component-v1",
    algorithmVersion: BOUNDED_CLUSTERING_ALGORITHM_VERSION,
    identitySnapshotFingerprint: snapshotFingerprint,
    memberIds
  });
}

function createUnionFind(pointIds) {
  const parent = new Map(pointIds.map((pointId) => [pointId, pointId]));

  function find(pointId) {
    let root = pointId;
    while (parent.get(root) !== root) root = parent.get(root);
    let current = pointId;
    while (current !== root) {
      const next = parent.get(current);
      parent.set(current, root);
      current = next;
    }
    return root;
  }

  function union(left, right) {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot === rightRoot) return;
    const [root, child] = leftRoot < rightRoot
      ? [leftRoot, rightRoot]
      : [rightRoot, leftRoot];
    parent.set(child, root);
  }

  return { find, union };
}

function createMetrics() {
  return {
    neighborQueryCount: 0,
    providerHitCount: 0,
    acceptedObservationCount: 0,
    duplicateObservationCount: 0,
    selfHitCount: 0,
    foreignPointHitCount: 0,
    staleIdentityHitCount: 0,
    incompatibleProvenanceHitCount: 0,
    belowThresholdHitCount: 0,
    candidateEdgeCount: 0,
    componentCount: 0,
    maximumComponentSize: 0,
    queriedIdentityCount: 0,
    unqueriedIdentityCount: 0,
    discoveryCounts: {
      COMPLETE_ABOVE_THRESHOLD: 0,
      INCOMPLETE_TRUNCATED: 0,
      INCOMPLETE_UNCERTIFIED: 0,
      FAILED: 0
    }
  };
}

function classifyHit(queryIdentity, hit, discoveryContext, metrics) {
  const current = discoveryContext.findIdentityByPointId(hit.pointId);
  if (!current) {
    if (discoveryContext.hasMemoryId(hit.memoryId)) metrics.staleIdentityHitCount += 1;
    else metrics.foreignPointHitCount += 1;
    return false;
  }
  if (hit.model !== current.model || hit.revision !== current.revision) {
    metrics.incompatibleProvenanceHitCount += 1;
    return false;
  }
  if (hit.memoryId !== current.memoryId || hit.contentHash !== current.contentHash) {
    metrics.staleIdentityHitCount += 1;
    return false;
  }
  if (hit.pointId === queryIdentity.pointId) {
    metrics.selfHitCount += 1;
    return false;
  }
  if (hit.score < DEFAULT_BOUNDED_CLUSTERING_POLICY.clusterThreshold) {
    metrics.belowThresholdHitCount += 1;
    return false;
  }
  return true;
}

function buildComponents(snapshot, edges, queryCompleteness, forcedCompleteness) {
  const pointIds = snapshot.identities.map((identity) => identity.pointId);
  const unionFind = createUnionFind(pointIds);
  for (const edge of edges) unionFind.union(edge.pointIdA, edge.pointIdB);

  const grouped = new Map();
  for (const pointId of pointIds) {
    const root = unionFind.find(pointId);
    if (!grouped.has(root)) grouped.set(root, []);
    grouped.get(root).push(pointId);
  }
  return [...grouped.values()].map((memberIds) => {
    memberIds.sort();
    const completenessValues = memberIds.map((pointId) =>
      queryCompleteness.get(pointId) || DISCOVERY_COMPLETENESS.INCOMPLETE_UNCERTIFIED);
    if (forcedCompleteness !== null) completenessValues.push(forcedCompleteness);
    const discoveryCompleteness = aggregateCompleteness(completenessValues);
    const finalizationAuthorized =
      discoveryCompleteness === DISCOVERY_COMPLETENESS.COMPLETE_ABOVE_THRESHOLD;
    return {
      componentId: componentId(snapshot.snapshotFingerprint, memberIds),
      memberIds,
      memberCount: memberIds.length,
      discoveryCompleteness,
      closureStatus: finalizationAuthorized
        ? COMPONENT_CLOSURE_STATUSES.AUTHORIZED_FOR_REFINEMENT
        : COMPONENT_CLOSURE_STATUSES.DEFERRED,
      reasonCode: finalizationAuthorized
        ? null
        : BOUNDED_CLUSTERING_REASON_CODES.DEFERRED_INCOMPLETE_NEIGHBOR_DISCOVERY,
      finalizationAuthorized
    };
  }).sort((left, right) =>
    left.memberIds[0].localeCompare(right.memberIds[0]) ||
    left.memberCount - right.memberCount ||
    left.componentId.localeCompare(right.componentId));
}

function createOutput(snapshot, state) {
  const edges = [...state.edges.values()].map((edge) => ({
    edgeId: edgeId(snapshot.snapshotFingerprint, edge.pointIdA, edge.pointIdB),
    pointIdA: edge.pointIdA,
    pointIdB: edge.pointIdB,
    maximumObservedScore: edge.maximumObservedScore
  })).sort((left, right) =>
    left.pointIdA.localeCompare(right.pointIdA) ||
    left.pointIdB.localeCompare(right.pointIdB));
  const unqueriedIdentityCount = snapshot.identityCount - state.metrics.queriedIdentityCount;
  const aggregateValues = [...state.queryCompleteness.values()];
  let forcedCompleteness = null;
  if (state.reasonCode === BOUNDED_CLUSTERING_REASON_CODES.DEFERRED_EDGE_BUDGET) {
    forcedCompleteness = DISCOVERY_COMPLETENESS.INCOMPLETE_TRUNCATED;
  }
  if (forcedCompleteness !== null) aggregateValues.push(forcedCompleteness);
  if (unqueriedIdentityCount > 0) {
    aggregateValues.push(DISCOVERY_COMPLETENESS.INCOMPLETE_UNCERTIFIED);
  }
  const components = buildComponents(
    snapshot, edges, state.queryCompleteness, forcedCompleteness
  );
  const discoveryCompleteness = aggregateCompleteness(aggregateValues);
  const authorizedComponentCount = components.filter((component) =>
    component.finalizationAuthorized).length;
  const deferredComponentCount = components.length - authorizedComponentCount;
  const reasonCode = state.reasonCode || (deferredComponentCount > 0
    ? BOUNDED_CLUSTERING_REASON_CODES.DEFERRED_INCOMPLETE_NEIGHBOR_DISCOVERY
    : null);
  let status;
  if (components.length === 0) {
    status = reasonCode === null
      ? BOUNDED_CLUSTERING_STATUSES.COMPLETE
      : BOUNDED_CLUSTERING_STATUSES.DEFERRED;
  } else if (authorizedComponentCount === components.length) {
    status = BOUNDED_CLUSTERING_STATUSES.COMPLETE;
  } else if (authorizedComponentCount > 0) {
    status = BOUNDED_CLUSTERING_STATUSES.PARTIAL_DEFERRED;
  } else {
    status = BOUNDED_CLUSTERING_STATUSES.DEFERRED;
  }
  const queryDiscoveries = snapshot.identities.map((identity) => {
    const received = state.receivedCompleteness.get(identity.pointId) || null;
    const current = state.queryEvaluations.get(identity.pointId) ||
      createUnqueriedDiscoveryEvaluation();
    return {
      queryPointId: identity.pointId,
      receivedDiscoveryCompleteness: received,
      discoveryCompleteness: current.discoveryCompleteness,
      certificateStatus: current.certificateStatus,
      certificateFingerprint: current.certificateFingerprint,
      reasonCode: current.reasonCode
    };
  });
  const metrics = {
    ...state.metrics,
    candidateEdgeCount: edges.length,
    componentCount: components.length,
    maximumComponentSize: components.reduce((maximum, component) =>
      Math.max(maximum, component.memberCount), 0),
    unqueriedIdentityCount
  };
  const identity = {
    domain: "hippocampus-candidate-graph-v1",
    schemaVersion: CANDIDATE_GRAPH_SCHEMA_VERSION,
    graphVersion: CANDIDATE_GRAPH_VERSION,
    algorithmVersion: BOUNDED_CLUSTERING_ALGORITHM_VERSION,
    identitySnapshotFingerprint: snapshot.snapshotFingerprint,
    policy: DEFAULT_BOUNDED_CLUSTERING_POLICY,
    status,
    reasonCode,
    discoveryCompleteness,
    edges,
    components,
    queryDiscoveries
  };
  return deepFreeze({
    schemaVersion: CANDIDATE_GRAPH_SCHEMA_VERSION,
    graphVersion: CANDIDATE_GRAPH_VERSION,
    algorithmVersion: BOUNDED_CLUSTERING_ALGORITHM_VERSION,
    graphId: sha256(identity),
    status,
    reasonCode,
    identitySnapshotFingerprint: snapshot.snapshotFingerprint,
    identityCount: snapshot.identityCount,
    policy: DEFAULT_BOUNDED_CLUSTERING_POLICY,
    discoveryCompleteness,
    edges,
    components,
    queryDiscoveries,
    metrics,
    finalizationAuthorized: authorizedComponentCount > 0
  });
}

function createHippocampusCandidateGraphBuilder(options) {
  assertOptions(options);
  const config = {
    discoveryProvider: options.discoveryProvider,
    maxNeighborQueries: options.maxNeighborQueries,
    maxCandidateEdges: options.maxCandidateEdges,
    timeoutMs: options.timeoutMs
  };
  let lastPreparationDiagnostics = null;

  async function build(input) {
    assertBuildInput(input);
    if (input.signal.aborted) fail("CANDIDATE_GRAPH_ABORTED", "abort");

    const snapshot = input.identitySnapshot;
    let discoveryContext;
    try {
      discoveryContext = prepareThresholdDiscoveryContext(snapshot);
    } catch (error) {
      fail(error && error.code || "INVALID_IDENTITY_SNAPSHOT", "snapshot");
    }
    const state = {
      edges: new Map(),
      metrics: createMetrics(),
      queryCompleteness: new Map(),
      queryEvaluations: new Map(),
      receivedCompleteness: new Map(),
      reasonCode: null
    };
    const controller = new AbortController();
    const startedAt = Date.now();
    const deadline = startedAt + config.timeoutMs;
    let externallyAborted = false;
    const onAbort = () => {
      externallyAborted = true;
      controller.abort();
    };
    input.signal.addEventListener("abort", onAbort, { once: true });

    try {
      for (const queryIdentity of snapshot.identities) {
        if (externallyAborted || input.signal.aborted) {
          fail("CANDIDATE_GRAPH_ABORTED", "abort");
        }
        if (state.metrics.neighborQueryCount >= config.maxNeighborQueries) {
          state.reasonCode = BOUNDED_CLUSTERING_REASON_CODES
            .DEFERRED_INCOMPLETE_NEIGHBOR_DISCOVERY;
          break;
        }
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
          controller.abort();
          state.reasonCode = BOUNDED_CLUSTERING_REASON_CODES.DEFERRED_TIMEOUT;
          break;
        }

        const timeoutMarker = Symbol("timeout");
        let timer;
        let timedOut = false;
        const providerCall = Promise.resolve().then(() =>
          config.discoveryProvider.discoverNeighbors({
            queryIdentity: {
              memoryId: queryIdentity.memoryId,
              contentHash: queryIdentity.contentHash,
              pointId: queryIdentity.pointId,
              model: queryIdentity.model,
              revision: queryIdentity.revision
            },
            identitySnapshotFingerprint: snapshot.snapshotFingerprint,
            clusterThreshold: DEFAULT_BOUNDED_CLUSTERING_POLICY.clusterThreshold,
            signal: controller.signal
          }));
        const timeout = new Promise((resolve) => {
          timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
            resolve(timeoutMarker);
          }, remainingMs);
        });
        let rawResponse;
        try {
          rawResponse = await Promise.race([providerCall, timeout]);
        } catch {
          if (externallyAborted || input.signal.aborted) {
            fail("CANDIDATE_GRAPH_ABORTED", "abort");
          }
          if (timedOut) rawResponse = timeoutMarker;
          else fail("DISCOVERY_PROVIDER_FAILED", "discovery");
        } finally {
          clearTimeout(timer);
        }
        if (rawResponse === timeoutMarker) {
          state.reasonCode = BOUNDED_CLUSTERING_REASON_CODES.DEFERRED_TIMEOUT;
          break;
        }

        const response = normalizeResponse(rawResponse);
        state.metrics.neighborQueryCount += 1;
        state.metrics.queriedIdentityCount += 1;
        state.metrics.discoveryCounts[response.discoveryCompleteness] += 1;
        state.receivedCompleteness.set(queryIdentity.pointId, response.discoveryCompleteness);
        state.metrics.providerHitCount += response.hits.length;

        const observations = new Map();
        for (const hit of response.hits) {
          if (!classifyHit(queryIdentity, hit, discoveryContext, state.metrics)) continue;
          state.metrics.acceptedObservationCount += 1;
          const [pointIdA, pointIdB] = canonicalPair(queryIdentity.pointId, hit.pointId);
          const key = edgeKey(pointIdA, pointIdB);
          const previous = observations.get(key);
          if (previous) state.metrics.duplicateObservationCount += 1;
          if (!previous || hit.score > previous.maximumObservedScore) {
            observations.set(key, { pointIdA, pointIdB, maximumObservedScore: hit.score });
          }
        }

        const certificateEvaluation = discoveryContext.evaluate({
          queryPointId: queryIdentity.pointId,
          providerCompleteness: response.discoveryCompleteness,
          certificate: response.certificate,
          observedAboveThresholdCount: observations.size
        });
        state.queryEvaluations.set(queryIdentity.pointId, certificateEvaluation);
        state.queryCompleteness.set(
          queryIdentity.pointId, certificateEvaluation.discoveryCompleteness
        );

        for (const [key, observation] of [...observations.entries()].sort(([left], [right]) =>
          left.localeCompare(right))) {
          const current = state.edges.get(key);
          if (current) {
            state.metrics.duplicateObservationCount += 1;
            if (observation.maximumObservedScore > current.maximumObservedScore) {
              state.edges.set(key, observation);
            }
            continue;
          }
          if (state.edges.size >= config.maxCandidateEdges) {
            state.reasonCode = BOUNDED_CLUSTERING_REASON_CODES.DEFERRED_EDGE_BUDGET;
            break;
          }
          state.edges.set(key, observation);
        }
        if (state.reasonCode === BOUNDED_CLUSTERING_REASON_CODES.DEFERRED_EDGE_BUDGET) break;
      }

      if (externallyAborted || input.signal.aborted && !controller.signal.aborted) {
        fail("CANDIDATE_GRAPH_ABORTED", "abort");
      }
      if (state.reasonCode === null && Date.now() >= deadline &&
          state.metrics.queriedIdentityCount < snapshot.identityCount) {
        state.reasonCode = BOUNDED_CLUSTERING_REASON_CODES.DEFERRED_TIMEOUT;
      }
      return createOutput(snapshot, state);
    } finally {
      lastPreparationDiagnostics = discoveryContext.diagnostics();
      input.signal.removeEventListener("abort", onAbort);
    }
  }

  function getLastPreparationDiagnostics() {
    return lastPreparationDiagnostics;
  }

  return deepFreeze({ build, getLastPreparationDiagnostics });
}

module.exports = {
  CANDIDATE_GRAPH_SCHEMA_VERSION,
  CANDIDATE_GRAPH_VERSION,
  HippocampusCandidateGraphError,
  createHippocampusCandidateGraphBuilder
};
