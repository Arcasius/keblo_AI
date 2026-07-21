"use strict";

const { createHash } = require("node:crypto");
const { fingerprintEmbedding } = require("../clustering/ClusterMath");
const { createClusterRecord } = require("../clustering/ClusterRecord");
const {
  DEFAULT_BOUNDED_CLUSTERING_POLICY,
  DISCOVERY_COMPLETENESS,
  createGlobalIdentitySnapshot,
  validateBoundedClusteringConfiguration,
  validateBoundedClusteringPlan
} = require("../clustering/HippocampusBoundedClusteringPlan");
const {
  createCurrentEmbeddingIdentityIndex
} = require("./embedding-cache/CurrentEmbeddingIdentityIndex");
const {
  EMBEDDING_CACHE_MODEL,
  EMBEDDING_CACHE_REVISION
} = require("./embedding-cache/EmbeddingCacheRecord");
const {
  validateTemporalClusterProvenance
} = require("../clustering/HippocampusTemporalProvenance");
const {
  validateTemporalSynthesisRequest
} = require("../synthesis/HippocampusTemporalSynthesisRequest");
const { createSynthesisEngine } = require("../synthesis/SynthesisEngine");
const { validateSynthesisResult } = require("../synthesis/SynthesisContract");

const BOUNDED_PIPELINE_SCHEMA_VERSION = 1;
const VECTOR_DIMENSION = 1024;
const HEX_64 = /^[a-f0-9]{64}$/;
const OPTION_KEYS = Object.freeze([
  "clock", "embeddingCoordinator", "exactDiscoveryProvider", "graphBuilder",
  "refiner", "sourceResolver", "superMemoryValidator", "synthesisLimits",
  "synthesisProvider", "temporalProvenance"
]);
const RUN_KEYS = Object.freeze([
  "budgets", "constraints", "processingAttemptId", "signal"
]);
const SOURCE_KEYS = Object.freeze([
  "contentHash", "eventTimeEvidence", "lastAccess", "memoryId",
  "sourceContract", "text", "timestamp", "type"
]);

class HippocampusBoundedPipelineAdapterError extends Error {
  constructor(code, phase = "bounded_pipeline") {
    super("Hippocampus bounded pipeline operation failed");
    this.name = "HippocampusBoundedPipelineAdapterError";
    this.code = code;
    this.phase = phase;
    this.retryable = false;
  }
}

