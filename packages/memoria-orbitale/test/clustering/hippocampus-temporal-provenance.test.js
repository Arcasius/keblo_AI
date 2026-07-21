"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  BOUNDED_CLUSTERING_REASON_CODES,
  DEFAULT_BOUNDED_CLUSTERING_POLICY,
  DISCOVERY_COMPLETENESS,
  GLOBAL_BARRIER_STATUSES,
  TIMESTAMP_QUALITY,
  createBoundedClusteringPlan,
  createGlobalIdentitySnapshot
} = require("../../core/clustering/HippocampusBoundedClusteringPlan");
const {
  EVENT_TIME_AUTHORITY,
  EVENT_TIME_EVIDENCE_CONTRACT_VERSION,
  EVENT_TIME_STATUSES,
  RECORDED_AT_STATUSES,
  TEMPORAL_POLICY_VERSION,
  createTemporalClusterProvenance,
  validateTemporalClusterProvenance
} = require("../../core/clustering/HippocampusTemporalProvenance");
const {
  createTemporalSynthesisRequest,
  validateTemporalSynthesisRequest
} = require("../../core/synthesis/HippocampusTemporalSynthesisRequest");

const MODEL = "bc5-synthetic-model";
const REVISION = "bc5-synthetic-revision";

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
    memoryId: `bc5-memory-${String(index).padStart(2, "0")}`,
    contentHash: hash(`bc5-content-${index}`),
    pointId: pointId(index),
    model: MODEL,
    revision: REVISION
  };
}

function snapshot(count = 3, reverse = false) {
  const identities = Array.from({ length: count }, (_, index) => identity(index));
  return createGlobalIdentitySnapshot({
    userIdHash: hash("bc5-private-synthetic-user"),
    identities: reverse ? identities.reverse() : identities
  });
}

function budgets() {
  return {
    neighborLimit: 64,
    overfetchFactor: 4,
    scoreThreshold: 0.65,
    maxComponentVectorsInMemory: 16,
    maxPairwiseComparisons: 100,
    maxCandidateEdges: 100,
    maxClusterSize: 16,
    timeoutMs: 1000,
    maxRssDeltaBytes: 1000000
  };
}

function reasonCounts() {
  return Object.fromEntries(Object.values(BOUNDED_CLUSTERING_REASON_CODES)
    .map((reason) => [reason, 0]));
}

function verifiedPlan(current) {
  const memberIds = current.identities.map((item) => item.memoryId);
  return createBoundedClusteringPlan({
    identitySnapshot: current,
    policy: DEFAULT_BOUNDED_CLUSTERING_POLICY,
    budgets: budgets(),
    provenance: {
      cacheSchemaVersion: 1,
      embeddingModel: MODEL,
      embeddingRevision: REVISION,
      globalBarrierStatus: GLOBAL_BARRIER_STATUSES.COMPLETE
    },
    clusters: [{
      memberIds,
      minimumPairSimilarity: 0.8,
      discoveryCompleteness: DISCOVERY_COMPLETENESS.COMPLETE_ABOVE_THRESHOLD,
      temporal: {
        orderedSourceIds: [],
        unresolvedSourceIds: [...memberIds].sort(),
        temporalStart: null,
        temporalEnd: null,
        timestampQuality: TIMESTAMP_QUALITY.NOT_EVALUATED
      }
    }],
    deferredComponents: [],
    unclusteredComponents: [],
    metrics: {
      identityCount: current.identityCount,
      finalizedIdentityCount: current.identityCount,
      deferredIdentityCount: 0,
      unclusteredIdentityCount: 0,
      neighborQueryCount: current.identityCount,
      candidateEdgeCount: current.identityCount - 1,
      canonicalEdgeCount: current.identityCount - 1,
      componentCount: 1,
      completedComponentCount: 1,
      deferredComponentCount: 0,
      unclusteredComponentCount: 0,
      pairwiseComparisonCount: 6,
      maximumComponentSize: current.identityCount,
      maximumVectorsInMemory: current.identityCount,
      elapsedMs: 0,
      rssStartBytes: 1000,
      rssPeakBytes: 1000,
      rssDeltaBytes: 0,
      reasonCounts: reasonCounts()
    }
  });
}

