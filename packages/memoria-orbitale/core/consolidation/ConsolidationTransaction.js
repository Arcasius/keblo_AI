"use strict";

const { createHash } = require("node:crypto");
const { normalizeMemory } = require("../MemoryContractNormalizer");
const { validateClusterRecord } = require("../clustering/ClusterRecord");
const { validateSynthesisResult } = require("../synthesis/SynthesisContract");
const {
  validateProcessingTransitionPlan,
  validateProcessingState
} = require("./ProcessingState");
const {
  createSuperMemoryRecord,
  validateSuperMemoryRecord
} = require("./SuperMemoryRecord");
const {
  STORAGE_CAPABILITIES,
  assertStorageCapabilities
} = require("../StorageCapabilityContract");

const CONSOLIDATION_TRANSACTION_SCHEMA_VERSION = 1;
const HEX_64 = /^[a-f0-9]{64}$/;
const REJECTED_ERROR = Object.freeze({
  code: "SYNTHESIS_SOURCE_REJECTED",
  message: "Source rejected by validated synthesis output",
  retryable: true
});
const PLAN_KEYS = Object.freeze([
  "schemaVersion", "transactionId", "userId", "clusterId",
  "clusterRecordFingerprint", "synthesisRequestId", "superMemory",
  "sourceTransitions", "expectedSources", "committedAt"
]);

class ConsolidationTransactionError extends Error {
  constructor(code, phase, message, details = {}) {
    super(message);
    this.name = "ConsolidationTransactionError";
    this.code = code;
    this.phase = phase;
    Object.assign(this, details);
  }
}

function fail(code, phase, message, details) {
  throw new ConsolidationTransactionError(code, phase, message, details);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (isPlainObject(value)) return Object.fromEntries(Object.keys(value).map((key) => [key, clone(value[key])]));
  return value;
}

