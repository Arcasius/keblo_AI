"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");

const JsonMemoryStorage = require("../../core/JsonMemoryStorage");
const { createProcessingState } = require("../../core/consolidation/ProcessingState");
const {
  createSourceClaimPlan,
  createJournalSourceClaimDescriptor,
  claimSources
} = require("../../core/hippocampus/SourceClaimTransaction");
const { createHippocampusJournal } = require("../../core/hippocampus/HippocampusJournal");
const { createRecoveryManager, RECOVERY_ACTIONS } = require("../../core/hippocampus/RecoveryManager");

const USER = "fix17-private-user";
const BASE = 1920000000000;
const sha = value => createHash("sha256").update(value, "utf8").digest("hex");

function temp(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fix17-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function raw(id) {
  return {
    id,
    type: "episodic",
    content: { text: `synthetic ${id}` },
    timestamp: BASE - 20,
    memoryKind: "raw",
    storageTier: "warm",
    processing: createProcessingState({ state: "raw", revision: 0, attempt_id: null, updated_at: BASE - 30, error: null })
  };
}

function planFor(clusterId, memories) {
  return createSourceClaimPlan({
    userId: USER,
    sourceMemories: memories,
    sourceIds: memories.map(memory => memory.id),
    attemptId: `attempt-${clusterId}`,
    claimedAt: BASE,
    sourceContentHashes: Object.fromEntries(memories.map(memory => [memory.id, sha(memory.content.text)]))
  });
}

function emitter(journal, runId = "run-multi") {
  let timestamp = BASE;
  return (event_type, cluster_id = null, extra = {}) => journal.append({
    event_type,
    run_id: runId,
    mode: "commit",
    phase: event_type.startsWith("COMMIT") ? "commit" : "synthesis",
    status: "recorded",
    timestamp: timestamp++,
    cluster_id,
    ...extra,
    details: extra.details || {}
  });
}

async function appendClaim(emit, clusterId, plan) {
  await emit("SOURCES_CLAIMED", clusterId, {
    attempt_id: plan.attemptId,
    source_memory_ids: plan.sources.map(source => source.memoryId),
    details: { claimPlan: createJournalSourceClaimDescriptor(plan) }
  });
}

async function appendCommitted(emit, clusterId, plan, interleave = {}) {
  await emit("CLUSTER_SELECTED", clusterId, { source_memory_ids: plan.sources.map(source => source.memoryId) });
  await emit("CLUSTER_PERSISTED", clusterId, { details: { clusterRecordId: `record-${clusterId}` } });
  await appendClaim(emit, clusterId, plan);
  if (interleave.afterClaim) await interleave.afterClaim();
  await emit("SYNTHESIS_STARTED", clusterId, { attempt_id: plan.attemptId, source_memory_ids: plan.sources.map(source => source.memoryId) });
  await emit("SYNTHESIS_SUCCEEDED", clusterId, { attempt_id: plan.attemptId, source_memory_ids: plan.sources.map(source => source.memoryId) });
  await emit("COMMIT_STARTED", clusterId, { attempt_id: plan.attemptId, transaction_id: `tx-${clusterId}`, source_memory_ids: plan.sources.map(source => source.memoryId) });
  await emit("COMMIT_SUCCEEDED", clusterId, { attempt_id: plan.attemptId, transaction_id: `tx-${clusterId}`, source_memory_ids: plan.sources.map(source => source.memoryId) });
}

test("committed A cannot hide claimed B and recovery targets only B", async t => {
  const directory = temp(t);
  const storage = new JsonMemoryStorage(directory);
  const a = [raw("a-1"), raw("a-2")];
  const b = [raw("b-1"), raw("b-2")];
  await storage.saveMemories(USER, [...a, ...b]);
  const planA = planFor("A", a);
  const planB = planFor("B", b);
  await claimSources({ storage, plan: planB });
  const journal = createHippocampusJournal({ directory, userId: USER });
  const emit = emitter(journal);
  await emit("RUN_STARTED");
  await appendCommitted(emit, "A", planA);
  await emit("CLUSTER_SELECTED", "B", { source_memory_ids: ["b-1", "b-2"] });
  await emit("CLUSTER_PERSISTED", "B", { details: { clusterRecordId: "record-B" } });
  await appendClaim(emit, "B", planB);

  const state = await journal.getRunState("run-multi");
  assert.equal(state.classification, "MULTI_CLUSTER_INCOMPLETE");
  assert.deepEqual(state.terminalClusters, ["A"]);
  assert.deepEqual(state.incompleteClusters, ["B"]);
  const recovery = createRecoveryManager({ storage, journal, userId: USER, clock: () => BASE + 1000, recoveryGraceMs: 1 });
  const recoveryPlan = await recovery.buildRecoveryPlan({ generatedAt: BASE + 1000 });
  const claimActions = recoveryPlan.actions.filter(action => action.action === RECOVERY_ACTIONS.MARK_INTERRUPTED_CLAIM_FAILED);
  assert.deepEqual(claimActions.map(action => action.clusterId), ["B"]);
  assert.equal(recoveryPlan.actions.some(action => action.clusterId === "A"), false);

  await recovery.executeRecovery({ plan: recoveryPlan, execute: true, confirmRecovery: "RECOVER_HIPPOCAMPUS_V1" });
  assert.equal((await storage.getMemory(USER, "a-1")).processing.state, "raw");
  assert.equal((await storage.getMemory(USER, "b-1")).processing.state, "failed");
  const revisions = b.map(memory => storage.getMemory(USER, memory.id));
  const after = await Promise.all(revisions);
  const next = await recovery.buildRecoveryPlan({ generatedAt: BASE + 2000 });
  assert.equal(next.actions.length, 0);
  assert.deepEqual((await Promise.all(b.map(memory => storage.getMemory(USER, memory.id)))).map(memory => memory.processing.revision), after.map(memory => memory.processing.revision));
  assert.equal((await storage.loadMemories(USER)).filter(memory => memory.memoryKind === "super_memory").length, 0);
});

test("interleaved clusters retain independent order and earlier incomplete cluster", async t => {
  const journal = createHippocampusJournal({ directory: temp(t), userId: USER });
  const emit = emitter(journal, "run-interleaved");
  const planA = planFor("A", [raw("ia")]);
  const planB = planFor("B", [raw("ib")]);
  await emit("RUN_STARTED");
  await emit("CLUSTER_SELECTED", "A", { source_memory_ids: ["ia"] });
  await appendClaim(emit, "A", planA);
  await emit("CLUSTER_SELECTED", "B", { source_memory_ids: ["ib"] });
  await appendClaim(emit, "B", planB);
  await emit("SYNTHESIS_STARTED", "B", { attempt_id: planB.attemptId, source_memory_ids: ["ib"] });
  await emit("SYNTHESIS_SUCCEEDED", "B", { attempt_id: planB.attemptId, source_memory_ids: ["ib"] });
  await emit("COMMIT_STARTED", "B", { attempt_id: planB.attemptId, transaction_id: "tx-B", source_memory_ids: ["ib"] });
  await emit("COMMIT_SUCCEEDED", "B", { attempt_id: planB.attemptId, transaction_id: "tx-B", source_memory_ids: ["ib"] });
  const state = await journal.getRunState("run-interleaved");
  assert.deepEqual(state.terminalClusters, ["B"]);
  assert.deepEqual(state.incompleteClusters, ["A"]);
  assert.equal(state.clusters.find(cluster => cluster.clusterId === "A").classification, "CLAIMED_NO_SYNTHESIS");
});

test("all clusters require an explicit validated run terminal", async t => {
  const journal = createHippocampusJournal({ directory: temp(t), userId: USER });
  const emit = emitter(journal, "run-complete");
  await emit("RUN_STARTED");
  await appendCommitted(emit, "A", planFor("A", [raw("ca")]));
  await appendCommitted(emit, "B", planFor("B", [raw("cb")]));
  assert.equal((await journal.getRunState("run-complete")).classification, "ALL_CLUSTERS_TERMINAL_NO_RUN_COMPLETION");
  await emit("RUN_COMPLETED");
  const completed = await journal.getRunState("run-complete");
  assert.equal(completed.complete, true);
  assert.equal(completed.classification, "COMPLETE");
  assert.deepEqual(completed.terminalClusters, ["A", "B"]);
});

test("explicit run terminal with an incomplete cluster is blocked", async t => {
  const journal = createHippocampusJournal({ directory: temp(t), userId: USER });
  const emit = emitter(journal, "run-false-terminal");
  const plan = planFor("B", [raw("fb")]);
  await emit("RUN_STARTED");
  await appendClaim(emit, "B", plan);
  await emit("RUN_COMPLETED");
  const state = await journal.getRunState("run-false-terminal");
  assert.equal(state.blocked, true);
  assert.ok(state.reasonCodes.includes("RUN_TERMINAL_WITH_NONTERMINAL_CLUSTER"));
});

test("twelve clusters are reconstructed without an implicit five", async t => {
  const journal = createHippocampusJournal({ directory: temp(t), userId: USER });
  const emit = emitter(journal, "run-twelve");
  await emit("RUN_STARTED");
  for (let index = 0; index < 12; index++) {
    const clusterId = `cluster-${String(index).padStart(2, "0")}`;
    await appendCommitted(emit, clusterId, planFor(clusterId, [raw(`m-${index}`)]));
  }
  await emit("RUN_COMPLETED");
  const state = await journal.getRunState("run-twelve");
  assert.equal(state.clusters.length, 12);
  assert.equal(state.terminalClusters.length, 12);
  assert.equal(state.complete, true);
});

test("contradictory attempt, claim and cross-cluster correlation fail closed", async t => {
  const directory = temp(t);
  const storage = new JsonMemoryStorage(directory);
  const untouched = [raw("conflict-a"), raw("conflict-b")];
  await storage.saveMemories(USER, untouched);
  const journal = createHippocampusJournal({ directory, userId: USER });
  const emit = emitter(journal, "run-conflict");
  const planA = planFor("A", [raw("conflict-a")]);
  await emit("RUN_STARTED");
  await appendClaim(emit, "A", planA);
  await emit("SYNTHESIS_STARTED", "A", { attempt_id: "different-attempt", source_memory_ids: ["conflict-a"] });
  await emit("SOURCES_CLAIMED", "B", { attempt_id: planA.attemptId, source_memory_ids: ["conflict-a"], details: { claimPlan: createJournalSourceClaimDescriptor(planA) } });
  const state = await journal.getRunState("run-conflict");
  assert.equal(state.blocked, true);
  assert.ok(state.reasonCodes.includes("ATTEMPT_ID_CONFLICT"));
  assert.ok(state.reasonCodes.includes("ATTEMPT_ID_SHARED_ACROSS_CLUSTERS"));
  assert.ok(state.reasonCodes.includes("CLAIM_ID_SHARED_ACROSS_CLUSTERS"));
  assert.ok(state.reasonCodes.includes("SOURCE_ASSIGNED_TO_MULTIPLE_CLUSTERS"));
  assert.equal((await journal.findIncompleteRuns())[0].blocked, true);
  const recovery = createRecoveryManager({ storage, journal, userId: USER, clock: () => BASE + 1000, recoveryGraceMs: 1 });
  const recoveryPlan = await recovery.buildRecoveryPlan({ generatedAt: BASE + 1000 });
  assert.equal(recoveryPlan.actions.length, 0);
  assert.equal(recoveryPlan.blockedItems.length, 1);
  assert.deepEqual(await storage.loadMemories(USER), untouched);
});

test("event replay is idempotent and correlation key is deterministic", async t => {
  const journal = createHippocampusJournal({ directory: temp(t), userId: USER });
  const emit = emitter(journal, "run-replay");
  await emit("RUN_STARTED");
  const plan = planFor("A", [raw("ra")]);
  const input = {
    event_type: "SOURCES_CLAIMED", run_id: "run-replay", mode: "commit", phase: "synthesis", status: "recorded",
    timestamp: BASE + 100, cluster_id: "A", attempt_id: plan.attemptId, source_memory_ids: ["ra"], details: { claimPlan: createJournalSourceClaimDescriptor(plan) }
  };
  await journal.append(input);
  assert.equal((await journal.append(input)).idempotentReplay, true);
  const first = await journal.getRunState("run-replay");
  const second = await journal.getRunState("run-replay");
  assert.deepEqual(first, second);
  assert.match(first.clusters[0].correlationKey, /^[a-f0-9]{64}$/);
  assert.equal((await journal.getRunEvents("run-replay")).length, 2);
});

test("legacy ambiguous claim remains readable but recovery is blocked", async t => {
  const directory = temp(t);
  const storage = new JsonMemoryStorage(directory);
  await storage.saveMemories(USER, []);
  const journal = createHippocampusJournal({ directory, userId: USER });
  const emit = emitter(journal, "run-legacy");
  await emit("RUN_STARTED");
  await emit("SOURCES_CLAIMED", "legacy-cluster", { source_memory_ids: ["legacy-source"] });
  assert.equal((await journal.readAll()).length, 2);
  const state = await journal.getRunState("run-legacy");
  assert.equal(state.blocked, true);
  const recovery = createRecoveryManager({ storage, journal, userId: USER, clock: () => BASE + 1000, recoveryGraceMs: 1 });
  const plan = await recovery.buildRecoveryPlan({ generatedAt: BASE + 1000 });
  assert.equal(plan.actions.length, 0);
  assert.equal(plan.blockedItems[0].action, RECOVERY_ACTIONS.BLOCK_INCONSISTENT_STATE);
});

test("multi-cluster JSONL remains private recursively and on disk", async t => {
  const directory = temp(t);
  const journal = createHippocampusJournal({ directory, userId: USER });
  const emit = emitter(journal, "run-private");
  await emit("RUN_STARTED");
  await appendCommitted(emit, "A", planFor("A", [raw("pa")]));
  await appendClaim(emit, "B", planFor("B", [raw("pb")]));
  const serialized = JSON.stringify(await journal.reconstructRuns());
  assert.doesNotMatch(serialized, new RegExp(USER));
  assert.doesNotMatch(fs.readFileSync(path.join(directory, journal.fileName), "utf8"), new RegExp(USER));
  assert.equal((await journal.inspect()).legacyPrivacyDetected, false);
});
