"use strict";

const {
  BOUNDED_CLUSTERING_ALGORITHM_VERSION,
  BOUNDED_CLUSTERING_REASON_CODES,
  DEFAULT_BOUNDED_CLUSTERING_POLICY,
  DISCOVERY_COMPLETENESS,
  GLOBAL_BARRIER_STATUSES,
  TIMESTAMP_QUALITY,
  compareCanonicalIdentities,
  createBoundedClusteringPlan,
  validateBoundedClusteringConfiguration,
  validateGlobalIdentitySnapshot
} = require("./HippocampusBoundedClusteringPlan");
const {
  CERTIFICATE_STATUSES,
  COMPONENT_CLOSURE_STATUSES
} = require("./HippocampusDiscoveryCompleteness");

const VECTOR_DIMENSION = 1024;
const NORMALIZATION_TOLERANCE = 1e-6;
const CANDIDATE_GRAPH_SCHEMA_VERSION = 1;
const CANDIDATE_GRAPH_VERSION = "hippocampus-candidate-graph-v1";

const OPTIONS_KEYS = Object.freeze(["clock", "embeddingResolver", "rssReader"]);
const REFINE_KEYS = Object.freeze([
  "budgets", "candidateGraph", "identitySnapshot", "policy", "signal"
]);
const RESOLVER_RESPONSE_KEYS = Object.freeze(["provenance", "vector"]);
const RESOLVER_PROVENANCE_KEYS = Object.freeze([
  "cacheSchemaVersion", "contentHash", "dimension", "identitySnapshotFingerprint",
  "memoryId", "model", "normalized", "pointId", "revision"
]);

class HippocampusBoundedCompleteLinkRefinerError extends Error {
  constructor(code, phase = "refinement") {
    super("Hippocampus bounded complete-link refinement failed");
    this.name = "HippocampusBoundedCompleteLinkRefinerError";
    this.code = code;
    this.phase = phase;
    this.retryable = false;
  }
}

