"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createHash } = require("node:crypto");

const JsonMemoryStorage = require("../../core/JsonMemoryStorage");
const {
  createFileLockManager,
  FileLockError
} = require("../../core/locking/FileLockManager");
const { fingerprintEmbedding } = require("../../core/clustering/ClusterMath");
const { createClusterRecord } = require("../../core/clustering/ClusterRecord");
const {
  buildSynthesisRequest,
  buildSynthesisResult
} = require("../../core/synthesis/SynthesisContract");
const { DEFAULT_SYNTHESIS_LIMITS } = require("../../core/synthesis/SynthesisEngine");
const {
  createProcessingState,
  createProcessingTransitionPlan
} = require("../../core/consolidation/ProcessingState");
const { normalizeMemory } = require("../../core/MemoryContractNormalizer");
const {
  SUPER_MEMORY_SCHEMA_VERSION,
  createSuperMemoryRecord,
  validateSuperMemoryRecord,
  computeSuperMemoryFingerprint
} = require("../../core/consolidation/SuperMemoryRecord");
const {
  CONSOLIDATION_TRANSACTION_SCHEMA_VERSION,
  createConsolidationCommitPlan,
  validateConsolidationCommitPlan,
  commitConsolidation
} = require("../../core/consolidation/ConsolidationTransaction");
const { inspectStorageCapabilities } = require("../../core/StorageCapabilityContract");

const USER = "synthetic_user";
const ATTEMPT = "attempt-fix-10";
const STARTED_AT = 1780000000000;
const COMMITTED_AT = 1780000001000;
const IDS = ["mem_a", "mem_b", "mem_c"];

function tempDir(label = "mo-fix10-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), label));
}

function cluster(ids = IDS) {
  const centroid = [1, 0.5];
  return createClusterRecord({
    userId: USER,
    planId: "a".repeat(64),
    createdAt: STARTED_AT - 1000,
    embedding: { providerId: "embed", model: "embed-model", version: "v1" },
    clusterCandidate: {
      schemaVersion: 1,
      algorithmVersion: "complete-link-greedy-v1",
      clusterId: "b".repeat(64),
      memberIds: ids,
      embeddingDimension: 2,
      centroid,
      centroidFingerprint: fingerprintEmbedding(centroid),
      density: { averageSimilarity: 0.9, minimumSimilarity: 0.8, maximumSimilarity: 1, memberCount: ids.length },
      policy: { similarityThreshold: 0.7, minClusterSize: 2, maxClusterSize: null },
      reasonCodes: ["CLUSTERED"],
      persisted: false
    }
  });
}

function synthesisResult(record = cluster(), rejected = ["mem_c"]) {
  const sources = record.source_memory_ids.map((id, index) => {
    const text = `Synthetic source ${id}`;
    return {
      id, text, timestamp: STARTED_AT - index, type: "synthetic",
      content_hash: createHash("sha256").update(text, "utf8").digest("hex")
    };
  });
  const request = buildSynthesisRequest({
    clusterRecord: record,
    sources,
    provider: { providerId: "ollama-local", model: "qwen-test", version: "v1" },
    constraints: { language: "it", preserveUncertainty: true, preserveContradictions: true },
    limits: { ...DEFAULT_SYNTHESIS_LIMITS }
  });
  const rejectedSet = new Set(rejected);
  const used = record.source_memory_ids.filter((id) => !rejectedSet.has(id));
  return buildSynthesisResult(request, {
    schema_version: 1,
    title: "Synthetic title",
    synthesis: "Synthetic validated synthesis",
    facts: [{ text: "Synthetic fact", source_memory_ids: [used[0]] }],
    uncertainties: [],
    contradictions: used.length > 1
      ? [{ description: "Synthetic contradiction", source_memory_ids: used.slice(0, 2) }]
      : [],
    source_memory_ids: used,
    confidence: 0.75,
    rejected_source_ids: rejected
  }, request.provider);
}

