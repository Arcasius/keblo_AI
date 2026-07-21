"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { createHash } = require("node:crypto");

const { fingerprintEmbedding } = require("../../core/clustering/ClusterMath");
const { createClusterRecord } = require("../../core/clustering/ClusterRecord");
const {
  buildSynthesisRequest,
  buildSynthesisResult
} = require("../../core/synthesis/SynthesisContract");
const { DEFAULT_SYNTHESIS_LIMITS } = require("../../core/synthesis/SynthesisEngine");
const {
  createProcessingState,
  createProcessingTransitionPlan,
  validateProcessingState
} = require("../../core/consolidation/ProcessingState");
const {
  createSuperMemoryRecord,
  validateSuperMemoryRecord
} = require("../../core/consolidation/SuperMemoryRecord");
const {
  createConsolidationCommitPlan,
  commitConsolidation
} = require("../../core/consolidation/ConsolidationTransaction");
const {
  COMMIT_CONFIRMATION,
  RECEIPT_KEYS,
  createHippocampusBoundedCommitBridge
} = require("../../core/hippocampus/HippocampusBoundedCommitBridge");

const USER = "hact7-fake-user";
const IDS = ["source-a", "source-b", "source-c"];
const ATTEMPT = "hact7-fake-attempt";
const STARTED_AT = 1800000000000;
const COMMITTED_AT = STARTED_AT + 1000;
const IDENTITY_FINGERPRINT = "f".repeat(64);
const SHADOW_GATE = Object.freeze({ mode: "SHADOW", liveAuthorized: false, commitAuthorized: false });
const LIVE_GATE = Object.freeze({ mode: "LIVE", liveAuthorized: true, commitAuthorized: true });

