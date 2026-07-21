"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");

const {
  DEFAULT_BOUNDED_CLUSTERING_POLICY,
  DISCOVERY_COMPLETENESS
} = require("../../core/clustering/HippocampusBoundedClusteringPlan");
const {
  THRESHOLD_DISCOVERY_CERTIFICATE_VERSION,
  THRESHOLD_DISCOVERY_MODE
} = require("../../core/clustering/HippocampusDiscoveryCompleteness");
const {
  createHippocampusCandidateGraphBuilder
} = require("../../core/clustering/HippocampusCandidateGraphBuilder");
const {
  createHippocampusBoundedCompleteLinkRefiner
} = require("../../core/clustering/HippocampusBoundedCompleteLinkRefiner");
const {
  createTemporalClusterProvenance
} = require("../../core/clustering/HippocampusTemporalProvenance");
const {
  createTemporalSynthesisRequest
} = require("../../core/synthesis/HippocampusTemporalSynthesisRequest");
const {
  createSuperMemoryRecord,
  validateSuperMemoryRecord
} = require("../../core/consolidation/SuperMemoryRecord");
const {
  EMBEDDING_CACHE_SCHEMA_VERSION,
  EMBEDDING_CACHE_MODEL,
  EMBEDDING_CACHE_REVISION,
  createIdentity,
  createPointId
} = require("../../core/hippocampus/embedding-cache/EmbeddingCacheRecord");
const {
  createHippocampusBoundedPipelineAdapter
} = require("../../core/hippocampus/HippocampusBoundedPipelineAdapter");
const {
  BOUNDED_PILOT_ARTIFACT_BOUNDARY_VERSION,
  BOUNDED_PILOT_ARTIFACT_CAPABILITY_ID,
  createHippocampusBoundedPilotArtifactBoundary
} = require("../../core/hippocampus/HippocampusBoundedPilotArtifactBoundary");
const {
  createHippocampusDaemon
} = require("../../core/hippocampus/HippocampusDaemon");

const USER_ID = "francesco";
const LIMITS = Object.freeze({
  timeoutMs: 1000,
  maxInputChars: 100000,
  maxOutputChars: 10000,
  maxTitleChars: 100,
  maxSynthesisChars: 1000,
  maxFactItems: 20,
  maxUncertaintyItems: 20,
  maxContradictionItems: 20
});
const BUDGETS = Object.freeze({
  neighborLimit: 64,
  overfetchFactor: 1,
  scoreThreshold: 0.70,
  maxComponentVectorsInMemory: 64,
  maxPairwiseComparisons: 10000,
  maxCandidateEdges: 10000,
  maxClusterSize: null,
  timeoutMs: 10000,
  maxRssDeltaBytes: 1024 * 1024 * 1024
});
const CONSTRAINTS = Object.freeze({
  language: "it",
  preserveUncertainty: true,
  preserveContradictions: true
});