function deepFreeze(value) {
  Object.freeze(value);
  for (const child of Object.values(value)) {
    if (child && typeof child === "object" && !Object.isFrozen(child)) deepFreeze(child);
  }
  return value;
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function sha256(value) {
  return createHash("sha256").update(stableStringify(value), "utf8").digest("hex");
}

function assertExactKeys(value, expected, label) {
  if (!isPlainObject(value)) fail("INVALID_INPUT", "validation", `${label} must be a plain object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail("INVALID_INPUT", "validation", `${label} has missing or unknown properties`);
  }
}

function transactionIdentity(plan) {
  return {
    schemaVersion: plan.schemaVersion,
    userId: plan.userId,
    clusterId: plan.clusterId,
    clusterRecordFingerprint: plan.clusterRecordFingerprint,
    synthesisRequestId: plan.synthesisRequestId,
    superMemoryId: plan.superMemory.id,
    superMemoryFingerprint: plan.superMemory.record_fingerprint,
    sourceTransitions: plan.sourceTransitions,
    expectedSources: plan.expectedSources,
    committedAt: plan.committedAt
  };
}

function expectedDescriptor(transition, used) {
  return {
    memoryId: transition.memoryId,
    fromState: transition.fromState,
    expectedRevision: transition.expectedRevision,
    expectedUpdatedAt: transition.expectedUpdatedAt,
    expectedAttemptId: transition.expectedAttemptId,
    used
  };
}

function validateTransitionForRole(transition, used, committedAt, attemptId) {
  const validation = validateProcessingTransitionPlan(transition);
  if (!validation.valid) fail("INVALID_SOURCE_TRANSITION", "plan", "A source transition plan is invalid");
  if (transition.fromState !== "synthesizing" || transition.expectedAttemptId !== attemptId ||
      transition.nextProcessing.attempt_id !== attemptId || transition.nextProcessing.updated_at !== committedAt) {
    fail("INVALID_SOURCE_TRANSITION", "plan", "Source transition attempt or timestamp is inconsistent");
  }
  if (used && transition.toState !== "consolidated") {
    fail("INVALID_SOURCE_TRANSITION", "plan", "Used source must transition to consolidated");
  }
  if (!used) {
    if (transition.toState !== "failed" || stableStringify(transition.nextProcessing.error) !== stableStringify(REJECTED_ERROR)) {
      fail("INVALID_SOURCE_TRANSITION", "plan", "Rejected source must transition to failed with the stable error");
    }
  }
}

function createConsolidationCommitPlan(input) {
  assertExactKeys(input, [
    "userId", "clusterRecord", "synthesisResult", "sourceTransitionPlans",
    "committedAt", "processingAttemptId"
  ], "input");
  if (typeof input.userId !== "string" || input.userId.trim().length === 0 ||
      typeof input.processingAttemptId !== "string" || input.processingAttemptId.trim().length === 0 ||
      !Number.isSafeInteger(input.committedAt) || input.committedAt < 0) {
    fail("INVALID_INPUT", "plan", "User, attempt and committedAt must be explicit and valid");
  }
  let clusterRecord;
  let synthesisResult;
  try { clusterRecord = validateClusterRecord(input.clusterRecord); } catch { fail("INVALID_CLUSTER_RECORD", "plan", "Cluster record is invalid"); }
  try { synthesisResult = validateSynthesisResult(input.synthesisResult); } catch { fail("INVALID_SYNTHESIS_RESULT", "plan", "Synthesis result is invalid"); }
  if (clusterRecord.user_id !== input.userId || synthesisResult.clusterId !== clusterRecord.id ||
      synthesisResult.clusterRecordFingerprint !== clusterRecord.record_fingerprint) {
    fail("CLUSTER_SYNTHESIS_MISMATCH", "plan", "Cluster, user and synthesis result do not match");
  }
  if (!Array.isArray(input.sourceTransitionPlans) ||
      input.sourceTransitionPlans.length !== clusterRecord.source_memory_ids.length) {
    fail("SOURCE_COVERAGE_MISMATCH", "plan", "Exactly one transition per cluster source is required");
  }
  const transitions = input.sourceTransitionPlans.map(clone).sort((a, b) => a.memoryId.localeCompare(b.memoryId));
  const transitionIds = transitions.map(({ memoryId }) => memoryId);
  if (new Set(transitionIds).size !== transitionIds.length || stableStringify(transitionIds) !== stableStringify(clusterRecord.source_memory_ids)) {
    fail("SOURCE_COVERAGE_MISMATCH", "plan", "Transition coverage must exactly match cluster sources");
  }
  const usedIds = new Set(synthesisResult.output.source_memory_ids);
  for (const transition of transitions) {
    validateTransitionForRole(transition, usedIds.has(transition.memoryId), input.committedAt, input.processingAttemptId);
  }
  const superMemory = createSuperMemoryRecord({
    userId: input.userId,
    clusterRecord,
    synthesisResult,
    committedAt: input.committedAt,
    processingAttemptId: input.processingAttemptId
  });
  const plan = {
    schemaVersion: CONSOLIDATION_TRANSACTION_SCHEMA_VERSION,
    transactionId: "",
    userId: input.userId,
    clusterId: clusterRecord.id,
    clusterRecordFingerprint: clusterRecord.record_fingerprint,
    synthesisRequestId: synthesisResult.requestId,
    superMemory,
    sourceTransitions: transitions,
    expectedSources: transitions.map((transition) => expectedDescriptor(transition, usedIds.has(transition.memoryId))),
    committedAt: input.committedAt
  };
  plan.transactionId = sha256(transactionIdentity(plan));
  return validateConsolidationCommitPlan(plan);
}

function validateConsolidationCommitPlan(plan) {
  assertExactKeys(plan, PLAN_KEYS, "transaction plan");
  const copy = clone(plan);
  if (copy.schemaVersion !== CONSOLIDATION_TRANSACTION_SCHEMA_VERSION || !HEX_64.test(copy.transactionId || "")) {
    fail("INVALID_PLAN", "validation", "Transaction schema or ID is invalid");
  }
  if (typeof copy.userId !== "string" || copy.userId.trim().length === 0 ||
      typeof copy.clusterId !== "string" || !HEX_64.test(copy.clusterRecordFingerprint || "") ||
      !HEX_64.test(copy.synthesisRequestId || "") || !Number.isSafeInteger(copy.committedAt) || copy.committedAt < 0) {
    fail("INVALID_PLAN", "validation", "Transaction identity fields are invalid");
  }
  let superMemory;
  try { superMemory = validateSuperMemoryRecord(copy.superMemory); } catch { fail("INVALID_PLAN", "validation", "Super-memory is invalid"); }
  if (superMemory.userId !== copy.userId || superMemory.cluster_id !== copy.clusterId ||
      superMemory.provenance.cluster_record_fingerprint !== copy.clusterRecordFingerprint ||
      superMemory.synthesis.request_id !== copy.synthesisRequestId || superMemory.timestamp !== copy.committedAt) {
    fail("INVALID_PLAN", "validation", "Super-memory does not match transaction identity");
  }
  if (!Array.isArray(copy.sourceTransitions) || !Array.isArray(copy.expectedSources) ||
      copy.sourceTransitions.length !== copy.expectedSources.length || copy.sourceTransitions.length === 0) {
    fail("INVALID_PLAN", "validation", "Transaction source lists are invalid");
  }
  const usedIds = new Set(superMemory.source_memory_ids);
  for (let index = 0; index < copy.sourceTransitions.length; index += 1) {
    const transition = copy.sourceTransitions[index];
    const expected = copy.expectedSources[index];
    validateTransitionForRole(transition, usedIds.has(transition.memoryId), copy.committedAt, superMemory.processing.attempt_id);
    assertExactKeys(expected, ["memoryId", "fromState", "expectedRevision", "expectedUpdatedAt", "expectedAttemptId", "used"], "expected source");
    if (stableStringify(expected) !== stableStringify(expectedDescriptor(transition, usedIds.has(transition.memoryId)))) {
      fail("INVALID_PLAN", "validation", "Expected source descriptor is inconsistent");
    }
  }
  if (sha256(transactionIdentity({ ...copy, superMemory })) !== copy.transactionId) {
    fail("INVALID_PLAN", "validation", "Transaction ID mismatch");
  }
  return deepFreeze({ ...copy, superMemory });
}

function memoryMap(memories) {
  if (!Array.isArray(memories)) fail("INVALID_STORAGE_RESULT", "read", "Storage must return a memory array");
  const map = {};
  for (const memory of memories) {
    if (!isPlainObject(memory) || typeof memory.id !== "string" || memory.id.length === 0 || Object.hasOwn(map, memory.id)) {
      fail("INVALID_STORAGE_RESULT", "read", "Memory collection contains an invalid or duplicate ID");
    }
    map[memory.id] = clone(memory);
  }
  return map;
}

function snapshotFingerprint(map) {
  return sha256(map);
}

function verifyPreconditions(snapshot, plan) {
  for (const transition of plan.sourceTransitions) {
    const memory = snapshot[transition.memoryId];
    if (!memory) fail("SOURCE_NOT_FOUND", "precondition", "A transaction source is missing", { sourceIds: [transition.memoryId] });
    const current = memory.processing;
    const validation = validateProcessingState(current);
    if (!validation.valid || current.state !== transition.fromState ||
        current.revision !== transition.expectedRevision ||
        current.updated_at !== transition.expectedUpdatedAt ||
        current.attempt_id !== transition.expectedAttemptId) {
      fail("OPTIMISTIC_PRECONDITION_FAILED", "precondition", "A source optimistic precondition failed", { sourceIds: [transition.memoryId] });
    }
  }
}

function verifySourceContentHashes(snapshot, plan) {
  const hashes = new Map(plan.superMemory.provenance.source_content_hashes.map(({ id, content_hash }) => [id, content_hash]));
  for (const transition of plan.sourceTransitions) {
    const memory = snapshot[transition.memoryId];
    if (!memory) fail("SOURCE_NOT_FOUND", "precondition", "A transaction source is missing", { sourceIds: [transition.memoryId] });
    let text;
    try { text = normalizeMemory(memory).content.text; } catch {
      fail("SOURCE_CONTENT_HASH_MISMATCH", "precondition", "A source content hash cannot be verified", { sourceIds: [transition.memoryId] });
    }
    const actual = typeof text === "string"
      ? createHash("sha256").update(text, "utf8").digest("hex")
      : null;
    if (actual === null || actual !== hashes.get(transition.memoryId)) {
      fail("SOURCE_CONTENT_HASH_MISMATCH", "precondition", "A source content hash changed after synthesis", { sourceIds: [transition.memoryId] });
    }
  }
}

function verifyReplay(snapshot, plan) {
  const existing = snapshot[plan.superMemory.id];
  if (!existing) return false;
  let validated;
  try { validated = validateSuperMemoryRecord(existing); } catch {
    fail("SUPER_MEMORY_CONFLICT", "idempotency", "Existing super-memory is invalid or incompatible");
  }
  if (validated.idempotency_key !== plan.superMemory.idempotency_key ||
      validated.record_fingerprint !== plan.superMemory.record_fingerprint) {
    fail("SUPER_MEMORY_CONFLICT", "idempotency", "Existing super-memory conflicts with transaction");
  }
  const used = new Set(plan.superMemory.source_memory_ids);
  for (const transition of plan.sourceTransitions) {
    const memory = snapshot[transition.memoryId];
    const expectedState = used.has(transition.memoryId) ? "consolidated" : "failed";
    if (!memory || memory.processing?.state !== expectedState ||
        memory.processing.revision !== transition.nextRevision ||
        memory.processing.attempt_id !== transition.nextProcessing.attempt_id ||
        stableStringify(memory.processing.error) !== stableStringify(transition.nextProcessing.error)) {
      fail("IDEMPOTENT_REPLAY_CONFLICT", "idempotency", "Source state is incompatible with replay");
    }
    if (used.has(transition.memoryId) &&
        (memory.consolidation?.super_memory_id !== plan.superMemory.id ||
         memory.consolidation?.transaction_id !== plan.transactionId)) {
      fail("IDEMPOTENT_REPLAY_CONFLICT", "idempotency", "Used source provenance is incompatible with replay");
    }
  }
  return true;
}

function buildNextMap(snapshot, plan) {
  const next = clone(snapshot);
  const used = new Set(plan.superMemory.source_memory_ids);
  for (const transition of plan.sourceTransitions) {
    const updated = clone(snapshot[transition.memoryId]);
    updated.processing = clone(transition.nextProcessing);
    if (used.has(transition.memoryId)) {
      updated.consolidation = {
        schema_version: 1,
        transaction_id: plan.transactionId,
        super_memory_id: plan.superMemory.id,
        cluster_id: plan.clusterId,
        synthesis_request_id: plan.synthesisRequestId
      };
    }
    next[transition.memoryId] = updated;
  }
  next[plan.superMemory.id] = clone(plan.superMemory);
  return next;
}

function verifyCommittedMap(map, expectedMap, plan) {
  if (snapshotFingerprint(map) !== snapshotFingerprint(expectedMap)) {
    fail("POST_COMMIT_VERIFICATION_FAILED", "post-commit", "Post-commit memory map verification failed");
  }
  validateSuperMemoryRecord(map[plan.superMemory.id]);
  for (const transition of plan.sourceTransitions) {
    const validation = validateProcessingState(map[transition.memoryId]?.processing);
    if (!validation.valid || stableStringify(map[transition.memoryId].processing) !== stableStringify(transition.nextProcessing)) {
      fail("POST_COMMIT_VERIFICATION_FAILED", "post-commit", "Post-commit source verification failed");
    }
  }
}

function report(plan, details) {
  return Object.freeze({
    transactionId: plan.transactionId,
    superMemoryId: plan.superMemory.id,
    committed: details.committed,
    idempotentReplay: details.idempotentReplay,
    sourceCount: plan.sourceTransitions.length,
    consolidatedSourceCount: plan.superMemory.source_memory_ids.length,
    rejectedSourceCount: plan.superMemory.rejected_source_ids.length,
    snapshotFingerprint: details.snapshotFingerprint,
    postCommitFingerprint: details.postCommitFingerprint,
    rollbackPerformed: details.rollbackPerformed
  });
}

async function commitConsolidation(input) {
  assertExactKeys(input, ["storage", "plan"], "commit input");
  const storage = input.storage;
  assertStorageCapabilities(storage, [
    STORAGE_CAPABILITIES.MEMORY_READ_ALL,
    STORAGE_CAPABILITIES.MEMORY_WRITE_ALL,
    STORAGE_CAPABILITIES.COMMIT_ATOMIC,
    STORAGE_CAPABILITIES.LOCK_ACQUIRE,
    STORAGE_CAPABILITIES.LOCK_RELEASE
  ]);
  const plan = validateConsolidationCommitPlan(input.plan);
  const lockHandle = await storage.acquireLock(plan.userId);
  try {
    const snapshot = memoryMap(await storage.loadMemories(plan.userId));
    const beforeFingerprint = snapshotFingerprint(snapshot);
    verifySourceContentHashes(snapshot, plan);
    if (verifyReplay(snapshot, plan)) {
      return report(plan, {
        committed: false,
        idempotentReplay: true,
        snapshotFingerprint: beforeFingerprint,
        postCommitFingerprint: beforeFingerprint,
        rollbackPerformed: false
      });
    }
    verifyPreconditions(snapshot, plan);
    const next = buildNextMap(snapshot, plan);
    for (const transition of plan.sourceTransitions) validateProcessingState(next[transition.memoryId].processing);
    validateSuperMemoryRecord(next[plan.superMemory.id]);
    await storage.saveMemories(plan.userId, Object.values(next), { lockHandle });
    try {
      const committedMap = memoryMap(await storage.loadMemories(plan.userId));
      verifyCommittedMap(committedMap, next, plan);
      return report(plan, {
        committed: true,
        idempotentReplay: false,
        snapshotFingerprint: beforeFingerprint,
        postCommitFingerprint: snapshotFingerprint(committedMap),
        rollbackPerformed: false
      });
    } catch (postCommitError) {
      try {
        await storage.saveMemories(plan.userId, Object.values(snapshot), { lockHandle });
        const restored = memoryMap(await storage.loadMemories(plan.userId));
        if (snapshotFingerprint(restored) !== beforeFingerprint) throw new Error("rollback verification mismatch");
      } catch {
        fail("ROLLBACK_FAILED_STATE_UNKNOWN", "rollback", "Rollback failed; committed state is unknown", {
          committedState: "unknown"
        });
      }
      fail("POST_COMMIT_VERIFICATION_FAILED", "post-commit", "Post-commit verification failed and snapshot was restored", {
        rollbackPerformed: true
      });
    }
  } finally {
    await storage.releaseLock(lockHandle);
  }
}

module.exports = {
  CONSOLIDATION_TRANSACTION_SCHEMA_VERSION,
  ConsolidationTransactionError,
  createConsolidationCommitPlan,
  validateConsolidationCommitPlan,
  commitConsolidation
};