function hash(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function clusterRecord() {
  const centroid = [1, 0.5];
  return createClusterRecord({
    userId: USER,
    planId: "a".repeat(64),
    createdAt: STARTED_AT - 1000,
    embedding: { providerId: "fake-cache", model: "bge-m3", version: "bge-m3-v1" },
    clusterCandidate: {
      schemaVersion: 1,
      algorithmVersion: "complete-link-greedy-v1",
      clusterId: "b".repeat(64),
      memberIds: IDS,
      embeddingDimension: 2,
      centroid,
      centroidFingerprint: fingerprintEmbedding(centroid),
      density: {
        averageSimilarity: 0.9,
        minimumSimilarity: 0.8,
        maximumSimilarity: 1,
        memberCount: IDS.length
      },
      policy: { similarityThreshold: 0.7, minClusterSize: 3, maxClusterSize: null },
      reasonCodes: ["CLUSTERED"],
      persisted: false
    }
  });
}

function textFor(id) {
  return `HACT7 private fake source ${id}`;
}

function synthesisResult(cluster) {
  const request = buildSynthesisRequest({
    clusterRecord: cluster,
    sources: IDS.map((id, index) => ({
      id,
      text: textFor(id),
      timestamp: STARTED_AT - index,
      type: "fake",
      content_hash: hash(textFor(id))
    })),
    provider: { providerId: "fake-synthesis", model: "fake-model", version: "v1" },
    constraints: {
      language: "it",
      preserveUncertainty: true,
      preserveContradictions: true
    },
    limits: { ...DEFAULT_SYNTHESIS_LIMITS }
  });
  return buildSynthesisResult(request, {
    schema_version: 1,
    title: "HACT7 private fake title",
    synthesis: "HACT7 private validated synthesis",
    facts: [{ text: "HACT7 private fact", source_memory_ids: [IDS[0]] }],
    uncertainties: [],
    contradictions: [],
    source_memory_ids: IDS.slice(0, 2),
    confidence: 0.9,
    rejected_source_ids: [IDS[2]]
  }, request.provider);
}

function temporalProvenance(cluster, result, reverse = false) {
  const descriptors = result.sourceContentHashes.map((entry, index) => ({
    memoryId: entry.id,
    contentHash: entry.content_hash,
    recordedAt: STARTED_AT - (IDS.length - index),
    recordedAtStatus: "VALID",
    eventTime: null,
    eventTimeStatus: "UNKNOWN"
  }));
  return {
    schemaVersion: 1,
    temporalPolicyVersion: 1,
    clusterId: cluster.candidate_cluster_id,
    sourceIds: [...IDS],
    chronologicalSourceIds: [...IDS],
    undatedSourceIds: [],
    temporalStart: STARTED_AT - 3,
    temporalEnd: STARTED_AT - 1,
    timestampQuality: "COMPLETE",
    sourceTimeDescriptors: reverse ? descriptors.reverse() : descriptors
  };
}

function sourceMemory(id, overrides = {}) {
  return {
    id,
    type: "fake",
    content: { text: textFor(id), preserved: true },
    timestamp: STARTED_AT - 100,
    meta: { user_id: USER, preserved: true },
    processing: createProcessingState({
      state: "synthesizing",
      revision: 3,
      attempt_id: ATTEMPT,
      updated_at: STARTED_AT,
      error: null
    }),
    preservedUnknownField: { value: id },
    ...overrides
  };
}

function transition(memory, used) {
  return createProcessingTransitionPlan({
    memoryId: memory.id,
    current: memory.processing,
    toState: used ? "consolidated" : "failed",
    updatedAt: COMMITTED_AT,
    ...(used ? {} : {
      error: {
        code: "SYNTHESIS_SOURCE_REJECTED",
        message: "Source rejected by validated synthesis output",
        retryable: true
      }
    }),
    reason: used ? "Validated synthesis used source" : "Validated synthesis rejected source"
  });
}

function fakeStorage(memories) {
  let state = deepClone(memories);
  let lock = false;
  const counters = { reads: 0, writes: 0, deletes: 0 };
  const supported = Object.freeze({ status: "supported", verified: true });
  return {
    capabilities: {
      schemaVersion: 1,
      statuses: {
        "memory.readAll": supported,
        "memory.writeAll": supported,
        "commit.atomic": supported,
        "lock.acquire": supported,
        "lock.release": supported
      }
    },
    counters,
    failWrite: false,
    async loadMemories(userId, options) {
      counters.reads += 1;
      assert.equal(userId, USER);
      if (options?.signal?.aborted) throw Object.assign(new Error("private abort"), { code: "RUN_ABORTED" });
      return deepClone(state);
    },
    async saveMemories(userId, next) {
      assert.equal(userId, USER);
      if (this.failWrite) throw new Error("private atomic write failure");
      state = deepClone(next);
      counters.writes += 1;
    },
    async acquireLock(userId) {
      assert.equal(userId, USER);
      assert.equal(lock, false);
      lock = true;
      return Object.freeze({ fake: true });
    },
    async releaseLock() { lock = false; },
    async saveMemory() {},
    async deleteMemory() { counters.deletes += 1; },
    async saveLink() {},
    async saveLinks() {},
    async saveCluster() {},
    async deleteCluster() {},
    snapshot() { return deepClone(state); }
  };
}

function fixture(options = {}) {
  const cluster = clusterRecord();
  const synthesis = synthesisResult(cluster);
  const sources = IDS.map((id) => sourceMemory(id));
  const storage = fakeStorage(sources);
  const logs = [];
  const coordinatorCounters = { createPlan: 0, commit: 0, journalBefore: 0, journalAfter: 0 };
  const coordinator = {
    schemaVersion: 1,
    transactionContractVersion: "transactional-consolidation-commit-v1",
    journalRecoveryContractVersion: "hippocampus-recovery-v1",
    createPlan(input) {
      coordinatorCounters.createPlan += 1;
      return createConsolidationCommitPlan(input);
    },
    async commit({ storage: target, plan, signal }) {
      coordinatorCounters.commit += 1;
      coordinatorCounters.journalBefore += 1;
      assert.equal(signal, options.signal || signal);
      const report = await commitConsolidation({ storage: target, plan });
      coordinatorCounters.journalAfter += 1;
      return report;
    }
  };
  const capabilityCounters = { calls: 0, signals: [] };
  const capability = options.capability === false ? undefined : {
    schemaVersion: 1,
    capabilityId: "hippocampus-authoritative-commit-v1",
    async commit(request) {
      capabilityCounters.calls += 1;
      capabilityCounters.signals.push(request.signal);
      if (options.capabilityCommit) return options.capabilityCommit(request);
      return request.commitCoordinator.commit({
        storage: request.authoritativeStorage,
        plan: request.transactionPlan,
        signal: request.signal
      });
    }
  };
  const used = new Set(synthesis.output.source_memory_ids);
  const sourceById = new Map(sources.map((memory) => [memory.id, memory]));
  const bridge = createHippocampusBoundedCommitBridge({
    authoritativeStorage: storage,
    commitCoordinator: coordinator,
    superMemoryRecordFactory: {
      create: createSuperMemoryRecord,
      validate: validateSuperMemoryRecord
    },
    processingStateContract: {
      createPreparedTransitions({ synthesisResult: value }) {
        return value.sourceContentHashes.map(({ id }) =>
          transition(sourceById.get(id), used.has(id)));
      },
      validateState: validateProcessingState
    },
    commitCapability: capability,
    logger: { info(entry) { logs.push(deepClone(entry)); } }
  });
  const controller = new AbortController();
  const input = (gateSnapshot = SHADOW_GATE, reverse = false) => ({
    userId: USER,
    gateSnapshot,
    identityIndexFingerprint: IDENTITY_FINGERPRINT,
    cluster,
    temporalProvenance: temporalProvenance(cluster, synthesis, reverse),
    synthesisResult: synthesis,
    signal: controller.signal
  });
  return {
    bridge, storage, logs, coordinatorCounters, capabilityCounters,
    controller, cluster, synthesis, sources, input
  };
}

function prepareLive(state) {
  const result = state.bridge.prepare(state.input(LIVE_GATE));
  assert.equal(result.receipt.status, "PREPARED");
  return result.preparedCommit;
}

async function commitPrepared(state, prepared, signal = state.controller.signal) {
  return state.bridge.commit({
    preparedCommit: prepared,
    confirmation: COMMIT_CONFIRMATION,
    signal
  });
}

test("SHADOW prepare is valid, deeply immutable, vectorless and commit is denied with zero write", async () => {
  const state = fixture();
  const prepared = state.bridge.prepare(state.input());
  assert.equal(prepared.receipt.status, "PREPARED");
  assert.equal(prepared.receipt.reasonCode, "COMMIT_NOT_AUTHORIZED_IN_SHADOW");
  assert.equal(Object.isFrozen(prepared.preparedCommit.transactionPlan.superMemory.content), true);
  assert.doesNotMatch(JSON.stringify(prepared.preparedCommit.expectedAuthoritativeSnapshot), /centroid|vector|qdrant|endpoint|batch/i);
  const denied = await commitPrepared(state, prepared.preparedCommit);
  assert.equal(denied.receipt.reasonCode, "COMMIT_NOT_AUTHORIZED_IN_SHADOW");
  assert.equal(state.storage.counters.reads, 0);
  assert.equal(state.storage.counters.writes, 0);
  assert.equal(state.capabilityCounters.calls, 0);
});

test("LIVE requires the server-side capability and exact orchestrator confirmation", async () => {
  const noCapability = fixture({ capability: false });
  const prepared = prepareLive(noCapability);
  const missing = await commitPrepared(noCapability, prepared);
  assert.equal(missing.receipt.reasonCode, "COMMIT_CAPABILITY_REQUIRED");
  assert.equal(noCapability.storage.counters.writes, 0);
  const state = fixture();
  const wrong = await state.bridge.commit({
    preparedCommit: prepareLive(state), confirmation: "wrong", signal: state.controller.signal
  });
  assert.equal(wrong.receipt.reasonCode, "LIVE_GATE_NOT_AUTHORIZED");
  assert.equal(state.storage.counters.writes, 0);
});

test("prepared identity is deterministic across inverse descriptor order and unrelated batch labels", () => {
  const first = fixture();
  const direct = first.bridge.prepare(first.input(LIVE_GATE)).preparedCommit;
  const inverse = first.bridge.prepare(first.input(LIVE_GATE, true)).preparedCommit;
  const anotherBatch = fixture();
  const batched = anotherBatch.bridge.prepare(anotherBatch.input(LIVE_GATE)).preparedCommit;
  assert.equal(direct.idempotencyKey, inverse.idempotencyKey);
  assert.equal(direct.superMemory.id, inverse.superMemory.id);
  assert.equal(direct.idempotencyKey, batched.idempotencyKey);
  assert.equal(direct.superMemory.id, batched.superMemory.id);
  assert.equal(direct.preparedFingerprint, inverse.preparedFingerprint);
});

test("missing, modified or cross-user authoritative source is stale and causes zero write", async () => {
  for (const mutate of [
    (values) => values.filter((memory) => memory.id !== IDS[0]),
    (values) => values.map((memory) => memory.id === IDS[0]
      ? { ...memory, content: { ...memory.content, text: `${memory.content.text} changed` } }
      : memory),
    (values) => values.map((memory) => memory.id === IDS[0]
      ? { ...memory, meta: { ...memory.meta, user_id: "other-user" } }
      : memory)
  ]) {
    const state = fixture();
    const prepared = prepareLive(state);
    const changed = mutate(state.storage.snapshot());
    await state.storage.saveMemories(USER, changed);
    state.storage.counters.writes = 0;
    const result = await commitPrepared(state, prepared);
    assert.equal(result.receipt.reasonCode, "STALE_SOURCE_REJECTED");
    assert.equal(state.storage.counters.writes, 0);
    assert.equal(state.capabilityCounters.calls, 0);
  }
});

test("processing-state mismatch and incompatible synthesis provenance fail closed", async () => {
  const state = fixture();
  const prepared = prepareLive(state);
  const values = state.storage.snapshot();
  values[0].processing = createProcessingState({
    state: "candidate", revision: 3, attempt_id: null, updated_at: STARTED_AT, error: null
  });
  await state.storage.saveMemories(USER, values);
  state.storage.counters.writes = 0;
  const conflict = await commitPrepared(state, prepared);
  assert.equal(conflict.receipt.reasonCode, "SOURCE_PROCESSING_STATE_CONFLICT");
  assert.equal(state.storage.counters.writes, 0);
  const invalid = fixture();
  const input = invalid.input(LIVE_GATE);
  input.synthesisResult = deepClone(input.synthesisResult);
  input.synthesisResult.promptVersion = "incompatible";
  const rejected = invalid.bridge.prepare(input);
  assert.equal(rejected.receipt.reasonCode, "INVALID_PREPARED_COMMIT");
});

test("HACT-7 without the explicit legacy boundary rejects absent processing", async () => {
  const state = fixture();
  const prepared = prepareLive(state);
  const values = state.storage.snapshot();
  delete values[0].processing;
  await state.storage.saveMemories(USER, values);
  state.storage.counters.writes = 0;
  const result = await commitPrepared(state, prepared);
  assert.equal(result.receipt.reasonCode, "SOURCE_PROCESSING_STATE_CONFLICT");
  assert.equal(state.storage.counters.writes, 0);
});

test("validated SuperMemory and all source transitions use one atomic existing transaction", async () => {
  const state = fixture();
  const original = state.storage.snapshot();
  const prepared = prepareLive(state);
  assert.deepEqual(validateSuperMemoryRecord(prepared.superMemory), prepared.superMemory);
  const result = await commitPrepared(state, prepared);
  assert.equal(result.receipt.status, "COMMITTED");
  assert.equal(result.receipt.authoritativeWriteCount, 1);
  assert.equal(result.receipt.commitCalls, 1);
  assert.equal(state.storage.counters.writes, 1);
  assert.equal(state.coordinatorCounters.commit, 1);
  const after = state.storage.snapshot();
  assert.equal(after.length, original.length + 1);
  for (const before of original) {
    const persisted = after.find((memory) => memory.id === before.id);
    assert.equal(persisted.content.text, before.content.text);
    assert.deepEqual(persisted.preservedUnknownField, before.preservedUnknownField);
  }
  assert.equal(state.storage.counters.deletes, 0);
});

test("transaction failure exposes no partial state and post-commit verification is mandatory", async () => {
  const atomic = fixture();
  const before = atomic.storage.snapshot();
  atomic.storage.failWrite = true;
  const failed = await commitPrepared(atomic, prepareLive(atomic));
  assert.equal(failed.receipt.reasonCode, "TRANSACTION_COMMIT_FAILED");
  assert.deepEqual(atomic.storage.snapshot(), before);
  assert.equal(failed.receipt.authoritativeWriteCount, 0);

  const lying = fixture({
    async capabilityCommit() { return { committed: true, idempotentReplay: false }; }
  });
  const unverified = await commitPrepared(lying, prepareLive(lying));
  assert.equal(unverified.receipt.reasonCode, "POST_COMMIT_VERIFICATION_FAILED");
  assert.equal(lying.storage.counters.writes, 0);
});

test("identical replay creates no duplicate while same ID with different semantics never overwrites", async () => {
  const replay = fixture();
  const prepared = prepareLive(replay);
  assert.equal((await commitPrepared(replay, prepared)).receipt.status, "COMMITTED");
  const writes = replay.storage.counters.writes;
  const count = replay.storage.snapshot().length;
  const second = await commitPrepared(replay, prepared);
  assert.equal(second.receipt.status, "IDEMPOTENT_REPLAY");
  assert.equal(second.receipt.reasonCode, "IDEMPOTENT_COMMIT_REPLAY");
  assert.equal(replay.storage.counters.writes, writes);
  assert.equal(replay.storage.snapshot().length, count);

  const conflict = fixture();
  const conflictingPrepared = prepareLive(conflict);
  const values = conflict.storage.snapshot();
  values.push({ ...deepClone(conflictingPrepared.superMemory), content: {
    ...deepClone(conflictingPrepared.superMemory.content), text: "different private semantics"
  }});
  await conflict.storage.saveMemories(USER, values);
  conflict.storage.counters.writes = 0;
  const rejected = await commitPrepared(conflict, conflictingPrepared);
  assert.equal(rejected.receipt.reasonCode, "SUPERMEMORY_CONFLICT");
  assert.equal(conflict.storage.counters.writes, 0);
});

test("existing coordinator journal/recovery boundary is reused and AbortSignal is propagated", async () => {
  const state = fixture();
  const prepared = prepareLive(state);
  await commitPrepared(state, prepared);
  assert.equal(state.coordinatorCounters.journalBefore, 1);
  assert.equal(state.coordinatorCounters.journalAfter, 1);
  assert.equal(state.capabilityCounters.signals[0], state.controller.signal);
  const aborted = fixture();
  const abortedPrepared = prepareLive(aborted);
  aborted.controller.abort();
  const stopped = await commitPrepared(aborted, abortedPrepared);
  assert.equal(stopped.receipt.reasonCode, "RUN_ABORTED");
  assert.equal(aborted.storage.counters.writes, 0);
});

test("public receipts and logs are closed and sanitized", async () => {
  const state = fixture();
  const prepared = prepareLive(state);
  const result = await commitPrepared(state, prepared);
  assert.deepEqual(Object.keys(result.receipt).sort(), [...RECEIPT_KEYS].sort());
  const publicOutput = JSON.stringify({ receipt: result.receipt, logs: state.logs });
  assert.doesNotMatch(publicOutput, /HACT7 private|source-a|hact7-fake-user|contentHash|\.lock|endpoint|stack/i);
  assert.match(result.receipt.clusterIdHash, /^[a-f0-9]{64}$/);
  assert.match(result.receipt.superMemoryIdHash, /^[a-f0-9]{64}$/);
});

test("bridge imports no Qdrant, BGE, Qwen, daemon, chat or RecallRouter wiring", () => {
  const file = path.join(__dirname, "..", "..", "core", "hippocampus",
    "HippocampusBoundedCommitBridge.js");
  const source = fs.readFileSync(file, "utf8");
  assert.doesNotMatch(source, /Qdrant|BgeM3|Qwen|Ollama|HippocampusDaemon|RecallRouter|chat_orbitale|process\.env|fetch\s*\(/);
  assert.doesNotMatch(source, /HippocampusJournal|RecoveryManager|JsonMemoryStorage/);
});