function hash(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function vectorAt(degrees) {
  const radians = degrees * Math.PI / 180;
  const vector = Array(1024).fill(0);
  vector[0] = Math.cos(radians);
  vector[1] = Math.sin(radians);
  return vector;
}

function source(memoryId, degrees, timestamp) {
  const text = `Frammento sintetico ${memoryId} sul medesimo scenario controllato.`;
  return {
    memoryId,
    text,
    contentHash: hash(text),
    timestamp,
    sourceContract: "flat",
    lastAccess: 9999999999999,
    eventTimeEvidence: null,
    type: "synthetic",
    vector: vectorAt(degrees)
  };
}

function publicSource(value) {
  const { vector: ignored, ...result } = value;
  return result;
}

function identityFor(value) {
  const identity = createIdentity({
    userId: USER_ID,
    memoryId: value.memoryId,
    contentHash: value.contentHash,
    model: EMBEDDING_CACHE_MODEL,
    revision: EMBEDDING_CACHE_REVISION
  });
  return {
    memoryId: value.memoryId,
    contentHash: value.contentHash,
    pointId: createPointId(identity),
    model: EMBEDDING_CACHE_MODEL,
    revision: EMBEDDING_CACHE_REVISION
  };
}

function cosine(left, right) {
  let value = 0;
  for (let index = 0; index < left.length; index += 1) value += left[index] * right[index];
  return value;
}

function clock() {
  let value = 1800000000000;
  return { now: () => value++ };
}

function fakePipeline(sourceValues, options = {}) {
  const byId = new Map(sourceValues.map((value) => [value.memoryId, value]));
  const identities = sourceValues.map(identityFor);
  const byPointId = new Map(identities.map((identity) => [identity.pointId, identity]));
  const counters = {
    synthesisCalls: 0,
    realStorageReads: 0,
    realStorageWrites: 0,
    destructiveCalls: 0
  };
  const sourceResolver = {
    async resolveSnapshotSources() {
      const ordered = options.reverse ? [...sourceValues].reverse() : sourceValues;
      return { userId: USER_ID, sources: ordered.map(publicSource) };
    },
    async rereadSources({ memoryIds }) {
      return memoryIds.map((memoryId, index) => {
        const value = publicSource(byId.get(memoryId));
        if (options.staleReread && index === 0) {
          const text = `${value.text} mutato`;
          return { ...value, text, contentHash: hash(text) };
        }
        return value;
      });
    }
  };
  const embeddingCoordinator = {
    async materialize({ items }) {
      return {
        total: items.length,
        hitCount: options.cacheCreated ? 0 : items.length,
        createdCount: options.cacheCreated ? items.length : 0,
        replayedCount: 0,
        identities: items.map((item) => ({
          ...identityFor(byId.get(item.memoryId)),
          status: options.cacheCreated ? "created" : "hit"
        }))
      };
    },
    async resolveEmbedding(request) {
      const value = byId.get(request.identity.memoryId);
      return {
        vector: [...value.vector],
        provenance: {
          cacheSchemaVersion: EMBEDDING_CACHE_SCHEMA_VERSION,
          identitySnapshotFingerprint: request.identitySnapshotFingerprint,
          pointId: request.identity.pointId,
          memoryId: request.identity.memoryId,
          contentHash: request.identity.contentHash,
          model: request.identity.model,
          revision: request.identity.revision,
          dimension: 1024,
          normalized: true
        }
      };
    }
  };
  const exactDiscoveryProvider = {
    create({ identitySnapshotFingerprint }) {
      return {
        async discoverNeighbors(request) {
          if (options.incompleteDiscovery) {
            return {
              discoveryCompleteness: DISCOVERY_COMPLETENESS.INCOMPLETE_TRUNCATED,
              hits: []
            };
          }
          const query = byId.get(request.queryIdentity.memoryId);
          const hits = identities.filter((identity) =>
            identity.pointId !== request.queryIdentity.pointId).map((identity) => ({
            ...identity,
            score: cosine(query.vector, byId.get(identity.memoryId).vector)
          })).filter((hit) =>
            hit.score >= DEFAULT_BOUNDED_CLUSTERING_POLICY.clusterThreshold);
          if (options.reverseHits) hits.reverse();
          return {
            discoveryCompleteness: DISCOVERY_COMPLETENESS.COMPLETE_ABOVE_THRESHOLD,
            hits,
            certificate: {
              certificateVersion: THRESHOLD_DISCOVERY_CERTIFICATE_VERSION,
              mode: THRESHOLD_DISCOVERY_MODE,
              identityIndexFingerprint: identitySnapshotFingerprint,
              queryPointId: request.queryIdentity.pointId,
              clusterThreshold: DEFAULT_BOUNDED_CLUSTERING_POLICY.clusterThreshold,
              embeddingModel: EMBEDDING_CACHE_MODEL,
              embeddingRevision: EMBEDDING_CACHE_REVISION,
              eligibleIdentityCount: identities.length - 1,
              enumeratedAboveThresholdCount: hits.length,
              exhausted: true,
              truncated: false,
              continuation: null
            }
          };
        }
      };
    }
  };
  const synthesisProvider = Object.freeze({
    schemaVersion: 1,
    providerId: "fake-qwen",
    model: "qwen3.5:27b",
    version: "fake-qwen-v1",
    async generate(request) {
      counters.synthesisCalls += 1;
      const payload = JSON.parse(request.messages[1].content.split("\n")[1]);
      const ids = payload.sources.map((item) => item.id);
      return {
        ok: true,
        status: 200,
        text: JSON.stringify({
          schema_version: 1,
          title: "Sintesi controllata",
          synthesis: "Sintesi esclusivamente sintetica.",
          facts: [{ text: "Fatto sintetico.", source_memory_ids: ids }],
          uncertainties: [],
          contradictions: [],
          source_memory_ids: ids,
          confidence: 0.9,
          rejected_source_ids: []
        })
      };
    }
  });
  const pipelineClock = clock();
  const adapter = createHippocampusBoundedPipelineAdapter({
    sourceResolver,
    embeddingCoordinator,
    exactDiscoveryProvider,
    graphBuilder: {
      create({ discoveryProvider, budgets }) {
        return createHippocampusCandidateGraphBuilder({
          discoveryProvider,
          maxNeighborQueries: identities.length,
          maxCandidateEdges: budgets.maxCandidateEdges,
          timeoutMs: budgets.timeoutMs
        });
      }
    },
    refiner: {
      create() {
        return createHippocampusBoundedCompleteLinkRefiner({
          embeddingResolver: {
            cacheSchemaVersion: EMBEDDING_CACHE_SCHEMA_VERSION,
            resolveEmbedding(request) {
              return embeddingCoordinator.resolveEmbedding({ userId: USER_ID, ...request });
            }
          },
          rssReader: { readRssBytes: () => 1000000 },
          clock: pipelineClock
        });
      }
    },
    temporalProvenance: {
      createClusterProvenance: createTemporalClusterProvenance,
      createSynthesisRequest: createTemporalSynthesisRequest
    },
    synthesisProvider,
    synthesisLimits: LIMITS,
    superMemoryValidator: {
      create: createSuperMemoryRecord,
      validate: validateSuperMemoryRecord
    },
    clock: pipelineClock
  });
  return { adapter, counters, byPointId };
}

async function run(adapter, budgets = BUDGETS) {
  return adapter.run({
    budgets,
    constraints: CONSTRAINTS,
    processingAttemptId: "bc8-synthetic-attempt",
    signal: new AbortController().signal
  });
}

function pilotContext(boundary, capability) {
  return {
    boundary,
    capability,
    boundaryVersion: BOUNDED_PILOT_ARTIFACT_BOUNDARY_VERSION,
    userId: USER_ID,
    runId: capability.runId
  };
}

function runFirst(adapter, context) {
  return adapter.runFirstFinalizable({
    budgets: BUDGETS,
    constraints: CONSTRAINTS,
    processingAttemptId: "hact9-synthetic-attempt",
    signal: new AbortController().signal
  }, context);
}

test("BC-8 composes a certified synthetic cluster, temporal gate, Qwen and temporary SuperMemory with zero commit", async () => {
  const values = [
    source("a", 0, 1000),
    source("b", 10, null),
    source("c", 20, 3000)
  ];
  const { adapter, counters } = fakePipeline(values, { cacheCreated: true });
  const result = await run(adapter);
  assert.deepEqual(result.cache, { hit: 0, created: 3, replay: 0 });
  assert.equal(result.exactCertificateCount, 3);
  assert.deepEqual(result.components, { completed: 1, deferred: 0, unclustered: 0 });
  assert.deepEqual(result.clusterSizes, [3]);
  assert.deepEqual(result.timestampQuality, ["PARTIAL_MISSING"]);
  assert.equal(result.currentStateSupported, false);
  assert.equal(result.synthesisCalls, 1);
  assert.equal(counters.synthesisCalls, 1);
  assert.equal(result.temporarySuperMemoryValid, true);
  assert.equal(result.commitCalls, 0);
  assert.equal(result.realDataModified, false);
  assert.equal(counters.realStorageReads, 0);
  assert.equal(counters.realStorageWrites, 0);
  assert.equal(counters.destructiveCalls, 0);
  assert.equal(Object.isFrozen(result), true);
  assert.doesNotMatch(JSON.stringify(result), /Frammento|vector|userId|endpoint|api.?key/i);
});

test("HACT-9 capability boundary returns only the first finalizable artifact", async () => {
  const { adapter, counters } = fakePipeline([
    source("a", 0, 1000), source("b", 5, 2000), source("c", 10, 3000)
  ]);
  const capability = Object.freeze({
    schemaVersion: 1,
    capabilityId: BOUNDED_PILOT_ARTIFACT_CAPABILITY_ID,
    userId: USER_ID,
    runId: "hact9-test-run"
  });
  const boundary = createHippocampusBoundedPilotArtifactBoundary({
    capability, userId: USER_ID, runId: capability.runId,
    now: () => 1800000000100, maxAgeMs: 1000
  });
  const result = await runFirst(adapter, pilotContext(boundary, capability));
  assert.equal(result.status, "FINALIZABLE");
  assert.equal(result.sourceCount, 3);
  assert.equal(result.commitInput.userId, USER_ID);
  assert.equal(result.commitInput.gateSnapshot.mode, "LIVE");
  assert.equal(result.idempotencyKey, result.candidateSuperMemory.idempotency_key);
  assert.equal(counters.synthesisCalls, 1);
  await assert.rejects(() => runFirst(adapter, pilotContext(boundary, capability)),
    { code: "MULTIPLE_BOUNDED_PILOT_ARTIFACTS" });
});

test("HACT-9 artifact boundary rejects missing, SHADOW-equivalent and stale capabilities", async () => {
  const { adapter } = fakePipeline([
    source("a", 0, 1000), source("b", 5, 2000), source("c", 10, 3000)
  ]);
  assert.throws(() => adapter.runFirstFinalizable({}, null),
    { code: "BOUNDED_PILOT_ARTIFACT_BOUNDARY_UNAVAILABLE" });
  const capability = Object.freeze({
    schemaVersion: 1, capabilityId: BOUNDED_PILOT_ARTIFACT_CAPABILITY_ID,
    userId: USER_ID, runId: "hact9-stale-run"
  });
  const boundary = createHippocampusBoundedPilotArtifactBoundary({
    capability, userId: USER_ID, runId: capability.runId,
    now: () => 1800000000100, maxAgeMs: 1000
  });
  await assert.rejects(() => runFirst(adapter, pilotContext(boundary, {
    ...capability, runId: capability.runId
  })), { code: "BOUNDED_PILOT_ARTIFACT_CAPABILITY_REQUIRED" });

  let captured = null;
  const captureCapability = Object.freeze({
    schemaVersion: 1, capabilityId: BOUNDED_PILOT_ARTIFACT_CAPABILITY_ID,
    userId: USER_ID, runId: "hact9-capture-run"
  });
  const accepting = createHippocampusBoundedPilotArtifactBoundary({
    capability: captureCapability, userId: USER_ID, runId: captureCapability.runId,
    now: () => 1800000000100, maxAgeMs: 1000
  });
  const captureBoundary = {
    accept(request) { captured = request.artifact; return accepting.accept(request); }
  };
  await runFirst(adapter, pilotContext(captureBoundary, captureCapability));
  const staleCapability = Object.freeze({
    schemaVersion: 1, capabilityId: BOUNDED_PILOT_ARTIFACT_CAPABILITY_ID,
    userId: USER_ID, runId: "hact9-expired-run"
  });
  const staleBoundary = createHippocampusBoundedPilotArtifactBoundary({
    capability: staleCapability, userId: USER_ID, runId: staleCapability.runId,
    now: () => captured.createdAt + 100, maxAgeMs: 1
  });
  assert.throws(() => staleBoundary.accept({
    capability: staleCapability, userId: USER_ID,
    runId: staleCapability.runId,
    signal: new AbortController().signal,
    artifact: captured
  }), { code: "STALE_BOUNDED_PILOT_ARTIFACT" });

  assert.throws(() => createHippocampusBoundedPilotArtifactBoundary({
    capability: { ...staleCapability, userId: "other" },
    userId: "other", runId: staleCapability.runId,
    now: Date.now, maxAgeMs: 1000
  }), { code: "INVALID_BOUNDED_PILOT_ARTIFACT_BOUNDARY" });
});

test("BC-8 complete-link excludes the A-B-C chain and never invokes synthesis", async () => {
  const { adapter, counters } = fakePipeline([
    source("a", 0, 1000),
    source("b", 40, 2000),
    source("c", 80, 3000)
  ]);
  const result = await run(adapter);
  assert.equal(result.clusterCount, 0);
  assert.equal(result.synthesisCalls, 0);
  assert.equal(counters.synthesisCalls, 0);
  assert.equal(result.components.unclustered > 0, true);
});

test("BC-8 fail-closes stale authoritative reread before Qwen", async () => {
  const { adapter, counters } = fakePipeline([
    source("a", 0, 1000), source("b", 5, 2000), source("c", 10, 3000)
  ], { staleReread: true });
  const result = await run(adapter);
  assert.equal(result.status, "PARTIAL_DEFERRED");
  assert.equal(result.components.completed, 0);
  assert.equal(result.components.deferred, 1);
  assert.equal(result.synthesisCalls, 0);
  assert.equal(counters.synthesisCalls, 0);
  assert.equal(result.temporarySuperMemoryValid, false);
});

test("BC-8 defers incomplete/cap+1 discovery and dense components", async () => {
  const values = [
    source("a", 0, 1000), source("b", 5, 2000), source("c", 10, 3000)
  ];
  const incomplete = await run(fakePipeline(values, { incompleteDiscovery: true }).adapter);
  assert.equal(incomplete.clusterCount, 0);
  assert.equal(incomplete.components.deferred > 0, true);
  assert.equal(incomplete.synthesisCalls, 0);
  const dense = await run(fakePipeline(values).adapter, {
    ...BUDGETS, maxComponentVectorsInMemory: 2
  });
  assert.equal(dense.clusterCount, 0);
  assert.equal(dense.components.deferred, 1);
  assert.equal(dense.synthesisCalls, 0);
});

test("BC-8 output is deterministic for direct/inverse input and provider hit order", async () => {
  const values = [
    source("a", 0, 1000), source("b", 5, null), source("c", 10, 3000)
  ];
  const direct = await run(fakePipeline(values).adapter);
  const inverse = await run(fakePipeline(values, { reverse: true, reverseHits: true }).adapter);
  assert.deepEqual(direct, inverse);
});

test("BC-8 has no implicit limit of five", async () => {
  const values = Array.from({ length: 6 }, (_, index) =>
    source(`source-${index}`, index, 1000 + index));
  const result = await run(fakePipeline(values).adapter);
  assert.deepEqual(result.clusterSizes, [6]);
  assert.equal(result.exactCertificateCount, 6);
  assert.equal(result.synthesisCalls, 1);
});

test("daemon bounded path is disabled by default and only runs an explicitly injected adapter", async () => {
  const storage = { loadMemories: async () => [] };
  const disabled = createHippocampusDaemon({ storage, userId: USER_ID });
  await assert.rejects(disabled.runBoundedSynthetic({}), {
    code: "BOUNDED_PIPELINE_DISABLED"
  });
  let calls = 0;
  const enabled = createHippocampusDaemon({
    storage,
    userId: USER_ID,
    boundedPipelineAdapter: {
      async run(input) {
        calls += 1;
        return input;
      }
    }
  });
  const marker = { synthetic: true };
  assert.equal(await enabled.runBoundedSynthetic(marker), marker);
  assert.equal(calls, 1);
  assert.equal(enabled.getStatus().scheduled, false);
});