function fail(code, phase) {
  throw new HippocampusBoundedPipelineAdapterError(code, phase);
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

function isAbortSignal(signal) {
  return signal && typeof signal === "object" &&
    typeof signal.aborted === "boolean" &&
    typeof signal.addEventListener === "function" &&
    typeof signal.removeEventListener === "function";
}

function sha256Text(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function userIdHash(userId) {
  return createHash("sha256").update(userId.trim(), "utf8").digest("hex");
}

function assertDependency(target, method, code) {
  if (!isPlainObject(target) || typeof target[method] !== "function") fail(code, "configuration");
}

function assertOptions(options) {
  if (!hasExactKeys(options, OPTION_KEYS)) fail("INVALID_BOUNDED_PIPELINE_OPTIONS", "configuration");
  assertDependency(options.sourceResolver, "resolveSnapshotSources", "INVALID_SOURCE_RESOLVER");
  assertDependency(options.sourceResolver, "rereadSources", "INVALID_SOURCE_RESOLVER");
  assertDependency(options.embeddingCoordinator, "materialize", "INVALID_EMBEDDING_COORDINATOR");
  assertDependency(options.embeddingCoordinator, "resolveEmbedding", "INVALID_EMBEDDING_COORDINATOR");
  assertDependency(options.exactDiscoveryProvider, "create", "INVALID_DISCOVERY_PROVIDER");
  assertDependency(options.graphBuilder, "create", "INVALID_GRAPH_BUILDER");
  assertDependency(options.refiner, "create", "INVALID_REFINER");
  assertDependency(options.temporalProvenance, "createClusterProvenance", "INVALID_TEMPORAL_PROVENANCE");
  assertDependency(options.temporalProvenance, "createSynthesisRequest", "INVALID_TEMPORAL_PROVENANCE");
  assertDependency(options.superMemoryValidator, "create", "INVALID_SUPER_MEMORY_VALIDATOR");
  assertDependency(options.superMemoryValidator, "validate", "INVALID_SUPER_MEMORY_VALIDATOR");
  if (!isPlainObject(options.synthesisProvider) ||
      typeof options.synthesisProvider.generate !== "function" ||
      typeof options.synthesisProvider.providerId !== "string" ||
      typeof options.synthesisProvider.model !== "string" ||
      typeof options.synthesisProvider.version !== "string" ||
      options.synthesisProvider.model !== "qwen3.5:27b" ||
      !isPlainObject(options.clock) || typeof options.clock.now !== "function" ||
      !isPlainObject(options.synthesisLimits)) {
    fail("INVALID_BOUNDED_PIPELINE_OPTIONS", "configuration");
  }
}

function assertRunInput(input) {
  if (!hasExactKeys(input, RUN_KEYS) || !isAbortSignal(input.signal) ||
      typeof input.processingAttemptId !== "string" ||
      input.processingAttemptId.trim().length === 0 ||
      !isPlainObject(input.constraints)) {
    fail("INVALID_BOUNDED_PIPELINE_REQUEST", "request");
  }
  const validation = validateBoundedClusteringConfiguration(
    DEFAULT_BOUNDED_CLUSTERING_POLICY, input.budgets
  );
  if (!validation.valid) fail(validation.errors[0], "budget");
  if (input.signal.aborted) fail("BOUNDED_PIPELINE_ABORTED", "abort");
}

function normalizeSources(value, expectedIds = null) {
  if (!Array.isArray(value) || value.length === 0) fail("INVALID_SOURCE_SET", "source");
  const seen = new Set();
  const sources = value.map((source) => {
    if (!hasExactKeys(source, SOURCE_KEYS) ||
        typeof source.memoryId !== "string" || source.memoryId.trim().length === 0 ||
        typeof source.text !== "string" || source.text.length === 0 ||
        !HEX_64.test(source.contentHash || "") ||
        sha256Text(source.text) !== source.contentHash ||
        !["flat", "nested", "hybrid", "unknown"].includes(source.sourceContract) ||
        seen.has(source.memoryId)) {
      fail("INVALID_SOURCE_SET", "source");
    }
    seen.add(source.memoryId);
    return { ...source };
  }).sort((left, right) => left.memoryId.localeCompare(right.memoryId));
  if (expectedIds !== null) {
    const sortedExpected = [...expectedIds].sort();
    if (sources.length !== sortedExpected.length ||
        sources.some((source, index) => source.memoryId !== sortedExpected[index])) {
      fail("AUTHORITATIVE_REREAD_MISMATCH", "reread");
    }
  }
  return sources;
}

function assertMaterialization(result, sourceCount) {
  if (!isPlainObject(result) || !Array.isArray(result.identities) ||
      result.total !== sourceCount || result.identities.length !== sourceCount ||
      !Number.isSafeInteger(result.hitCount) ||
      !Number.isSafeInteger(result.createdCount) ||
      !Number.isSafeInteger(result.replayedCount) ||
      result.hitCount + result.createdCount + result.replayedCount !== sourceCount) {
    fail("GLOBAL_EMBEDDING_BARRIER_INCOMPLETE", "embedding_barrier");
  }
  for (const identity of result.identities) {
    if (identity.model !== EMBEDDING_CACHE_MODEL ||
        identity.revision !== EMBEDDING_CACHE_REVISION) {
      fail("EMBEDDING_PROVENANCE_MISMATCH", "embedding_barrier");
    }
  }
}

function verifyReread(reread, expectedById) {
  for (const source of reread) {
    if (expectedById.get(source.memoryId)?.contentHash !== source.contentHash) {
      fail("AUTHORITATIVE_REREAD_MISMATCH", "reread");
    }
  }
}

async function clusterCandidateFromVectors(cluster, plan, snapshot, coordinator,
  userId, signal) {
  const identities = cluster.memberIds.map((memoryId) =>
    snapshot.identities.find((identity) => identity.memoryId === memoryId));
  let vectors = [];
  try {
    for (const identity of identities) {
      const resolved = await coordinator.resolveEmbedding({
        userId,
        identity: { ...identity },
        identitySnapshotFingerprint: snapshot.snapshotFingerprint,
        signal
      });
      if (!isPlainObject(resolved) || !Array.isArray(resolved.vector) ||
          resolved.vector.length !== VECTOR_DIMENSION ||
          !isPlainObject(resolved.provenance) ||
          resolved.provenance.identitySnapshotFingerprint !== snapshot.snapshotFingerprint ||
          resolved.provenance.pointId !== identity.pointId ||
          resolved.provenance.memoryId !== identity.memoryId ||
          resolved.provenance.contentHash !== identity.contentHash ||
          resolved.provenance.model !== identity.model ||
          resolved.provenance.revision !== identity.revision) {
        fail("EMBEDDING_PROVENANCE_MISMATCH", "cluster_record");
      }
      vectors.push(resolved.vector);
    }
    const centroid = Array(VECTOR_DIMENSION).fill(0);
    for (const vector of vectors) {
      for (let index = 0; index < VECTOR_DIMENSION; index += 1) centroid[index] += vector[index];
    }
    for (let index = 0; index < VECTOR_DIMENSION; index += 1) centroid[index] /= vectors.length;
    let minimum = 1;
    let maximum = -1;
    let total = 0;
    let pairCount = 0;
    for (let left = 0; left < vectors.length; left += 1) {
      for (let right = left + 1; right < vectors.length; right += 1) {
        let dotProduct = 0;
        let leftSquaredNorm = 0;
        let rightSquaredNorm = 0;
        for (let index = 0; index < VECTOR_DIMENSION; index += 1) {
          dotProduct += vectors[left][index] * vectors[right][index];
          leftSquaredNorm += vectors[left][index] * vectors[left][index];
          rightSquaredNorm += vectors[right][index] * vectors[right][index];
        }
        let similarity = dotProduct / Math.sqrt(leftSquaredNorm * rightSquaredNorm);
        similarity = Math.max(-1, Math.min(1, similarity));
        minimum = Math.min(minimum, similarity);
        maximum = Math.max(maximum, similarity);
        total += similarity;
        pairCount += 1;
      }
    }
    if (minimum < DEFAULT_BOUNDED_CLUSTERING_POLICY.clusterThreshold ||
        Math.abs(minimum - cluster.minimumPairSimilarity) > 1e-9) {
      fail("COMPLETE_LINK_VERIFICATION_MISMATCH", "cluster_record");
    }
    return {
      schemaVersion: 1,
      algorithmVersion: "complete-link-greedy-v1",
      clusterId: cluster.clusterId,
      memberIds: [...cluster.memberIds],
      embeddingDimension: VECTOR_DIMENSION,
      centroid,
      centroidFingerprint: fingerprintEmbedding(centroid),
      density: {
        averageSimilarity: pairCount === 0 ? 1 : total / pairCount,
        minimumSimilarity: minimum,
        maximumSimilarity: pairCount === 0 ? 1 : maximum,
        memberCount: cluster.memberIds.length
      },
      policy: {
        similarityThreshold: DEFAULT_BOUNDED_CLUSTERING_POLICY.clusterThreshold,
        minClusterSize: DEFAULT_BOUNDED_CLUSTERING_POLICY.minClusterSize,
        maxClusterSize: plan.budgets.maxClusterSize
      },
      reasonCodes: ["CLUSTERED"],
      persisted: false
    };
  } finally {
    vectors = null;
  }
}

function countValidCertificates(graph) {
  return graph.queryDiscoveries.filter((item) =>
    item.discoveryCompleteness === DISCOVERY_COMPLETENESS.COMPLETE_ABOVE_THRESHOLD &&
    item.certificateStatus === "VALID" &&
    typeof item.certificateFingerprint === "string").length;
}

function createHippocampusBoundedPipelineAdapter(options) {
  assertOptions(options);

  async function execute(input, artifactContext) {
    assertRunInput(input);
    const startedAt = options.clock.now();
    const resolved = await options.sourceResolver.resolveSnapshotSources({
      signal: input.signal
    });
    if (!isPlainObject(resolved) || typeof resolved.userId !== "string" ||
        resolved.userId.trim().length === 0) {
      fail("INVALID_SOURCE_RESOLUTION", "source");
    }
    const sources = normalizeSources(resolved.sources);
    const expectedById = new Map(sources.map((source) => [source.memoryId, source]));
    const materialized = await options.embeddingCoordinator.materialize({
      items: sources.map((source) => ({
        userId: resolved.userId,
        memoryId: source.memoryId,
        contentHash: source.contentHash,
        text: source.text
      })),
      signal: input.signal
    });
    assertMaterialization(materialized, sources.length);
    const identityItems = materialized.identities.map((identity) => ({
      memoryId: identity.memoryId,
      contentHash: identity.contentHash,
      model: identity.model,
      revision: identity.revision
    }));
    const validIdentityIndex = createCurrentEmbeddingIdentityIndex({
      userId: resolved.userId,
      items: identityItems
    });
    const identitySnapshot = createGlobalIdentitySnapshot({
      userIdHash: userIdHash(resolved.userId),
      identities: identityItems.map((identity) => ({
        ...identity,
        pointId: validIdentityIndex.getExpected(identity.memoryId).pointId
      }))
    });
    const discoveryProvider = options.exactDiscoveryProvider.create({
      userId: resolved.userId,
      validIdentityIndex,
      identitySnapshotFingerprint: identitySnapshot.snapshotFingerprint
    });
    const graph = await options.graphBuilder.create({
      discoveryProvider,
      budgets: input.budgets
    }).build({ identitySnapshot, signal: input.signal });
    const plan = await options.refiner.create({
      embeddingCoordinator: options.embeddingCoordinator,
      userId: resolved.userId
    }).refine({
      identitySnapshot,
      candidateGraph: graph,
      policy: DEFAULT_BOUNDED_CLUSTERING_POLICY,
      budgets: input.budgets,
      signal: input.signal
    });
    const planValidation = validateBoundedClusteringPlan(plan, identitySnapshot);
    if (!planValidation.valid) fail(planValidation.errors[0], "bounded_plan");

    let synthesisCalls = 0;
    let temporarySuperMemoryValidCount = 0;
    let blockedClusterCount = 0;
    const clusterSummaries = [];
    const synthesisEngine = createSynthesisEngine({
      modelProvider: options.synthesisProvider,
      limits: options.synthesisLimits
    });
    for (const cluster of plan.clusters) {
      try {
        const clusterSources = cluster.memberIds.map((memoryId) => expectedById.get(memoryId));
        const temporalProvenance = options.temporalProvenance.createClusterProvenance({
          boundedClusteringPlan: plan,
          clusterId: cluster.clusterId,
          identitySnapshot,
          sources: clusterSources.map((source) => ({
            memoryId: source.memoryId,
            contentHash: source.contentHash,
            sourceContract: source.sourceContract,
            timestamp: source.timestamp,
            lastAccess: source.lastAccess,
            eventTimeEvidence: source.eventTimeEvidence
          }))
        });
        if (!validateTemporalClusterProvenance(temporalProvenance).valid) {
          fail("INVALID_TEMPORAL_PROVENANCE", "temporal");
        }
        const temporalRequest = options.temporalProvenance.createSynthesisRequest({
          temporalProvenance
        });
        if (!validateTemporalSynthesisRequest(temporalRequest, temporalProvenance).valid ||
            temporalRequest.currentStateEvidence.currentStateSupported !== false) {
          fail("INVALID_TEMPORAL_SYNTHESIS_REQUEST", "temporal");
        }
        const reread = normalizeSources(await options.sourceResolver.rereadSources({
          memoryIds: [...cluster.memberIds],
          signal: input.signal
        }), cluster.memberIds);
        verifyReread(reread, expectedById);
        const candidate = await clusterCandidateFromVectors(
          cluster, plan, identitySnapshot, options.embeddingCoordinator,
          resolved.userId, input.signal
        );
        const createdAt = options.clock.now();
        const clusterRecord = createClusterRecord({
          userId: resolved.userId,
          clusterCandidate: candidate,
          planId: plan.planId,
          createdAt,
          embedding: {
            providerId: "bge-m3-embedding-cache",
            model: EMBEDDING_CACHE_MODEL,
            version: EMBEDDING_CACHE_REVISION
          }
        });
        synthesisCalls += 1;
        const synthesisResult = await synthesisEngine.synthesize({
          clusterRecord,
          memories: reread.map((source) => ({
            id: source.memoryId,
            type: source.type,
            content: { text: source.text },
            timestamp: source.timestamp
          })),
          constraints: input.constraints
        });
        validateSynthesisResult(synthesisResult);
        const temporary = options.superMemoryValidator.create({
          userId: resolved.userId,
          clusterRecord,
          synthesisResult,
          committedAt: options.clock.now(),
          processingAttemptId: input.processingAttemptId
        });
        options.superMemoryValidator.validate(temporary);
        temporarySuperMemoryValidCount += 1;
        clusterSummaries.push({
          memberCount: cluster.memberIds.length,
          timestampQuality: temporalProvenance.timestampQuality,
          currentStateSupported: false,
          temporarySuperMemoryValid: true
        });
        if (artifactContext !== null) {
          const accepted = artifactContext.boundary.accept({
            capability: artifactContext.capability,
            userId: artifactContext.userId,
            runId: artifactContext.runId,
            signal: input.signal,
            artifact: {
              createdAt,
              identityIndexFingerprint: identitySnapshot.snapshotFingerprint,
              cluster: clusterRecord,
              temporalProvenance,
              synthesisResult,
              candidateSuperMemory: temporary
            }
          });
          return deepFreeze({
            ...accepted,
            candidateCountVerified: sources.length,
            cacheLookupCount: materialized.total,
            cacheHitCount: materialized.hitCount,
            cacheMissCount: materialized.createdCount + materialized.replayedCount,
            neighborQueryCount: graph.queryDiscoveries.length,
            exactCertificateCount: countValidCertificates(graph),
            clusterCount: plan.clusters.length
          });
        }
      } catch (error) {
        if (error?.phase === "bounded_pilot_artifact_boundary") throw error;
        if (artifactContext !== null) throw error;
        blockedClusterCount += 1;
      }
    }
    if (artifactContext !== null) {
      return deepFreeze({
        schemaVersion: BOUNDED_PIPELINE_SCHEMA_VERSION,
        boundaryVersion: artifactContext.boundaryVersion,
        status: "NO_FINALIZABLE_CLUSTER",
        sourceCount: 0
      });
    }
    const completedAt = options.clock.now();
    return deepFreeze({
      schemaVersion: BOUNDED_PIPELINE_SCHEMA_VERSION,
      status: blockedClusterCount === 0 ? "COMPLETE" : "PARTIAL_DEFERRED",
      sourceCount: sources.length,
      cache: {
        hit: materialized.hitCount,
        created: materialized.createdCount,
        replay: materialized.replayedCount
      },
      exactCertificateCount: countValidCertificates(graph),
      components: {
        completed: plan.clusters.length - blockedClusterCount,
        deferred: plan.deferredComponents.length + blockedClusterCount,
        unclustered: plan.unclusteredComponents.length
      },
      clusterCount: clusterSummaries.length,
      clusterSizes: clusterSummaries.map((item) => item.memberCount),
      timestampQuality: clusterSummaries.map((item) => item.timestampQuality),
      currentStateSupported: false,
      synthesisCalls,
      temporarySuperMemoryValid:
        temporarySuperMemoryValidCount === clusterSummaries.length &&
        clusterSummaries.length > 0,
      commitCalls: 0,
      realDataModified: false,
      elapsedMs: completedAt - startedAt
    });
  }

  function run(input) {
    return execute(input, null);
  }

  function runFirstFinalizable(input, artifactContext) {
    if (!isPlainObject(artifactContext) ||
        typeof artifactContext.runId !== "string" ||
        artifactContext.runId.length === 0 ||
        typeof artifactContext.userId !== "string" ||
        artifactContext.userId.length === 0 ||
        !isPlainObject(artifactContext.capability) ||
        !isPlainObject(artifactContext.boundary) ||
        typeof artifactContext.boundary.accept !== "function" ||
        typeof artifactContext.boundaryVersion !== "string") {
      fail("BOUNDED_PILOT_ARTIFACT_BOUNDARY_UNAVAILABLE", "request");
    }
    return execute(input, artifactContext);
  }

  return Object.freeze({ run, runFirstFinalizable });
}

module.exports = {
  BOUNDED_PIPELINE_SCHEMA_VERSION,
  HippocampusBoundedPipelineAdapterError,
  createHippocampusBoundedPipelineAdapter
};