function source(item, timestamp, overrides = {}) {
  return {
    memoryId: item.memoryId,
    contentHash: item.contentHash,
    sourceContract: "flat",
    timestamp,
    lastAccess: 9999999999999,
    eventTimeEvidence: null,
    ...overrides
  };
}

function provenance(current, timestamps, sourceOverrides = []) {
  const plan = verifiedPlan(current);
  return createTemporalClusterProvenance({
    identitySnapshot: current,
    boundedClusteringPlan: plan,
    clusterId: plan.clusters[0].clusterId,
    sources: current.identities.map((item, index) =>
      source(item, timestamps[index], sourceOverrides[index]))
  });
}

test("all valid flat timestamps produce COMPLETE recordedAt provenance", () => {
  const current = snapshot();
  const result = provenance(current, [3000, 1000, 2000]);
  assert.equal(result.temporalPolicyVersion, TEMPORAL_POLICY_VERSION);
  assert.equal(result.timestampQuality, TIMESTAMP_QUALITY.COMPLETE);
  assert.equal(result.temporalStart, 1000);
  assert.equal(result.temporalEnd, 3000);
  assert.deepEqual(result.chronologicalSourceIds, [
    current.identities[1].memoryId,
    current.identities[2].memoryId,
    current.identities[0].memoryId
  ]);
  assert.deepEqual(validateTemporalClusterProvenance(result), { valid: true, errors: [] });
});

test("chronological ordering uses memoryId as the canonical tie-break", () => {
  const current = snapshot();
  const result = provenance(current, [1000, 1000, 500]);
  assert.deepEqual(result.chronologicalSourceIds, [
    current.identities[2].memoryId,
    current.identities[0].memoryId,
    current.identities[1].memoryId
  ]);
});

test("a missing timestamp is separated and yields PARTIAL_MISSING", () => {
  const current = snapshot();
  const result = provenance(current, [1000, null, 3000]);
  assert.equal(result.timestampQuality, TIMESTAMP_QUALITY.PARTIAL_MISSING);
  assert.deepEqual(result.undatedSourceIds, [current.identities[1].memoryId]);
  assert.equal(result.sourceTimeDescriptors[1].recordedAtStatus,
    RECORDED_AT_STATUSES.MISSING);
});

test("an invalid flat timestamp is not parsed and yields PARTIAL_INVALID", () => {
  const current = snapshot();
  const result = provenance(current, [1000, "2000", 3000]);
  assert.equal(result.timestampQuality, TIMESTAMP_QUALITY.PARTIAL_INVALID);
  assert.deepEqual(result.undatedSourceIds, [current.identities[1].memoryId]);
  assert.equal(result.sourceTimeDescriptors[1].recordedAtStatus,
    RECORDED_AT_STATUSES.INVALID);
});

test("mixed valid, missing and invalid sources prefer PARTIAL_INVALID", () => {
  const current = snapshot();
  const result = provenance(current, [1000, null, "invalid"]);
  assert.equal(result.timestampQuality, TIMESTAMP_QUALITY.PARTIAL_INVALID);
  assert.deepEqual(result.undatedSourceIds,
    [current.identities[1].memoryId, current.identities[2].memoryId]);
});

test("no usable recordedAt produces UNKNOWN with a null range", () => {
  const current = snapshot();
  const result = provenance(current, [null, null, null]);
  assert.equal(result.timestampQuality, TIMESTAMP_QUALITY.UNKNOWN);
  assert.equal(result.temporalStart, null);
  assert.equal(result.temporalEnd, null);
  assert.deepEqual(result.chronologicalSourceIds, []);
  assert.deepEqual(result.undatedSourceIds, result.sourceIds);
});

