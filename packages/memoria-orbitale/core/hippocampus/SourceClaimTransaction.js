"use strict";

const { createHash } = require("node:crypto");
const { normalizeMemory } = require("../MemoryContractNormalizer");
const {
  createProcessingTransitionPlan,
  validateProcessingState
} = require("../consolidation/ProcessingState");
const { STORAGE_CAPABILITIES, assertStorageCapabilities } = require("../StorageCapabilityContract");

const SOURCE_CLAIM_SCHEMA_VERSION = 1;
const JOURNAL_SOURCE_CLAIM_SCHEMA_VERSION = 1;
const HEX_64 = /^[a-f0-9]{64}$/;

class SourceClaimError extends Error {
  constructor(code, phase, message, details = {}) {
    super(message);
    this.name = "SourceClaimError";
    this.code = code;
    this.phase = phase;
    Object.assign(this, details);
  }
}

function fail(code, phase, message, details) { throw new SourceClaimError(code, phase, message, details); }
function isPlain(value) { return value && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)); }
function clone(value) { if (Array.isArray(value)) return value.map(clone); if (isPlain(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clone(v)])); return value; }
function freeze(value) { Object.freeze(value); for (const child of Object.values(value)) if (child && typeof child === "object" && !Object.isFrozen(child)) freeze(child); return value; }
function stable(value) { if (value === null || typeof value !== "object") return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`; return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(",")}}`; }
function hash(value) { return createHash("sha256").update(value, "utf8").digest("hex"); }
function textHash(memory) { const text = normalizeMemory(memory).content.text; return typeof text === "string" ? hash(text) : null; }

function createSourceClaimPlan(input) {
  if (!isPlain(input) || Object.keys(input).sort().join(",") !== ["attemptId", "claimedAt", "sourceContentHashes", "sourceIds", "sourceMemories", "userId"].sort().join(",")) {
    fail("INVALID_INPUT", "plan", "Source claim input is invalid");
  }
  if (typeof input.userId !== "string" || !input.userId.trim() || typeof input.attemptId !== "string" || !input.attemptId.trim() || !Number.isSafeInteger(input.claimedAt) || input.claimedAt < 0) {
    fail("INVALID_INPUT", "plan", "User, attempt and claimedAt must be explicit");
  }
  if (!Array.isArray(input.sourceMemories) || !Array.isArray(input.sourceIds) || !isPlain(input.sourceContentHashes)) fail("INVALID_INPUT", "plan", "Sources and hashes are required");
  const sourceIds = [...input.sourceIds].sort();
  if (!sourceIds.length || new Set(sourceIds).size !== sourceIds.length || sourceIds.some(id => typeof id !== "string" || !id)) fail("INVALID_SOURCE_IDS", "plan", "Source IDs must be unique");
  const byId = new Map(input.sourceMemories.map(memory => [memory?.id, memory]));
  if (byId.size !== input.sourceMemories.length || sourceIds.some(id => !byId.has(id))) fail("SOURCE_COVERAGE_MISMATCH", "plan", "Source coverage is incomplete");
  const sources = sourceIds.map(id => {
    const memory = byId.get(id);
    const validation = validateProcessingState(memory?.processing);
    if (!validation.valid || memory.processing.state !== "raw" || memory.processing.attempt_id !== null) fail("SOURCE_NOT_EXPLICIT_RAW", "plan", "Commit source must have explicit raw processing", { sourceIds: [id] });
    const actualHash = textHash(memory);
    if (!HEX_64.test(input.sourceContentHashes[id] || "") || actualHash !== input.sourceContentHashes[id]) fail("SOURCE_CONTENT_HASH_MISMATCH", "plan", "Source content hash is inconsistent", { sourceIds: [id] });
    const candidate = createProcessingTransitionPlan({ memoryId: id, current: memory.processing, toState: "candidate", updatedAt: input.claimedAt, reason: "hippocampus_source_claim" });
    const synthesizing = createProcessingTransitionPlan({ memoryId: id, current: candidate.nextProcessing, toState: "synthesizing", updatedAt: input.claimedAt, attemptId: input.attemptId, reason: "hippocampus_synthesis_claim" });
    return {
      memoryId: id,
      contentHash: actualHash,
      expectedProcessing: clone(memory.processing),
      candidateProcessing: clone(candidate.nextProcessing),
      claimedProcessing: clone(synthesizing.nextProcessing)
    };
  });
  const plan = { schemaVersion: SOURCE_CLAIM_SCHEMA_VERSION, claimId: "", userId: input.userId, attemptId: input.attemptId, claimedAt: input.claimedAt, sources };
  plan.claimId = hash(stable({ ...plan, claimId: undefined }));
  return validateSourceClaimPlan(plan);
}

