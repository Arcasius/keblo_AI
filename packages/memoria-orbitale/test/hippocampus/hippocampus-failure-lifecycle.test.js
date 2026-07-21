"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const JsonMemoryStorage = require("../../core/JsonMemoryStorage");
const { createProcessingState } = require("../../core/consolidation/ProcessingState");
const { selectConsolidationCandidates } = require("../../core/consolidation/CandidateSelector");
const { buildConsolidationPlan } = require("../../core/consolidation/ConsolidationPlan");
const { createClusterEngineAdapter } = require("../../core/clustering/ClusterEngineAdapter");
const { createHippocampusJournal } = require("../../core/hippocampus/HippocampusJournal");
const { createRecoveryManager, RECOVERY_ACTIONS } = require("../../core/hippocampus/RecoveryManager");
const { createHippocampusDaemon } = require("../../core/hippocampus/HippocampusDaemon");

const USER = "fix18-private-user";
const PROVIDER_SENTINEL = "fix18-private-provider-payload";
const BASE = 1930000000000;
const COMMIT_REQUEST = Object.freeze({
  mode: "commit",
  phase: "commit",
  confirmCommit: "COMMIT_HIPPOCAMPUS_V1",
  maxClustersPerRun: 1
});

function temp(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fix18-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function raw(id, index = 0) {
  return {
    id,
    type: "episodic",
    content: { text: `synthetic ${id}`, preserve: true },
    timestamp: BASE - index,
    memoryKind: "raw",
    storageTier: "warm",
    unknown: { preserve: true },
    processing: createProcessingState({ state: "raw", revision: 0, attempt_id: null, updated_at: BASE - 100, error: null })
  };
}

function embeddingProvider(getEmbedding = async () => [1, 0]) {
  return { schemaVersion: 1, providerId: "synthetic-embedding", model: "embed-v1", version: "1", getEmbedding };
}

function modelProvider(generate) {
  return { schemaVersion: 1, providerId: "synthetic-model", model: "model-v1", version: "1", generate };
}

function output(ids) {
  return {
    schema_version: 1,
    title: "Synthetic title",
    synthesis: "Synthetic synthesis",
    facts: [{ text: "Synthetic fact", source_memory_ids: [ids[0]] }],
    uncertainties: [],
    contradictions: [],
    source_memory_ids: ids,
    confidence: 0.7,
    rejected_source_ids: []
  };
}

function clock() { let value = BASE; return () => value++; }

async function candidateFor(memories, provider = embeddingProvider()) {
  const plan = buildConsolidationPlan(selectConsolidationCandidates(memories));
  return (await createClusterEngineAdapter({ embeddingProvider: provider }).buildClusterCandidates({ consolidationPlan: plan, memories })).clusters;
}

async function fixture(t, generate, options = {}) {
  const directory = temp(t);
  const storage = new JsonMemoryStorage(directory);
  const memories = options.memories || [raw("a"), raw("b"), raw("c")];
  await storage.saveMemories(USER, memories);
  const embed = options.embeddingProvider || embeddingProvider();
  const clusters = await candidateFor(memories, embed);
  const runtimeClock = clock();
  const journal = createHippocampusJournal({ directory, userId: USER, clock: runtimeClock });
  const recoveryManager = createRecoveryManager({ storage, journal, userId: USER, clock: runtimeClock, recoveryGraceMs: 0 });
  const daemon = createHippocampusDaemon({
    storage: options.daemonStorage || storage,
    userId: USER,
    embeddingProvider: embed,
    modelProvider: modelProvider(generate),
    synthesisLimits: options.synthesisLimits,
    clock: runtimeClock,
    idGenerator: () => options.runId || "run-fix18",
    commitEnabled: true,
    journal: options.daemonJournal || journal,
    recoveryManager
  });
  return { directory, storage, memories, clusters, journal, recoveryManager, daemon };
}

async function run(state, overrides = {}) {
  return state.daemon.runOnce({ ...COMMIT_REQUEST, approvedClusterIds: state.clusters.map(cluster => cluster.clusterId), ...overrides });
}

async function assertPersistedFailure(state, ids = state.memories.map(memory => memory.id)) {
  for (const id of ids) {
    const memory = await state.storage.getMemory(USER, id);
    assert.equal(memory.processing.state, "failed");
    assert.equal(memory.processing.revision, 3);
    assert.match(memory.processing.attempt_id, /^run-fix18:/);
    assert.deepEqual(memory.processing.error, { code: "HIPPOCAMPUS_CLUSTER_FAILED", message: "Cluster processing failed after source claim", retryable: true });
    assert.deepEqual(memory.unknown, { preserve: true });
  }
}

const providerFailures = [
  ["provider exception", async () => { throw new Error(PROVIDER_SENTINEL); }, undefined, "PROVIDER_FAILED"],
  ["provider timeout", async ({ signal }) => new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(new Error(PROVIDER_SENTINEL)), { once: true })), { timeoutMs: 5 }, "SYNTHESIS_TIMEOUT"],
  ["provider non-ok response", async () => ({ ok: false, status: 503, text: PROVIDER_SENTINEL }), undefined, "PROVIDER_NOT_OK"],
  ["invalid JSON", async () => ({ ok: true, status: 200, text: `{${PROVIDER_SENTINEL}` }), undefined, "INVALID_JSON_OUTPUT"],
  ["invalid schema and provenance", async () => ({ ok: true, status: 200, text: JSON.stringify({ schema_version: 1, title: "x", synthesis: "x", facts: [], uncertainties: [], contradictions: [], source_memory_ids: ["invented"], confidence: 2, rejected_source_ids: [] }) }), undefined, "INVALID_SYNTHESIS_OUTPUT"]
];