function source(id, overrides = {}) {
  return {
    id,
    type: "episodic",
    content: { text: `Synthetic source ${id}`, role: "synthetic" },
    timestamp: STARTED_AT - 5000,
    tags: ["keep"],
    activation: 0.42,
    orbitalState: 0.4,
    orbitalLevel: "medium",
    memoryDepth: "normal",
    dualState: { cognitive: 0.4, affective: 0.2, lastUpdate: STARTED_AT - 1 },
    meta: { user_id: USER, keep: true },
    unknownField: { keep: "exact" },
    processing: createProcessingState({
      state: "synthesizing", revision: 3, attempt_id: ATTEMPT,
      updated_at: STARTED_AT, error: null
    }),
    ...overrides
  };
}

function transition(memory, used, overrides = {}) {
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
    reason: used ? "Validated synthesis used source" : "Validated synthesis rejected source",
    ...overrides
  });
}

function fixture() {
  const clusterRecord = cluster();
  const result = synthesisResult(clusterRecord);
  const sourceMemories = IDS.map((id) => source(id));
  const used = new Set(result.output.source_memory_ids);
  const sourceTransitionPlans = sourceMemories.map((memory) => transition(memory, used.has(memory.id)));
  const plan = createConsolidationCommitPlan({
    userId: USER,
    clusterRecord,
    synthesisResult: result,
    sourceTransitionPlans,
    committedAt: COMMITTED_AT,
    processingAttemptId: ATTEMPT
  });
  return { clusterRecord, result, sourceMemories, sourceTransitionPlans, plan };
}

function mutable(value) {
  return JSON.parse(JSON.stringify(value));
}

function lockDirectoryIsEmpty(directory) {
  const lockDirectory = path.join(directory, ".locks");
  return !fs.existsSync(lockDirectory) || fs.readdirSync(lockDirectory).length === 0;
}