function fail(code, phase) {
  throw new HippocampusBoundedCompleteLinkRefinerError(code, phase);
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

function isDeepFrozen(value) {
  if (!value || typeof value !== "object" || !Object.isFrozen(value)) return false;
  return Object.values(value).every((child) =>
    !child || typeof child !== "object" || isDeepFrozen(child));
}

function isAbortSignal(signal) {
  return signal && typeof signal === "object" &&
    typeof signal.aborted === "boolean" &&
    typeof signal.addEventListener === "function" &&
    typeof signal.removeEventListener === "function";
}

function samePolicy(policy) {
  return isPlainObject(policy) &&
    Object.keys(DEFAULT_BOUNDED_CLUSTERING_POLICY).every((key) =>
      policy[key] === DEFAULT_BOUNDED_CLUSTERING_POLICY[key]) &&
    Object.keys(policy).length === Object.keys(DEFAULT_BOUNDED_CLUSTERING_POLICY).length;
}

function assertOptions(options) {
  if (!hasExactKeys(options, OPTIONS_KEYS) ||
      !options.embeddingResolver ||
      typeof options.embeddingResolver.resolveEmbedding !== "function" ||
      !Number.isSafeInteger(options.embeddingResolver.cacheSchemaVersion) ||
      options.embeddingResolver.cacheSchemaVersion <= 0 ||
      !options.rssReader || typeof options.rssReader.readRssBytes !== "function" ||
      !options.clock || typeof options.clock.now !== "function") {
    fail("INVALID_REFINER_OPTIONS", "configuration");
  }
}

function assertRefineInput(input) {
  if (!hasExactKeys(input, REFINE_KEYS) || !isAbortSignal(input.signal) ||
      !isDeepFrozen(input.identitySnapshot) || !isDeepFrozen(input.candidateGraph)) {
    fail("INVALID_REFINEMENT_INPUT", "validation");
  }
  const snapshotValidation = validateGlobalIdentitySnapshot(input.identitySnapshot);
  if (!snapshotValidation.valid) fail(snapshotValidation.errors[0], "snapshot");
  const configurationValidation = validateBoundedClusteringConfiguration(
    input.policy, input.budgets
  );
  if (!configurationValidation.valid) {
    fail(configurationValidation.errors[0], "budget");
  }
  if (!samePolicy(input.policy)) fail("REFINEMENT_POLICY_MISMATCH", "policy");
}

function assertCandidateGraph(graph, snapshot) {
  if (graph.schemaVersion !== CANDIDATE_GRAPH_SCHEMA_VERSION ||
      graph.graphVersion !== CANDIDATE_GRAPH_VERSION ||
      graph.algorithmVersion !== BOUNDED_CLUSTERING_ALGORITHM_VERSION ||
      graph.identitySnapshotFingerprint !== snapshot.snapshotFingerprint ||
      graph.identityCount !== snapshot.identityCount ||
      !samePolicy(graph.policy) || !Array.isArray(graph.components) ||
      !Array.isArray(graph.edges) || !Array.isArray(graph.queryDiscoveries) ||
      !isPlainObject(graph.metrics)) {
    fail("INCOMPATIBLE_CANDIDATE_GRAPH", "candidate_graph");
  }
  const snapshotPointIds = new Set(snapshot.identities.map((identity) => identity.pointId));
  const queryDiscoveries = new Map();
  for (const discovery of graph.queryDiscoveries) {
    if (!isPlainObject(discovery) || !snapshotPointIds.has(discovery.queryPointId) ||
        queryDiscoveries.has(discovery.queryPointId)) {
      fail("INVALID_COMPONENT_CLOSURE", "component_closure");
    }
    queryDiscoveries.set(discovery.queryPointId, discovery);
  }
  if (queryDiscoveries.size !== snapshot.identityCount) {
    fail("INVALID_COMPONENT_CLOSURE", "component_closure");
  }
  const covered = new Set();
  for (const component of graph.components) {
    if (!isPlainObject(component) || !Array.isArray(component.memberIds) ||
        component.memberIds.length === 0 || component.memberCount !== component.memberIds.length) {
      fail("INVALID_COMPONENT_CLOSURE", "component_closure");
    }
    const canonical = [...component.memberIds].sort();
    if (canonical.some((pointId, index) => pointId !== component.memberIds[index]) ||
        new Set(canonical).size !== canonical.length) {
      fail("INVALID_COMPONENT_CLOSURE", "component_closure");
    }
    for (const pointId of canonical) {
      if (!snapshotPointIds.has(pointId) || covered.has(pointId)) {
        fail("INVALID_COMPONENT_CLOSURE", "component_closure");
      }
      covered.add(pointId);
    }
    const authorized = component.closureStatus ===
      COMPONENT_CLOSURE_STATUSES.AUTHORIZED_FOR_REFINEMENT;
    if (authorized !== (component.finalizationAuthorized === true) ||
        authorized && (component.reasonCode !== null ||
          component.discoveryCompleteness !== DISCOVERY_COMPLETENESS.COMPLETE_ABOVE_THRESHOLD) ||
        !authorized && (component.closureStatus !== COMPONENT_CLOSURE_STATUSES.DEFERRED ||
          component.finalizationAuthorized !== false ||
          component.reasonCode !== BOUNDED_CLUSTERING_REASON_CODES
            .DEFERRED_INCOMPLETE_NEIGHBOR_DISCOVERY)) {
      fail("INVALID_COMPONENT_CLOSURE", "component_closure");
    }
    if (authorized && canonical.some((pointId) => {
      const discovery = queryDiscoveries.get(pointId);
      return discovery.certificateStatus !== CERTIFICATE_STATUSES.VALID ||
        discovery.certificateFingerprint === null ||
        discovery.discoveryCompleteness !== DISCOVERY_COMPLETENESS.COMPLETE_ABOVE_THRESHOLD;
    })) {
      fail("UNCERTIFIED_COMPONENT_AUTHORIZATION", "component_closure");
    }
  }
  if (covered.size !== snapshot.identityCount) {
    fail("INCOMPLETE_COMPONENT_COVERAGE", "component_closure");
  }
}

function normalizedTemporal(memberIds) {
  return {
    orderedSourceIds: [],
    unresolvedSourceIds: [...memberIds].sort(),
    temporalStart: null,
    temporalEnd: null,
    timestampQuality: TIMESTAMP_QUALITY.NOT_EVALUATED
  };
}

function normalizeResolverResponse(response, identity, snapshotFingerprint,
  cacheSchemaVersion) {
  if (!hasExactKeys(response, RESOLVER_RESPONSE_KEYS) ||
      !hasExactKeys(response.provenance, RESOLVER_PROVENANCE_KEYS)) {
    fail("INVALID_EMBEDDING_RESPONSE", "embedding_validation");
  }
  const provenance = response.provenance;
  if (provenance.cacheSchemaVersion !== cacheSchemaVersion ||
      provenance.identitySnapshotFingerprint !== snapshotFingerprint ||
      provenance.pointId !== identity.pointId ||
      provenance.memoryId !== identity.memoryId ||
      provenance.contentHash !== identity.contentHash ||
      provenance.model !== identity.model || provenance.revision !== identity.revision ||
      provenance.dimension !== VECTOR_DIMENSION || provenance.normalized !== true) {
    fail("EMBEDDING_PROVENANCE_MISMATCH", "embedding_validation");
  }
  if (!Array.isArray(response.vector) || response.vector.length !== VECTOR_DIMENSION) {
    fail("INVALID_EMBEDDING_DIMENSION", "embedding_validation");
  }
  let squaredNorm = 0;
  for (const value of response.vector) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      fail("NON_FINITE_EMBEDDING_VECTOR", "embedding_validation");
    }
    squaredNorm += value * value;
  }
  const norm = Math.sqrt(squaredNorm);
  if (norm === 0 || Math.abs(norm - 1) > NORMALIZATION_TOLERANCE) {
    fail("NON_NORMALIZED_EMBEDDING_VECTOR", "embedding_validation");
  }
  return response.vector;
}