function validateSourceClaimPlan(plan) {
  if (!isPlain(plan) || Object.keys(plan).sort().join(",") !== ["attemptId", "claimId", "claimedAt", "schemaVersion", "sources", "userId"].sort().join(",")) fail("INVALID_PLAN", "validation", "Claim plan shape is invalid");
  if (plan.schemaVersion !== 1 || !HEX_64.test(plan.claimId || "") || typeof plan.userId !== "string" || !plan.userId || typeof plan.attemptId !== "string" || !plan.attemptId || !Number.isSafeInteger(plan.claimedAt) || plan.claimedAt < 0 || !Array.isArray(plan.sources) || !plan.sources.length) fail("INVALID_PLAN", "validation", "Claim plan identity is invalid");
  const copy = clone(plan);
  const ids = copy.sources.map(source => source.memoryId);
  if (new Set(ids).size !== ids.length || stable(ids) !== stable([...ids].sort())) fail("INVALID_PLAN", "validation", "Claim sources must be unique and sorted");
  for (const source of copy.sources) {
    if (!isPlain(source) || !HEX_64.test(source.contentHash || "")) fail("INVALID_PLAN", "validation", "Claim source descriptor is invalid");
    const states = [source.expectedProcessing, source.candidateProcessing, source.claimedProcessing];
    if (states.some(state => !validateProcessingState(state).valid) || states[0].state !== "raw" || states[1].state !== "candidate" || states[2].state !== "synthesizing" || states[2].attempt_id !== copy.attemptId || states[1].revision !== states[0].revision + 1 || states[2].revision !== states[0].revision + 2 || states[1].updated_at !== copy.claimedAt || states[2].updated_at !== copy.claimedAt) fail("INVALID_PLAN", "validation", "Claim transitions are invalid");
  }
  const expectedId = hash(stable({ ...copy, claimId: undefined }));
  if (expectedId !== copy.claimId) fail("INVALID_PLAN", "validation", "Claim ID mismatch");
  return freeze(copy);
}

function validateJournalSourceClaimDescriptor(descriptor) {
  const fields = ["attemptId", "claimId", "claimedAt", "schemaVersion", "sources"];
  if (!isPlain(descriptor) || Object.keys(descriptor).sort().join(",") !== fields.sort().join(",")) {
    fail("INVALID_JOURNAL_DESCRIPTOR", "journal", "Journal claim descriptor shape is invalid");
  }
  if (descriptor.schemaVersion !== JOURNAL_SOURCE_CLAIM_SCHEMA_VERSION ||
      !HEX_64.test(descriptor.claimId || "") ||
      typeof descriptor.attemptId !== "string" || !descriptor.attemptId ||
      !Number.isSafeInteger(descriptor.claimedAt) || descriptor.claimedAt < 0 ||
      !Array.isArray(descriptor.sources) || !descriptor.sources.length) {
    fail("INVALID_JOURNAL_DESCRIPTOR", "journal", "Journal claim descriptor identity is invalid");
  }
  const copy = clone(descriptor);
  const ids = copy.sources.map(source => source?.memoryId);
  if (ids.some(id => typeof id !== "string" || !id) || new Set(ids).size !== ids.length || stable(ids) !== stable([...ids].sort())) {
    fail("INVALID_JOURNAL_DESCRIPTOR", "journal", "Journal claim sources must be unique and sorted");
  }
  for (const source of copy.sources) {
    const sourceFields = ["candidateProcessing", "claimedProcessing", "contentHash", "expectedProcessing", "memoryId"];
    if (!isPlain(source) || Object.keys(source).sort().join(",") !== sourceFields.sort().join(",") || !HEX_64.test(source.contentHash || "")) {
      fail("INVALID_JOURNAL_DESCRIPTOR", "journal", "Journal claim source descriptor is invalid");
    }
    const states = [source.expectedProcessing, source.candidateProcessing, source.claimedProcessing];
    if (states.some(state => !validateProcessingState(state).valid) ||
        states[0].state !== "raw" || states[1].state !== "candidate" || states[2].state !== "synthesizing" ||
        states[2].attempt_id !== copy.attemptId || states[1].revision !== states[0].revision + 1 ||
        states[2].revision !== states[0].revision + 2 || states[1].updated_at !== copy.claimedAt ||
        states[2].updated_at !== copy.claimedAt) {
      fail("INVALID_JOURNAL_DESCRIPTOR", "journal", "Journal claim transitions are invalid");
    }
  }
  return freeze(copy);
}

function createJournalSourceClaimDescriptor(plan) {
  const validated = validateSourceClaimPlan(plan);
  return validateJournalSourceClaimDescriptor({
    schemaVersion: JOURNAL_SOURCE_CLAIM_SCHEMA_VERSION,
    claimId: validated.claimId,
    attemptId: validated.attemptId,
    claimedAt: validated.claimedAt,
    sources: validated.sources
  });
}

function restoreSourceClaimPlanFromJournal(descriptor, userId) {
  if (typeof userId !== "string" || !userId) fail("INVALID_JOURNAL_SCOPE", "journal", "Journal recovery scope is invalid");
  if (isPlain(descriptor) && Object.hasOwn(descriptor, "userId")) {
    if (descriptor.userId !== userId) fail("JOURNAL_SCOPE_MISMATCH", "journal", "Legacy journal claim scope does not match recovery scope");
    return validateSourceClaimPlan(descriptor);
  }
  const safe = validateJournalSourceClaimDescriptor(descriptor);
  return validateSourceClaimPlan({ ...clone(safe), userId });
}