test("FileLockManager acquires and releases exclusive hashed lock files", async () => {
  const directory = tempDir("mo-lock-");
  try {
    const manager = createFileLockManager({ lockDirectory: directory });
    const handle = await manager.acquire("private-user-id");
    const entries = fs.readdirSync(directory);
    assert.equal(entries.length, 1);
    assert.doesNotMatch(entries[0], /private-user-id/);
    assert.doesNotMatch(fs.readFileSync(path.join(directory, entries[0]), "utf8"), /private-user-id|memory|content/);
    await manager.release(handle);
    assert.equal(!fs.existsSync(directory) || fs.readdirSync(directory).length === 0, true);
    await assert.rejects(manager.release(handle), { code: "LOCK_ALREADY_RELEASED" });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("lock serializes the same key, times out, and leaves stale locks untouched", async () => {
  const directory = tempDir("mo-lock-serial-");
  try {
    const manager = createFileLockManager({ lockDirectory: directory, timeoutMs: 40, retryIntervalMs: 5 });
    const first = await manager.acquire("same-user");
    await assert.rejects(manager.acquire("same-user"), { code: "LOCK_ACQUIRE_TIMEOUT" });
    assert.equal(fs.readdirSync(directory).length, 1);
    await manager.release(first);
    const second = await manager.acquire("same-user");
    await manager.release(second);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, `${createHash("sha256").update("stale").digest("hex")}.lock`), "{}", "utf8");
    await assert.rejects(manager.acquire("stale", { timeoutMs: 15, retryIntervalMs: 5 }), { code: "LOCK_ACQUIRE_TIMEOUT" });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("lock rejects foreign handles and token tampering", async () => {
  const directory = tempDir("mo-lock-owner-");
  try {
    const one = createFileLockManager({ lockDirectory: directory });
    const two = createFileLockManager({ lockDirectory: directory });
    const handle = await one.acquire("owner");
    await assert.rejects(two.release(handle), { code: "LOCK_INVALID_HANDLE" });
    const file = path.join(directory, fs.readdirSync(directory)[0]);
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, token: "wrong", ownerId: "wrong" }), "utf8");
    await assert.rejects(one.release(handle), { code: "LOCK_OWNERSHIP_LOST" });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("withLock releases on success and callback error; different users are independent", async () => {
  const directory = tempDir("mo-lock-with-");
  try {
    const manager = createFileLockManager({ lockDirectory: directory });
    assert.equal(await manager.withLock("success", async () => 7), 7);
    await assert.rejects(manager.withLock("failure", async () => { throw new Error("expected"); }), /expected/);
    const first = await manager.acquire("user-a");
    const second = await manager.acquire("user-b");
    assert.equal(fs.readdirSync(directory).length, 2);
    await manager.release(first); await manager.release(second);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("JsonMemoryStorage serializes concurrent memory, link and cluster writers", async () => {
  const directory = tempDir("mo-storage-lock-");
  try {
    const storage = new JsonMemoryStorage(directory);
    await Promise.all(Array.from({ length: 12 }, (_, index) =>
      storage.saveMemory(USER, { id: `m${index}`, content: { text: "synthetic" } })
    ));
    assert.equal((await storage.loadMemories(USER)).length, 12);
    await Promise.all(Array.from({ length: 8 }, (_, index) =>
      storage.saveLink(USER, { id: `l${index}`, source: "a", target: `b${index}` })
    ));
    assert.equal((await storage.loadLinks(USER)).length, 8);
    const records = [cluster(["a", "b"]), cluster(["c", "d"])];
    await Promise.all(records.map((record) => storage.saveCluster(USER, record)));
    assert.equal((await storage.loadClusters(USER)).length, 2);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("legacy write signatures work and a valid handle avoids nested locking", async () => {
  const directory = tempDir("mo-storage-legacy-");
  try {
    const storage = new JsonMemoryStorage(directory);
    await storage.saveMemory({ id: "legacy", content: "x", meta: { user_id: USER } });
    const handle = await storage.acquireLock(USER);
    try {
      await storage.saveMemory(USER, { id: "under-lock", content: "y" }, { lockHandle: handle });
      await storage.saveMemories(USER, await storage.loadMemories(USER), { lockHandle: handle });
      await assert.rejects(storage.saveMemory("other", { id: "bad" }, { lockHandle: handle }), { code: "LOCK_KEY_MISMATCH" });
    } finally { await storage.releaseLock(handle); }
    assert.equal((await storage.loadMemories(USER)).length, 2);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("storage declares only verified lock capabilities while snapshot and rollback remain unsupported", () => {
  const directory = tempDir("mo-storage-cap-");
  try {
    const report = inspectStorageCapabilities(new JsonMemoryStorage(directory));
    for (const capability of ["lock.acquire", "lock.release"]) {
      assert.equal(report.capabilities[capability].status, "supported");
      assert.equal(report.capabilities[capability].behaviorallyVerified, true);
    }
    for (const capability of ["snapshot.create", "snapshot.verify", "snapshot.restore", "rollback"]) {
      assert.equal(report.capabilities[capability].status, "unsupported");
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("creates deterministic canonical super-memory without source raw text", () => {
  const { clusterRecord, result } = fixture();
  const input = { userId: USER, clusterRecord, synthesisResult: result, committedAt: COMMITTED_AT, processingAttemptId: ATTEMPT };
  const before = structuredClone(input);
  const record = createSuperMemoryRecord(input);
  const retry = createSuperMemoryRecord({ ...input, committedAt: COMMITTED_AT + 1000 });
  assert.equal(SUPER_MEMORY_SCHEMA_VERSION, 1);
  assert.equal(record.id, retry.id);
  assert.equal(record.idempotency_key, retry.idempotency_key);
  assert.equal(record.record_fingerprint, retry.record_fingerprint);
  assert.equal(record.memoryKind, "super_memory");
  assert.equal(record.storageTier, "core");
  assert.equal(record.processing.state, "consolidated");
  assert.deepEqual(record.source_memory_ids, ["mem_a", "mem_b"]);
  assert.deepEqual(record.rejected_source_ids, ["mem_c"]);
  assert.equal(record.cluster_id, clusterRecord.id);
  assert.equal(record.synthesis.request_id, result.requestId);
  assert.equal(record.provenance.cluster_record_fingerprint, clusterRecord.record_fingerprint);
  assert.doesNotMatch(JSON.stringify(record), /Synthetic source mem_|messages|raw response|sourceSnapshot/);
  assert.equal(Object.hasOwn(record, "prompt"), false);
  assert.equal(Object.hasOwn(record, "messages"), false);
  assert.deepEqual(input, before);
  assert.equal(Object.isFrozen(record.content.facts), true);
  assert.deepStrictEqual(validateSuperMemoryRecord(record), record);
  assert.equal(computeSuperMemoryFingerprint(record), record.record_fingerprint);
});

test("normalizer recognizes the super-memory contract", () => {
  const { clusterRecord, result } = fixture();
  const record = createSuperMemoryRecord({ userId: USER, clusterRecord, synthesisResult: result, committedAt: COMMITTED_AT, processingAttemptId: ATTEMPT });
  const normalized = normalizeMemory(record);
  assert.equal(normalized.memoryKind, "super_memory");
  assert.equal(normalized.storageTier, "core");
  assert.equal(normalized.processingState, "consolidated");
  assert.equal(normalized.content.text, "Synthetic validated synthesis");
});

test("super-memory validation rejects timestamp, identity and content tampering", () => {
  const { plan } = fixture();
  for (const mutate of [
    (copy) => { copy.id = `sm_${"0".repeat(64)}`; },
    (copy) => { copy.timestamp = -1; },
    (copy) => { copy.content.text = "changed"; },
    (copy) => { copy.processing.state = "failed"; },
    (copy) => { copy.record_fingerprint = "0".repeat(64); }
  ]) {
    const copy = mutable(plan.superMemory); mutate(copy);
    assert.throws(() => validateSuperMemoryRecord(copy));
  }
});

test("builds a deterministic private transaction plan with complete role-correct coverage", () => {
  const first = fixture().plan;
  const second = fixture().plan;
  assert.equal(CONSOLIDATION_TRANSACTION_SCHEMA_VERSION, 1);
  assert.deepStrictEqual(first, second);
  assert.match(first.transactionId, /^[a-f0-9]{64}$/);
  assert.deepEqual(first.expectedSources.map(({ memoryId }) => memoryId), IDS);
  assert.deepEqual(first.sourceTransitions.map(({ toState }) => toState), ["consolidated", "consolidated", "failed"]);
  assert.equal(Object.isFrozen(first.sourceTransitions), true);
  assert.doesNotMatch(JSON.stringify(first), /RAW mem_|messages|callback/);
  assert.equal(Object.hasOwn(first, "prompt"), false);
  assert.equal(Object.hasOwn(first, "storage"), false);
  assert.deepStrictEqual(validateConsolidationCommitPlan(first), first);
});

test("plan rejects incomplete coverage, wrong rejected transition and cluster mismatch", () => {
  const data = fixture();
  assert.throws(() => createConsolidationCommitPlan({
    userId: USER, clusterRecord: data.clusterRecord, synthesisResult: data.result,
    sourceTransitionPlans: data.sourceTransitionPlans.slice(0, 2), committedAt: COMMITTED_AT,
    processingAttemptId: ATTEMPT
  }), /transition/i);
  const wrongRejected = [...data.sourceTransitionPlans];
  wrongRejected[2] = transition(data.sourceMemories[2], true);
  assert.throws(() => createConsolidationCommitPlan({
    userId: USER, clusterRecord: data.clusterRecord, synthesisResult: data.result,
    sourceTransitionPlans: wrongRejected, committedAt: COMMITTED_AT, processingAttemptId: ATTEMPT
  }));
  const mismatch = mutable(data.result); mismatch.clusterId = "other";
  assert.throws(() => createConsolidationCommitPlan({
    userId: USER, clusterRecord: data.clusterRecord, synthesisResult: mismatch,
    sourceTransitionPlans: data.sourceTransitionPlans, committedAt: COMMITTED_AT,
    processingAttemptId: ATTEMPT
  }));
});

test("transaction commits super-memory and all source transitions in one memory write", async () => {
  const directory = tempDir("mo-transaction-");
  try {
    const storage = new JsonMemoryStorage(directory);
    const data = fixture();
    await storage.saveMemories(USER, data.sourceMemories);
    let writes = 0;
    const original = storage._writeJson.bind(storage);
    storage._writeJson = async (...args) => { writes += 1; return original(...args); };
    const beforeSources = structuredClone(data.sourceMemories);
    const report = await commitConsolidation({ storage, plan: data.plan });
    assert.equal(writes, 1);
    assert.equal(report.committed, true);
    assert.equal(report.idempotentReplay, false);
    assert.equal(report.consolidatedSourceCount, 2);
    assert.equal(report.rejectedSourceCount, 1);
    const map = Object.fromEntries((await storage.loadMemories(USER)).map((memory) => [memory.id, memory]));
    assert.equal(map.mem_a.processing.state, "consolidated");
    assert.equal(map.mem_b.processing.state, "consolidated");
    assert.equal(map.mem_c.processing.state, "failed");
    assert.equal(map.mem_c.processing.error.code, "SYNTHESIS_SOURCE_REJECTED");
    assert.equal(map.mem_a.consolidation.super_memory_id, data.plan.superMemory.id);
    assert.equal(Object.hasOwn(map.mem_c, "consolidation"), false);
    assert.deepEqual(map[data.plan.superMemory.id], data.plan.superMemory);
    for (const originalSource of beforeSources) {
      const persisted = map[originalSource.id];
      for (const key of Object.keys(originalSource).filter((key) => key !== "processing")) {
        assert.deepEqual(persisted[key], originalSource[key]);
      }
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("content hash precondition rejects a source changed after synthesis before any commit write", async () => {
  const directory = tempDir("mo-content-hash-precondition-");
  try {
    const storage = new JsonMemoryStorage(directory);
    const data = fixture();
    const changed = structuredClone(data.sourceMemories);
    changed[1].content.text = `${changed[1].content.text} changed after synthesis`;
    await storage.saveMemories(USER, changed);
    let writes = 0;
    const original = storage.saveMemories.bind(storage);
    storage.saveMemories = async (...args) => { writes += 1; return original(...args); };
    await assert.rejects(commitConsolidation({ storage, plan: data.plan }), (error) => {
      assert.equal(error.code, "SOURCE_CONTENT_HASH_MISMATCH");
      assert.deepEqual(error.sourceIds, ["mem_b"]);
      assert.doesNotMatch(error.message, /Synthetic source mem_b changed|RAW mem_b/);
      return true;
    });
    assert.equal(writes, 0);
    const persisted = await storage.loadMemories(USER);
    assert.equal(persisted.some((memory) => memory.memoryKind === "super_memory"), false);
    assert.equal(persisted.every((memory) => memory.processing.state === "synthesizing"), true);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("optimistic mismatch or missing source prevents every write", async () => {
  for (const change of [
    (sources) => { sources.pop(); },
    (sources) => { sources[0].processing = { ...sources[0].processing, state: "candidate", attempt_id: null }; },
    (sources) => { sources[0].processing = { ...sources[0].processing, revision: 99 }; },
    (sources) => { sources[0].processing = { ...sources[0].processing, updated_at: 99 }; },
    (sources) => { sources[0].processing = { ...sources[0].processing, attempt_id: "other" }; }
  ]) {
    const directory = tempDir("mo-precondition-");
    try {
      const storage = new JsonMemoryStorage(directory);
      const data = fixture();
      const sources = mutable(data.sourceMemories); change(sources);
      await storage.saveMemories(USER, sources);
      const before = fs.readFileSync(path.join(directory, `${USER}_memories.json`), "utf8");
      await assert.rejects(commitConsolidation({ storage, plan: data.plan }));
      assert.equal(fs.readFileSync(path.join(directory, `${USER}_memories.json`), "utf8"), before);
      assert.equal(lockDirectoryIsEmpty(directory), true);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  }
});

test("idempotent replay performs no write and does not increment revisions", async () => {
  const directory = tempDir("mo-replay-");
  try {
    const storage = new JsonMemoryStorage(directory);
    const data = fixture();
    await storage.saveMemories(USER, data.sourceMemories);
    await commitConsolidation({ storage, plan: data.plan });
    const before = await storage.loadMemories(USER);
    let writes = 0;
    const original = storage._writeJson.bind(storage);
    storage._writeJson = async (...args) => { writes += 1; return original(...args); };
    const report = await commitConsolidation({ storage, plan: data.plan });
    assert.equal(report.committed, false);
    assert.equal(report.idempotentReplay, true);
    assert.equal(writes, 0);
    assert.deepEqual(await storage.loadMemories(USER), before);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("incompatible existing super-memory is a no-write conflict", async () => {
  const directory = tempDir("mo-conflict-");
  try {
    const storage = new JsonMemoryStorage(directory);
    const data = fixture();
    const conflicting = mutable(data.plan.superMemory);
    conflicting.content.text = "conflict";
    await storage.saveMemories(USER, [...data.sourceMemories, conflicting]);
    const before = fs.readFileSync(path.join(directory, `${USER}_memories.json`), "utf8");
    await assert.rejects(commitConsolidation({ storage, plan: data.plan }), { code: "SUPER_MEMORY_CONFLICT" });
    assert.equal(fs.readFileSync(path.join(directory, `${USER}_memories.json`), "utf8"), before);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("post-commit verification failure restores the exact in-memory snapshot", async () => {
  const directory = tempDir("mo-rollback-");
  try {
    const storage = new JsonMemoryStorage(directory);
    const data = fixture();
    await storage.saveMemories(USER, data.sourceMemories);
    const before = await storage.loadMemories(USER);
    const originalLoad = storage.loadMemories.bind(storage);
    let loads = 0;
    storage.loadMemories = async (...args) => {
      loads += 1;
      const value = await originalLoad(...args);
      if (loads === 2) return value.filter((memory) => memory.id !== data.plan.superMemory.id);
      return value;
    };
    await assert.rejects(commitConsolidation({ storage, plan: data.plan }), (error) => {
      assert.equal(error.code, "POST_COMMIT_VERIFICATION_FAILED");
      assert.equal(error.rollbackPerformed, true);
      return true;
    });
    assert.deepEqual(await originalLoad(USER), before);
    assert.equal(lockDirectoryIsEmpty(directory), true);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("rollback failure reports unknown committed state and releases lock", async () => {
  const directory = tempDir("mo-rollback-fail-");
  try {
    const storage = new JsonMemoryStorage(directory);
    const data = fixture();
    await storage.saveMemories(USER, data.sourceMemories);
    const originalLoad = storage.loadMemories.bind(storage);
    const originalSave = storage.saveMemories.bind(storage);
    let loads = 0; let writes = 0;
    storage.loadMemories = async (...args) => {
      loads += 1; const value = await originalLoad(...args);
      return loads === 2 ? [] : value;
    };
    storage.saveMemories = async (...args) => {
      writes += 1;
      if (writes === 2) throw new Error("synthetic rollback failure");
      return originalSave(...args);
    };
    await assert.rejects(commitConsolidation({ storage, plan: data.plan }), (error) => {
      assert.equal(error.code, "ROLLBACK_FAILED_STATE_UNKNOWN");
      assert.equal(error.committedState, "unknown");
      return true;
    });
    assert.equal(lockDirectoryIsEmpty(directory), true);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("commit report is non-sensitive and cluster storage remains untouched", async () => {
  const directory = tempDir("mo-report-");
  try {
    const storage = new JsonMemoryStorage(directory);
    const data = fixture();
    await storage.saveCluster(USER, data.clusterRecord);
    const clusterBefore = fs.readFileSync(path.join(directory, `${USER}_clusters.json`), "utf8");
    await storage.saveMemories(USER, data.sourceMemories);
    const report = await commitConsolidation({ storage, plan: data.plan });
    assert.deepEqual(Object.keys(report).sort(), [
      "committed", "consolidatedSourceCount", "idempotentReplay", "postCommitFingerprint",
      "rejectedSourceCount", "rollbackPerformed", "snapshotFingerprint", "sourceCount",
      "superMemoryId", "transactionId"
    ]);
    assert.doesNotMatch(JSON.stringify(report), /RAW|Synthetic validated|prompt|token|\.lock|object map/);
    assert.equal(fs.readFileSync(path.join(directory, `${USER}_clusters.json`), "utf8"), clusterBefore);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("FIX 10 modules do not import server, models, compressor or legacy cluster", () => {
  for (const file of [
    "core/locking/FileLockManager.js",
    "core/consolidation/SuperMemoryRecord.js",
    "core/consolidation/ConsolidationTransaction.js"
  ]) {
    const sourceCode = fs.readFileSync(path.join(__dirname, "..", "..", file), "utf8");
    assert.doesNotMatch(sourceCode, /ColdMemoryCompressor|ClusterEngine["']|Keblomemory|server\.js|Qwen|Ollama|fetch\s*\(/);
  }
});