test("nested and hybrid timestamps receive no invented precedence", () => {
  const current = snapshot();
  const result = provenance(current, [1000, 2000, 3000], [
    { sourceContract: "nested" }, { sourceContract: "hybrid" }, {}
  ]);
  assert.equal(result.timestampQuality, TIMESTAMP_QUALITY.PARTIAL_MISSING);
  assert.deepEqual(result.undatedSourceIds,
    [current.identities[0].memoryId, current.identities[1].memoryId]);
  assert.equal(result.sourceTimeDescriptors[0].recordedAtStatus,
    RECORDED_AT_STATUSES.UNSUPPORTED_SOURCE_CONTRACT);
});

test("lastAccess is ignored and cannot change chronology or identity", () => {
  const current = snapshot();
  const plan = verifiedPlan(current);
  const base = current.identities.map((item, index) => source(item, index * 1000, {
    lastAccess: 999999 - index
  }));
  const inverseAccess = base.map((item, index) => ({ ...item, lastAccess: index }));
  const input = (sources) => ({
    identitySnapshot: current, boundedClusteringPlan: plan,
    clusterId: plan.clusters[0].clusterId, sources
  });
  assert.deepEqual(createTemporalClusterProvenance(input(base)),
    createTemporalClusterProvenance(input(inverseAccess)));
});

test("recordedAt is never copied into eventTime", () => {
  const result = provenance(snapshot(), [1000, 2000, 3000]);
  for (const descriptor of result.sourceTimeDescriptors) {
    assert.equal(descriptor.eventTime, null);
    assert.equal(descriptor.eventTimeStatus, EVENT_TIME_STATUSES.UNKNOWN);
  }
});

test("only explicit structured evidence can provide eventTime", () => {
  const current = snapshot();
  const evidence = {
    evidenceContractVersion: EVENT_TIME_EVIDENCE_CONTRACT_VERSION,
    authority: EVENT_TIME_AUTHORITY,
    eventTime: -2208988800000
  };
  const result = provenance(current, [1000, 2000, 3000], [
    { eventTimeEvidence: evidence }, {}, {}
  ]);
  assert.equal(result.sourceTimeDescriptors[0].eventTime, evidence.eventTime);
  assert.equal(result.sourceTimeDescriptors[0].eventTimeStatus,
    EVENT_TIME_STATUSES.AVAILABLE_EXPLICIT_STRUCTURED);
});

test("an event mentioned in text cannot be analyzed because narrative fields are rejected", () => {
  const current = snapshot();
  const plan = verifiedPlan(current);
  const sources = current.identities.map((item, index) => source(item, index));
  sources[0].content = "Tomorrow the event happened";
  assert.throws(() => createTemporalClusterProvenance({
    identitySnapshot: current, boundedClusteringPlan: plan,
    clusterId: plan.clusters[0].clusterId, sources
  }), { code: "INVALID_SOURCE_TIME_INPUT" });
});

test("stale contentHash fails closed", () => {
  const current = snapshot();
  const plan = verifiedPlan(current);
  const sources = current.identities.map((item, index) => source(item, index));
  sources[1].contentHash = hash("stale");
  assert.throws(() => createTemporalClusterProvenance({
    identitySnapshot: current, boundedClusteringPlan: plan,
    clusterId: plan.clusters[0].clusterId, sources
  }), { code: "STALE_TEMPORAL_SOURCE" });
});

test("BC-4 membership remains unchanged with complete disjoint temporal coverage", () => {
  const current = snapshot();
  const plan = verifiedPlan(current);
  const result = provenance(current, [1000, null, 3000]);
  assert.deepEqual(result.sourceIds, plan.clusters[0].memberIds);
  const disposition = [...result.chronologicalSourceIds, ...result.undatedSourceIds];
  assert.equal(new Set(disposition).size, result.sourceIds.length);
  assert.deepEqual([...disposition].sort(), result.sourceIds);
  assert.equal(result.clusterId, plan.clusters[0].clusterId);
});