function capabilities(storage) {
  assertStorageCapabilities(storage, [STORAGE_CAPABILITIES.MEMORY_READ_ALL, STORAGE_CAPABILITIES.MEMORY_WRITE_ALL, STORAGE_CAPABILITIES.COMMIT_ATOMIC, STORAGE_CAPABILITIES.LOCK_ACQUIRE, STORAGE_CAPABILITIES.LOCK_RELEASE]);
}

async function claimSources({ storage, plan }) {
  capabilities(storage);
  plan = validateSourceClaimPlan(plan);
  return storage.withUserLock(plan.userId, async lockHandle => {
    const memories = await storage.loadMemories(plan.userId);
    const map = new Map(memories.map(memory => [memory.id, clone(memory)]));
    let replay = true;
    for (const source of plan.sources) {
      const memory = map.get(source.memoryId);
      if (!memory || textHash(memory) !== source.contentHash) fail("OPTIMISTIC_PRECONDITION_FAILED", "claim", "Source precondition failed", { sourceIds: [source.memoryId] });
      const current = memory.processing;
      const equivalentReplay = current?.state === "synthesizing" && current.revision === source.claimedProcessing.revision && current.attempt_id === plan.attemptId && current.updated_at === plan.claimedAt;
      if (equivalentReplay) continue;
      replay = false;
      if (stable(current) !== stable(source.expectedProcessing)) fail("OPTIMISTIC_PRECONDITION_FAILED", "claim", "Source precondition failed", { sourceIds: [source.memoryId] });
      memory.processing = clone(source.claimedProcessing);
      map.set(source.memoryId, memory);
    }
    if (!replay) await storage.saveMemories(plan.userId, [...map.values()], { lockHandle });
    return freeze({ claimId: plan.claimId, claimed: !replay, idempotentReplay: replay, sourceCount: plan.sources.length, writesAttempted: replay ? 0 : 1 });
  });
}

async function failClaimedSources({ storage, plan, failedAt, error, lockHandle }) {
  capabilities(storage);
  plan = validateSourceClaimPlan(plan);
  if (!Number.isSafeInteger(failedAt) || failedAt < plan.claimedAt || !isPlain(error) || Object.keys(error).sort().join(",") !== "code,message,retryable" || typeof error.code !== "string" || !/^[A-Z0-9_]+$/.test(error.code) || typeof error.message !== "string" || !error.message || error.message.length > 200 || typeof error.retryable !== "boolean") fail("INVALID_FAILURE", "failure", "Failure metadata is invalid");
  const execute = async activeLockHandle => {
    const memories = await storage.loadMemories(plan.userId);
    const map = new Map(memories.map(memory => [memory.id, clone(memory)]));
    let replay = true;
    for (const source of plan.sources) {
      const memory = map.get(source.memoryId);
      const current = memory?.processing;
      const expectedFailed = current?.state === "failed" && current.attempt_id === plan.attemptId && stable(current.error) === stable(error);
      if (expectedFailed) continue;
      replay = false;
      if (!memory || current?.state !== "synthesizing" || current.attempt_id !== plan.attemptId || current.revision !== source.claimedProcessing.revision || textHash(memory) !== source.contentHash) fail("CLAIM_STATE_EVOLVED", "failure", "Claimed source state changed", { sourceIds: [source.memoryId] });
      const transition = createProcessingTransitionPlan({ memoryId: source.memoryId, current, toState: "failed", updatedAt: failedAt, attemptId: plan.attemptId, error, reason: "hippocampus_synthesis_failed" });
      memory.processing = clone(transition.nextProcessing);
      map.set(source.memoryId, memory);
    }
    if (!replay) await storage.saveMemories(plan.userId, [...map.values()], { lockHandle: activeLockHandle });
    return freeze({ claimId: plan.claimId, failed: !replay, idempotentReplay: replay, sourceCount: plan.sources.length, writesAttempted: replay ? 0 : 1 });
  };
  if (lockHandle !== undefined) {
    if (typeof storage.validateLock !== "function") fail("INVALID_LOCK_HANDLE", "failure", "Storage cannot validate the supplied lock handle");
    storage.validateLock(plan.userId, lockHandle);
    return execute(lockHandle);
  }
  return storage.withUserLock(plan.userId, execute);
}

module.exports = {
  SOURCE_CLAIM_SCHEMA_VERSION,
  JOURNAL_SOURCE_CLAIM_SCHEMA_VERSION,
  SourceClaimError,
  createSourceClaimPlan,
  validateSourceClaimPlan,
  createJournalSourceClaimDescriptor,
  validateJournalSourceClaimDescriptor,
  restoreSourceClaimPlanFromJournal,
  claimSources,
  failClaimedSources
};