function createReasonCounts(deferred, unclustered) {
  const counts = Object.fromEntries(
    Object.values(BOUNDED_CLUSTERING_REASON_CODES).map((reason) => [reason, 0])
  );
  for (const disposition of [...deferred, ...unclustered]) {
    counts[disposition.reasonCode] += 1;
  }
  return counts;
}

function createHippocampusBoundedCompleteLinkRefiner(options) {
  assertOptions(options);
  const config = {
    clock: options.clock,
    embeddingResolver: options.embeddingResolver,
    rssReader: options.rssReader
  };

  async function refine(input) {
    assertRefineInput(input);
    assertCandidateGraph(input.candidateGraph, input.identitySnapshot);
    if (input.signal.aborted) fail("REFINEMENT_ABORTED", "abort");

    const startedAt = config.clock.now();
    if (typeof startedAt !== "number" || !Number.isFinite(startedAt)) {
      fail("INVALID_CLOCK_READING", "clock");
    }
    const rssStartBytes = config.rssReader.readRssBytes();
    if (!Number.isSafeInteger(rssStartBytes) || rssStartBytes < 0) {
      fail("INVALID_RSS_READING", "rss");
    }
    let rssPeakBytes = rssStartBytes;
    let rssExceeded = false;
    let timedOut = false;
    let pairwiseComparisonCount = 0;
    let maximumVectorsInMemory = 0;
    let lastObservedAt = startedAt;
    const clusters = [];
    const deferredComponents = [];
    const unclusteredComponents = [];
    const snapshot = input.identitySnapshot;
    const byPointId = new Map(snapshot.identities.map((identity) =>
      [identity.pointId, identity]));
    const rank = new Map(snapshot.identities.map((identity, index) =>
      [identity.pointId, index]));
    const controller = new AbortController();
    let externallyAborted = false;
    const onAbort = () => {
      externallyAborted = true;
      controller.abort();
    };
    input.signal.addEventListener("abort", onAbort, { once: true });

    function readNow() {
      const current = config.clock.now();
      if (typeof current !== "number" || !Number.isFinite(current) || current < startedAt) {
        fail("INVALID_CLOCK_READING", "clock");
      }
      lastObservedAt = current;
      if (current - startedAt >= input.budgets.timeoutMs) timedOut = true;
      return current;
    }

    function observeRss() {
      const current = config.rssReader.readRssBytes();
      if (!Number.isSafeInteger(current) || current < 0) fail("INVALID_RSS_READING", "rss");
      rssPeakBytes = Math.max(rssPeakBytes, current);
      if (rssPeakBytes - rssStartBytes > input.budgets.maxRssDeltaBytes) {
        rssExceeded = true;
      }
    }

    function throwIfAborted() {
      if (externallyAborted || input.signal.aborted) fail("REFINEMENT_ABORTED", "abort");
    }

    function defer(memberIds, reasonCode, discoveryCompleteness) {
      deferredComponents.push({ memberIds, reasonCode, discoveryCompleteness });
    }

    async function resolveVector(identity) {
      throwIfAborted();
      const remainingMs = input.budgets.timeoutMs - (readNow() - startedAt);
      if (remainingMs <= 0) return { status: "timeout" };
      const timeoutMarker = Symbol("timeout");
      let timer;
      let localTimeout = false;
      const providerCall = Promise.resolve().then(() =>
        config.embeddingResolver.resolveEmbedding({
          identity: {
            memoryId: identity.memoryId,
            contentHash: identity.contentHash,
            pointId: identity.pointId,
            model: identity.model,
            revision: identity.revision
          },
          identitySnapshotFingerprint: snapshot.snapshotFingerprint,
          signal: controller.signal
        }));
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => {
          localTimeout = true;
          controller.abort();
          resolve(timeoutMarker);
        }, remainingMs);
      });
      let response;
      try {
        response = await Promise.race([providerCall, timeout]);
      } catch {
        throwIfAborted();
        if (localTimeout) response = timeoutMarker;
        else fail("EMBEDDING_RESOLVER_FAILED", "embedding_retrieve");
      } finally {
        clearTimeout(timer);
      }
      throwIfAborted();
      if (response === timeoutMarker) {
        timedOut = true;
        return { status: "timeout" };
      }
      return {
        status: "resolved",
        vector: normalizeResolverResponse(
          response, identity, snapshot.snapshotFingerprint,
          config.embeddingResolver.cacheSchemaVersion
        )
      };
    }

    function cosine(left, right) {
      throwIfAborted();
      readNow();
      observeRss();
      if (timedOut) throw { disposition: BOUNDED_CLUSTERING_REASON_CODES.DEFERRED_TIMEOUT };
      if (rssExceeded) throw { disposition: BOUNDED_CLUSTERING_REASON_CODES.DEFERRED_RSS_BUDGET };
      if (pairwiseComparisonCount >= input.budgets.maxPairwiseComparisons) {
        throw { disposition: BOUNDED_CLUSTERING_REASON_CODES.DEFERRED_PAIRWISE_BUDGET };
      }
      let dotProduct = 0;
      let leftSquaredNorm = 0;
      let rightSquaredNorm = 0;
      for (let index = 0; index < VECTOR_DIMENSION; index += 1) {
        dotProduct += left[index] * right[index];
        leftSquaredNorm += left[index] * left[index];
        rightSquaredNorm += right[index] * right[index];
      }
      pairwiseComparisonCount += 1;
      const similarity = dotProduct / Math.sqrt(leftSquaredNorm * rightSquaredNorm);
      return Math.max(-1, Math.min(1, similarity));
    }

    const components = [...input.candidateGraph.components].sort((left, right) =>
      rank.get(left.memberIds[0]) - rank.get(right.memberIds[0]) ||
      left.componentId.localeCompare(right.componentId));

    try {
      for (const component of components) {
        throwIfAborted();
        const identities = component.memberIds.map((pointId) => byPointId.get(pointId))
          .sort(compareCanonicalIdentities);
        const memberIds = identities.map((identity) => identity.memoryId);
        if (component.closureStatus !== COMPONENT_CLOSURE_STATUSES.AUTHORIZED_FOR_REFINEMENT) {
          defer(memberIds, BOUNDED_CLUSTERING_REASON_CODES
            .DEFERRED_INCOMPLETE_NEIGHBOR_DISCOVERY, component.discoveryCompleteness);
          continue;
        }

        readNow();
        observeRss();
        if (timedOut) {
          defer(memberIds, BOUNDED_CLUSTERING_REASON_CODES.DEFERRED_TIMEOUT,
            component.discoveryCompleteness);
          continue;
        }
        if (rssExceeded) {
          defer(memberIds, BOUNDED_CLUSTERING_REASON_CODES.DEFERRED_RSS_BUDGET,
            component.discoveryCompleteness);
          continue;
        }
        if (identities.length > input.budgets.maxComponentVectorsInMemory) {
          defer(memberIds, BOUNDED_CLUSTERING_REASON_CODES.DEFERRED_DENSE_COMPONENT,
            component.discoveryCompleteness);
          continue;
        }
        if (identities.length > 1 &&
            pairwiseComparisonCount >= input.budgets.maxPairwiseComparisons) {
          defer(memberIds, BOUNDED_CLUSTERING_REASON_CODES.DEFERRED_PAIRWISE_BUDGET,
            component.discoveryCompleteness);
          continue;
        }

        let componentVectors = new Map();
        let componentDisposition = null;
        try {
          for (const identity of identities) {
            const resolved = await resolveVector(identity);
            if (resolved.status === "timeout") {
              componentDisposition = BOUNDED_CLUSTERING_REASON_CODES.DEFERRED_TIMEOUT;
              break;
            }
            componentVectors.set(identity.pointId, resolved.vector);
            maximumVectorsInMemory = Math.max(maximumVectorsInMemory, componentVectors.size);
            observeRss();
            if (rssExceeded) {
              componentDisposition = BOUNDED_CLUSTERING_REASON_CODES.DEFERRED_RSS_BUDGET;
              break;
            }
          }
          if (componentDisposition === null) {
            const assigned = new Set();
            const groups = [];
            for (const seed of identities) {
              if (assigned.has(seed.pointId)) continue;
              const group = [seed];
              assigned.add(seed.pointId);
              for (const candidate of identities) {
                if (assigned.has(candidate.pointId)) continue;
                let accepted = true;
                for (const existing of group) {
                  const similarity = cosine(
                    componentVectors.get(candidate.pointId),
                    componentVectors.get(existing.pointId)
                  );
                  if (similarity < input.policy.clusterThreshold) {
                    accepted = false;
                    break;
                  }
                }
                if (accepted) {
                  group.push(candidate);
                  assigned.add(candidate.pointId);
                }
              }
              groups.push(group);
            }

            const componentClusters = [];
            const componentDeferred = [];
            const componentUnclustered = [];
            for (const group of groups) {
              const groupMemberIds = group.map((identity) => identity.memoryId);
              if (group.length < input.policy.minClusterSize) {
                componentUnclustered.push({
                  memberIds: groupMemberIds,
                  reasonCode: BOUNDED_CLUSTERING_REASON_CODES.UNCLUSTERED_BELOW_MIN_SIZE,
                  discoveryCompleteness: component.discoveryCompleteness
                });
                continue;
              }
              if (input.budgets.maxClusterSize !== null &&
                  group.length > input.budgets.maxClusterSize) {
                componentDeferred.push({
                  memberIds: groupMemberIds,
                  reasonCode: BOUNDED_CLUSTERING_REASON_CODES.DEFERRED_OVERSIZED_CLUSTER,
                  discoveryCompleteness: component.discoveryCompleteness
                });
                continue;
              }
              let minimumPairSimilarity = 1;
              for (let leftIndex = 0; leftIndex < group.length; leftIndex += 1) {
                for (let rightIndex = leftIndex + 1;
                  rightIndex < group.length; rightIndex += 1) {
                  const similarity = cosine(
                    componentVectors.get(group[leftIndex].pointId),
                    componentVectors.get(group[rightIndex].pointId)
                  );
                  if (similarity < input.policy.clusterThreshold) {
                    fail("COMPLETE_LINK_VERIFICATION_FAILED", "semantic_verification");
                  }
                  minimumPairSimilarity = Math.min(minimumPairSimilarity, similarity);
                }
              }
              componentClusters.push({
                memberIds: groupMemberIds,
                minimumPairSimilarity,
                discoveryCompleteness: component.discoveryCompleteness,
                temporal: normalizedTemporal(groupMemberIds)
              });
            }
            readNow();
            observeRss();
            if (timedOut) {
              componentDisposition = BOUNDED_CLUSTERING_REASON_CODES.DEFERRED_TIMEOUT;
            } else if (rssExceeded) {
              componentDisposition = BOUNDED_CLUSTERING_REASON_CODES.DEFERRED_RSS_BUDGET;
            } else {
              clusters.push(...componentClusters);
              deferredComponents.push(...componentDeferred);
              unclusteredComponents.push(...componentUnclustered);
            }
          }
        } catch (error) {
          if (error && Object.hasOwn(error, "disposition")) {
            componentDisposition = error.disposition;
          } else {
            throw error;
          }
        } finally {
          componentVectors.clear();
          componentVectors = null;
        }
        if (componentDisposition !== null) {
          defer(memberIds, componentDisposition, component.discoveryCompleteness);
        }
      }
    } finally {
      input.signal.removeEventListener("abort", onAbort);
    }

    throwIfAborted();
    const finishedAt = lastObservedAt;
    const dispositionSizes = [...clusters, ...deferredComponents, ...unclusteredComponents]
      .map((item) => item.memberIds.length);
    const candidateComponentSizes = input.candidateGraph.components.map((component) =>
      component.memberCount);
    const maximumComponentSize = candidateComponentSizes.length === 0
      ? 0
      : Math.max(...candidateComponentSizes);
    const metrics = {
      identityCount: snapshot.identityCount,
      finalizedIdentityCount: clusters.reduce((sum, item) => sum + item.memberIds.length, 0),
      deferredIdentityCount: deferredComponents.reduce((sum, item) =>
        sum + item.memberIds.length, 0),
      unclusteredIdentityCount: unclusteredComponents.reduce((sum, item) =>
        sum + item.memberIds.length, 0),
      neighborQueryCount: input.candidateGraph.metrics.neighborQueryCount,
      candidateEdgeCount: input.candidateGraph.edges.length,
      canonicalEdgeCount: input.candidateGraph.edges.length,
      componentCount: dispositionSizes.length,
      completedComponentCount: clusters.length,
      deferredComponentCount: deferredComponents.length,
      unclusteredComponentCount: unclusteredComponents.length,
      pairwiseComparisonCount,
      maximumComponentSize,
      maximumVectorsInMemory,
      elapsedMs: finishedAt - startedAt,
      rssStartBytes,
      rssPeakBytes,
      rssDeltaBytes: rssPeakBytes - rssStartBytes,
      reasonCounts: createReasonCounts(deferredComponents, unclusteredComponents)
    };
    return createBoundedClusteringPlan({
      identitySnapshot: snapshot,
      policy: input.policy,
      budgets: input.budgets,
      provenance: {
        cacheSchemaVersion: config.embeddingResolver.cacheSchemaVersion,
        embeddingModel: snapshot.identities[0]?.model || "not-applicable",
        embeddingRevision: snapshot.identities[0]?.revision || "not-applicable",
        globalBarrierStatus: GLOBAL_BARRIER_STATUSES.COMPLETE
      },
      clusters,
      deferredComponents,
      unclusteredComponents,
      metrics
    });
  }

  return Object.freeze({ refine });
}

module.exports = {
  VECTOR_DIMENSION,
  NORMALIZATION_TOLERANCE,
  HippocampusBoundedCompleteLinkRefinerError,
  createHippocampusBoundedCompleteLinkRefiner
};