test("direct and inverse source input produce identical immutable output", () => {
  const current = snapshot(3, true);
  const plan = verifiedPlan(current);
  const sources = current.identities.map((item, index) => source(item, [3000, 1000, 2000][index]));
  const input = (items) => ({ identitySnapshot: current, boundedClusteringPlan: plan,
    clusterId: plan.clusters[0].clusterId, sources: items });
  const direct = createTemporalClusterProvenance(input(sources));
  const inverse = createTemporalClusterProvenance(input([...sources].reverse()));
  assert.deepEqual(direct, inverse);
  assert.equal(Object.isFrozen(direct.sourceTimeDescriptors[0]), true);
});

test("the most recent recordedAt never enables currentStateSupported", () => {
  const request = createTemporalSynthesisRequest({
    temporalProvenance: provenance(snapshot(), [1, 2, 9999999999999])
  });
  assert.equal(request.currentStateEvidence.currentStateSupported, false);
  assert.equal(request.currentStateEvidence.evidenceStatus, "NOT_PROVIDED");
  assert.equal(request.interpretationPolicy.mostRecentDoesNotImplyCurrent, true);
  assert.equal(request.interpretationPolicy.recordedAtIsEventTime, false);
});

test("temporal synthesis request has exactly chronological and undated sections", () => {
  const temporalProvenance = provenance(snapshot(), [1000, null, 3000]);
  const request = createTemporalSynthesisRequest({ temporalProvenance });
  assert.deepEqual(request.sections.map((section) => section.sectionType), [
    "RECORDED_AT_CHRONOLOGY", "UNDATED_SOURCES"
  ]);
  assert.equal(request.sections[0].sourceReferences.length, 2);
  assert.equal(request.sections[1].sourceReferences.length, 1);
  assert.equal(request.authoritativeRereadRequirement.required, true);
  assert.equal(request.authoritativeRereadRequirement.requireContentHashMatch, true);
  assert.deepEqual(validateTemporalSynthesisRequest(request, temporalProvenance),
    { valid: true, errors: [] });
});

test("synthesis policy preserves changes, contradictions and supersessions", () => {
  const request = createTemporalSynthesisRequest({
    temporalProvenance: provenance(snapshot(), [1000, 2000, 3000])
  });
  assert.equal(request.interpretationPolicy.preserveChanges, true);
  assert.equal(request.interpretationPolicy.preserveContradictions, true);
  assert.equal(request.interpretationPolicy.preserveSupersessions, true);
  assert.equal(request.execution.providerInvocationAuthorized, false);
});

test("outputs are closed, vectorless and contain no text or sensitive runtime data", () => {
  const temporalProvenance = provenance(snapshot(), [1000, null, 3000]);
  const request = createTemporalSynthesisRequest({ temporalProvenance });
  for (const output of [temporalProvenance, request]) {
    const serialized = JSON.stringify(output);
    assert.doesNotMatch(serialized,
      /private-synthetic-user|Tomorrow the event|vector|centroid|payload|userId|endpoint|apiKey|secret/iu);
    assert.equal(Object.isFrozen(output), true);
  }
});

test("BC-5 modules import only pure contracts and no runtime integrations", () => {
  const temporalSource = fs.readFileSync(path.join(__dirname,
    "../../core/clustering/HippocampusTemporalProvenance.js"), "utf8");
  const synthesisSource = fs.readFileSync(path.join(__dirname,
    "../../core/synthesis/HippocampusTemporalSynthesisRequest.js"), "utf8");
  assert.deepEqual([...temporalSource.matchAll(/require\(([^)]+)\)/gu)]
    .map((match) => match[1]), ['"./HippocampusBoundedClusteringPlan"']);
  assert.deepEqual([...synthesisSource.matchAll(/require\(([^)]+)\)/gu)]
    .map((match) => match[1]), [
      '"node:crypto"', '"../clustering/HippocampusTemporalProvenance"'
    ]);
  assert.doesNotMatch(`${temporalSource}\n${synthesisSource}`,
    /JsonMemoryStorage|CandidateSelector|ConsolidationPlan|ClusterEngineAdapter|HippocampusDaemon|RecallRouter|Qdrant|BgeM3|Qwen|SuperMemory|process\.env|\bfetch\s*\(/u);
});