for (const [label, generate, synthesisLimits, expectedCode] of providerFailures) {
  test(`${label} produces a complete sanitized failure lifecycle`, async t => {
    const state = await fixture(t, generate, { synthesisLimits });
    const report = await run(state);
    assert.equal(report.status, "failed");
    assert.equal(report.failures[0].code, expectedCode);
    assert.doesNotMatch(JSON.stringify(report), new RegExp(PROVIDER_SENTINEL));
    await assertPersistedFailure(state);
    const events = await state.journal.readAll();
    assert.deepEqual(events.map(event => event.event_type).slice(-4), ["SYNTHESIS_STARTED", "SYNTHESIS_FAILED", "SOURCES_FAILED", "RUN_FAILED"]);
    const failureEvent = events.find(event => event.event_type === "SYNTHESIS_FAILED");
    const sourcesFailed = events.find(event => event.event_type === "SOURCES_FAILED");
    assert.equal(failureEvent.details.errorCode, expectedCode);
    assert.equal(sourcesFailed.details.errorCode, "HIPPOCAMPUS_CLUSTER_FAILED");
    assert.equal(failureEvent.attempt_id, sourcesFailed.attempt_id);
    assert.deepEqual(failureEvent.source_memory_ids, sourcesFailed.source_memory_ids);
    const runState = await state.journal.getRunState(report.runId);
    assert.equal(runState.classification, "FAILED_COMPLETE");
    assert.equal(runState.clusters[0].classification, "FAILED");
  });
}

test("failure-event append before source transition yields recovery-required without false terminal", async t => {
  const directory = temp(t);
  const storage = new JsonMemoryStorage(directory);
  const memories = [raw("a"), raw("b"), raw("c")];
  await storage.saveMemories(USER, memories);
  const clusters = await candidateFor(memories);
  const runtimeClock = clock();
  const journal = createHippocampusJournal({ directory, userId: USER, clock: runtimeClock });
  let injected = false;
  const wrapper = { ...journal, append: async event => {
    if (event.event_type === "SYNTHESIS_FAILED" && !injected) { injected = true; throw new Error("journal unavailable"); }
    return journal.append(event);
  } };
  const recoveryManager = createRecoveryManager({ storage, journal, userId: USER, clock: runtimeClock, recoveryGraceMs: 0 });
  const daemon = createHippocampusDaemon({ storage, userId: USER, embeddingProvider: embeddingProvider(), modelProvider: modelProvider(async () => { throw new Error(PROVIDER_SENTINEL); }), clock: runtimeClock, idGenerator: () => "run-fix18", commitEnabled: true, journal: wrapper, recoveryManager });
  const state = { directory, storage, memories, clusters, journal, recoveryManager, daemon };
  const report = await run(state);
  assert.equal(report.status, "needs_reconciliation");
  assert.equal(report.failures[0].code, "NEEDS_RECONCILIATION");
  for (const memory of await storage.loadMemories(USER)) assert.equal(memory.processing.state, "synthesizing");
  assert.equal((await journal.readAll()).some(event => event.event_type === "SOURCES_FAILED"), false);

  const plan = await recoveryManager.buildRecoveryPlan({ generatedAt: BASE + 1000 });
  assert.equal(plan.actions.some(action => action.action === RECOVERY_ACTIONS.MARK_INTERRUPTED_CLAIM_FAILED), true);
  await recoveryManager.executeRecovery({ plan, execute: true, confirmRecovery: "RECOVER_HIPPOCAMPUS_V1" });
  const revisions = (await storage.loadMemories(USER)).map(memory => memory.processing.revision);
  assert.deepEqual(revisions, [3, 3, 3]);
  assert.equal((await recoveryManager.buildRecoveryPlan({ generatedAt: BASE + 2000 })).actions.length, 0);
  assert.deepEqual((await storage.loadMemories(USER)).map(memory => memory.processing.revision), revisions);
});

test("SOURCES_FAILED ACK loss reconciles storage-first without a second revision", async t => {
  const directory = temp(t);
  const storage = new JsonMemoryStorage(directory);
  const memories = [raw("a"), raw("b"), raw("c")];
  await storage.saveMemories(USER, memories);
  const clusters = await candidateFor(memories);
  const runtimeClock = clock();
  const journal = createHippocampusJournal({ directory, userId: USER, clock: runtimeClock });
  let injected = false;
  const wrapper = { ...journal, append: async event => {
    if (event.event_type === "SOURCES_FAILED" && !injected) { injected = true; throw new Error("journal unavailable"); }
    return journal.append(event);
  } };
  const recoveryManager = createRecoveryManager({ storage, journal, userId: USER, clock: runtimeClock, recoveryGraceMs: 0 });
  const daemon = createHippocampusDaemon({ storage, userId: USER, embeddingProvider: embeddingProvider(), modelProvider: modelProvider(async () => { throw new Error(PROVIDER_SENTINEL); }), clock: runtimeClock, idGenerator: () => "run-fix18", commitEnabled: true, journal: wrapper, recoveryManager });
  const state = { directory, storage, memories, clusters, journal, recoveryManager, daemon };
  const report = await run(state);
  assert.equal(report.status, "needs_reconciliation");
  await assertPersistedFailure(state);
  const before = (await storage.loadMemories(USER)).map(memory => memory.processing.revision);
  const plan = await recoveryManager.buildRecoveryPlan({ generatedAt: BASE + 1000 });
  assert.equal(plan.actions.some(action => action.action === RECOVERY_ACTIONS.RECORD_RECOVERED_SOURCE_FAILURE), true);
  await recoveryManager.executeRecovery({ plan, execute: true, confirmRecovery: "RECOVER_HIPPOCAMPUS_V1" });
  assert.deepEqual((await storage.loadMemories(USER)).map(memory => memory.processing.revision), before);
  assert.equal((await journal.getRunState("run-fix18")).complete, true);
});

test("source transition failure remains non-terminal and recoverable", async t => {
  const directory = temp(t);
  const storage = new JsonMemoryStorage(directory);
  const memories = [raw("a"), raw("b"), raw("c")];
  await storage.saveMemories(USER, memories);
  const daemonStorage = new Proxy(storage, { get(target, property, receiver) {
    if (property === "saveMemories") return async (userId, next, options) => {
      if (next.some(memory => memory.processing?.state === "failed")) throw new Error("synthetic transition failure");
      return target.saveMemories(userId, next, options);
    };
    const value = Reflect.get(target, property, receiver);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const clusters = await candidateFor(memories);
  const runtimeClock = clock();
  const journal = createHippocampusJournal({ directory, userId: USER, clock: runtimeClock });
  const recoveryManager = createRecoveryManager({ storage, journal, userId: USER, clock: runtimeClock, recoveryGraceMs: 0 });
  const daemon = createHippocampusDaemon({ storage: daemonStorage, userId: USER, embeddingProvider: embeddingProvider(), modelProvider: modelProvider(async () => { throw new Error(PROVIDER_SENTINEL); }), clock: runtimeClock, idGenerator: () => "run-fix18", commitEnabled: true, journal, recoveryManager });
  const report = await run({ storage, memories, clusters, journal, recoveryManager, daemon });
  assert.equal(report.status, "needs_reconciliation");
  assert.equal((await journal.getRunState("run-fix18")).clusters[0].terminal, false);
  for (const memory of await storage.loadMemories(USER)) assert.equal(memory.processing.state, "synthesizing");
});

test("content-hash mismatch is COMMIT_FAILED and never a false source terminal", async t => {
  let storage;
  const state = await fixture(t, async () => {
    const current = await storage.loadMemories(USER);
    current[0].content.text += " changed after synthesis";
    await storage.saveMemories(USER, current);
    return { ok: true, status: 200, text: JSON.stringify(output(["a", "b", "c"])) };
  });
  storage = state.storage;
  const report = await run(state);
  assert.equal(report.status, "needs_reconciliation");
  const types = (await state.journal.readAll()).map(event => event.event_type);
  assert.ok(types.includes("COMMIT_FAILED"));
  assert.equal(types.includes("SOURCES_FAILED"), false);
  assert.equal((await state.journal.getRunState("run-fix18")).clusters[0].terminal, false);
});

test("continueOnClusterFailure closes failed A, commits B, then closes run", async t => {
  const memories = ["a", "b"].flatMap((group, groupIndex) => Array.from({ length: 3 }, (_, index) => raw(`${group}-${index}`, groupIndex * 3 + index)));
  const embed = embeddingProvider(async ({ memoryId }) => memoryId.startsWith("a-") ? [1, 0] : [0, 1]);
  let calls = 0;
  const state = await fixture(t, async ({ messages }) => {
    calls += 1;
    if (calls === 1) throw new Error(PROVIDER_SENTINEL);
    const serialized = JSON.stringify(messages);
    const ids = serialized.includes("a-0") ? ["a-0", "a-1", "a-2"] : ["b-0", "b-1", "b-2"];
    return { ok: true, status: 200, text: JSON.stringify(output(ids)) };
  }, { memories, embeddingProvider: embed, runId: "run-fix18-multi" });
  const report = await run(state, { maxClustersPerRun: 2, continueOnClusterFailure: true });
  assert.equal(report.status, "failed");
  assert.equal(report.failures.length, 1);
  assert.equal(report.commitStats.committed, 1);
  const runState = await state.journal.getRunState("run-fix18-multi");
  assert.equal(runState.classification, "FAILED_COMPLETE");
  assert.equal(runState.terminalClusters.length, 2);
  assert.deepEqual(runState.clusters.map(cluster => cluster.classification).sort(), ["COMMITTED", "FAILED"]);
  assert.equal((await state.storage.loadMemories(USER)).filter(memory => memory.memoryKind === "super_memory").length, 1);
});

test("failure lifecycle JSONL and reports remain private", async t => {
  const state = await fixture(t, async () => { throw new Error(PROVIDER_SENTINEL); });
  const report = await run(state);
  const rawJournal = fs.readFileSync(path.join(state.directory, state.journal.fileName), "utf8");
  assert.doesNotMatch(rawJournal, new RegExp(USER));
  assert.doesNotMatch(rawJournal, new RegExp(PROVIDER_SENTINEL));
  assert.doesNotMatch(JSON.stringify({ report, state: await state.journal.getRunState(report.runId) }), new RegExp(`${USER}|${PROVIDER_SENTINEL}`));
  assert.equal((await state.journal.inspect()).legacyPrivacyDetected, false);
});
