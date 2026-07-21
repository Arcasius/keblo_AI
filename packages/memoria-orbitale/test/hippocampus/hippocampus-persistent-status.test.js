"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");

const JsonMemoryStorage = require("../../core/JsonMemoryStorage");
const { createProcessingState } = require("../../core/consolidation/ProcessingState");
const { selectConsolidationCandidates } = require("../../core/consolidation/CandidateSelector");
const { buildConsolidationPlan } = require("../../core/consolidation/ConsolidationPlan");
const { createClusterEngineAdapter } = require("../../core/clustering/ClusterEngineAdapter");
const {
  createSourceClaimPlan,
  createJournalSourceClaimDescriptor,
  claimSources,
  failClaimedSources
} = require("../../core/hippocampus/SourceClaimTransaction");
const { createHippocampusJournal } = require("../../core/hippocampus/HippocampusJournal");
const { createRecoveryManager } = require("../../core/hippocampus/RecoveryManager");
const {
  HIPPOCAMPUS_RECOVERY_STATES,
  createHippocampusDaemon
} = require("../../core/hippocampus/HippocampusDaemon");

const USER = "fix21-private-user-sentinel";
const PROVIDER_SENTINEL = "fix21-private-provider-message";
const BASE = 1950000000000;

function sha(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
function temp(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fix21-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function clock(start = BASE) {
  let value = start;
  return () => value++;
}
function raw(id, index = 0) {
  return {
    id,
    type: "episodic",
    content: { text: `synthetic source ${id}`, preserve: true },
    timestamp: BASE - 1000 - index,
    memoryKind: "raw",
    storageTier: "warm",
    embedding_ref: `embedding-${id}`,
    unknown: { preserve: true },
    processing: createProcessingState({
      state: "raw",
      revision: 0,
      attempt_id: null,
      updated_at: BASE - 2000,
      error: null
    })
  };
}
function embeddingProvider() {
  return {
    schemaVersion: 1,
    providerId: "synthetic-embedding",
    model: "embedding-v1",
    version: "1",
    async getEmbedding() { return [1, 0]; }
  };
}
function sourceIdsFromMessages(messages) {
  const user = messages.find(message => message.role === "user");
  return JSON.parse(user.content.split("\n")[1]).sources.map(source => source.id);
}
function modelProvider() {
  return {
    schemaVersion: 1,
    providerId: "synthetic-model",
    model: "model-v1",
    version: "1",
    async generate({ messages }) {
      const ids = sourceIdsFromMessages(messages);
      return {
        ok: true,
        status: 200,
        text: JSON.stringify({
          schema_version: 1,
          title: "Synthetic title",
          synthesis: "Synthetic synthesis",
          facts: [{ text: "Synthetic fact", source_memory_ids: [ids[0]] }],
          uncertainties: [],
          contradictions: [],
          source_memory_ids: ids,
          confidence: 0.8,
          rejected_source_ids: []
        })
      };
    }
  };
}
function event(eventType, runId, timestamp, fields = {}) {
  return {
    event_type: eventType,
    run_id: runId,
    mode: "commit",
    phase: "commit",
    status: "active",
    timestamp,
    details: {},
    ...fields
  };
}
function emptyInspection(overrides = {}) {
  return {
    journal: {
      valid: true,
      tailIncomplete: false,
      legacyPrivacyDetected: false,
      legacyPrivacyEventCount: 0,
      corruption: null
    },
    incompleteRuns: [],
    staleUserLock: { staleCandidate: false },
    recoveryRequired: false,
    ...overrides
  };
}
function createEnvironment(t, options = {}) {
  const directory = options.directory || temp(t);
  const storage = options.storage || new JsonMemoryStorage(directory);
  const runtimeClock = options.clock || clock();
  const journal = options.journal || createHippocampusJournal({ directory, userId: USER, clock: runtimeClock });
  const recoveryManager = options.recoveryManager || createRecoveryManager({
    storage,
    journal,
    userId: USER,
    clock: runtimeClock,
    recoveryGraceMs: 0
  });
  const daemon = createHippocampusDaemon({
    storage,
    userId: USER,
    clock: runtimeClock,
    idGenerator: () => "fix21-run",
    journal,
    recoveryManager,
    ...options.daemonOptions
  });
  return { directory, storage, journal, recoveryManager, daemon, clock: runtimeClock };
}
async function appendClaimLifecycle(state, options = {}) {
  const runId = options.runId || "incomplete-run";
  const clusterId = options.clusterId || "cluster-incomplete";
  const source = raw(options.sourceId || "source-incomplete");
  await state.storage.saveMemories(USER, [source]);
  const attemptId = `${runId}:${clusterId}`;
  const claimPlan = createSourceClaimPlan({
    userId: USER,
    sourceMemories: [source],
    sourceIds: [source.id],
    attemptId,
    claimedAt: BASE + 3,
    sourceContentHashes: { [source.id]: sha(source.content.text) }
  });
  await claimSources({ storage: state.storage, plan: claimPlan });
  const common = {
    cluster_id: clusterId,
    attempt_id: attemptId,
    source_memory_ids: [source.id]
  };
  await state.journal.append(event("RUN_STARTED", runId, BASE));
  await state.journal.append(event("CLUSTER_SELECTED", runId, BASE + 1, { cluster_id: clusterId, source_memory_ids: [source.id] }));
  await state.journal.append(event("CLUSTER_PERSISTED", runId, BASE + 2, { cluster_id: clusterId, details: { clusterRecordId: clusterId } }));
  await state.journal.append(event("SOURCES_CLAIMED", runId, BASE + 3, {
    ...common,
    details: { claimPlan: createJournalSourceClaimDescriptor(claimPlan) }
  }));
  await state.journal.append(event("SYNTHESIS_STARTED", runId, BASE + 4, common));
  if (options.persistFailure) {
    await state.journal.append(event("SYNTHESIS_FAILED", runId, BASE + 5, {
      ...common,
      details: { errorCode: "SYNTHESIS_TIMEOUT", claimId: claimPlan.claimId }
    }));
    await failClaimedSources({
      storage: state.storage,
      plan: claimPlan,
      failedAt: BASE + 6,
      error: {
        code: "HIPPOCAMPUS_CLUSTER_FAILED",
        message: "Cluster processing failed after source claim",
        retryable: true
      }
    });
  }
  return { runId, clusterId, source, claimPlan };
}
function assertPrivateFree(value) {
  const rawValue = JSON.stringify(value);
  assert.doesNotMatch(rawValue, new RegExp(USER));
  assert.doesNotMatch(rawValue, new RegExp(PROVIDER_SENTINEL));
  assert.doesNotMatch(rawValue, /synthetic source|prompt|raw_output|sourceSnapshot/i);
}

test("new daemon status is conservatively unknown until explicit refresh", () => {
  const storage = { async loadMemories() { return []; } };
  const daemon = createHippocampusDaemon({ storage, userId: USER, clock: clock(), idGenerator: () => "run" });
  const status = daemon.getStatus();
  assert.equal(status.statusHydrated, false);
  assert.equal(status.recoveryState, HIPPOCAMPUS_RECOVERY_STATES.UNKNOWN);
  assert.equal(status.recoveryRequired, null);
  assert.equal(status.incompleteRunCount, null);
  assert.equal(Object.isFrozen(status), true);
  assert.throws(() => { status.recoveryRequired = false; }, TypeError);
  assert.equal(daemon.getStatus().recoveryRequired, null);
});

test("empty valid journal hydrates ready and repeated refresh is idempotent", async t => {
  const state = createEnvironment(t);
  const first = await state.daemon.refreshStatus();
  const second = await state.daemon.refreshStatus();
  assert.equal(first.statusHydrated, true);
  assert.equal(first.recoveryState, HIPPOCAMPUS_RECOVERY_STATES.READY);
  assert.equal(first.recoveryRequired, false);
  assert.equal(first.incompleteRunCount, 0);
  assert.equal(second.recoveryState, first.recoveryState);
  assert.equal(second.incompleteRunCount, 0);
  assert.equal(Object.isFrozen(second), true);
});

test("restart hydrates an incomplete persisted run instead of resetting ready", async t => {
  const state = createEnvironment(t);
  await state.journal.append(event("RUN_STARTED", "persisted-incomplete", BASE));
  const restarted = createEnvironment(t, { directory: state.directory, storage: state.storage, clock: clock(BASE + 100) });
  assert.equal(restarted.daemon.getStatus().recoveryState, "unknown");
  const status = await restarted.daemon.refreshStatus();
  assert.equal(status.recoveryState, HIPPOCAMPUS_RECOVERY_STATES.RECOVERY_REQUIRED);
  assert.equal(status.recoveryRequired, true);
  assert.equal(status.incompleteRunCount, 1);
});

test("multi-cluster restart keeps committed A separate from claimed B", async t => {
  const state = createEnvironment(t);
  const claimed = await appendClaimLifecycle(state, { runId: "multi-run", clusterId: "cluster-b", sourceId: "source-b" });
  const clusterA = "cluster-a";
  const commonA = { cluster_id: clusterA, attempt_id: "multi-run:cluster-a", source_memory_ids: ["source-a"] };
  await state.journal.append(event("CLUSTER_SELECTED", "multi-run", BASE + 20, { cluster_id: clusterA, source_memory_ids: ["source-a"] }));
  await state.journal.append(event("CLUSTER_PERSISTED", "multi-run", BASE + 21, { cluster_id: clusterA, details: { clusterRecordId: clusterA } }));
  const sourceA = raw("source-a");
  const planA = createSourceClaimPlan({ userId: USER, sourceMemories: [sourceA], sourceIds: [sourceA.id], attemptId: commonA.attempt_id, claimedAt: BASE + 22, sourceContentHashes: { [sourceA.id]: sha(sourceA.content.text) } });
  await state.journal.append(event("SOURCES_CLAIMED", "multi-run", BASE + 22, { ...commonA, details: { claimPlan: createJournalSourceClaimDescriptor(planA) } }));
  await state.journal.append(event("SYNTHESIS_STARTED", "multi-run", BASE + 23, commonA));
  await state.journal.append(event("SYNTHESIS_SUCCEEDED", "multi-run", BASE + 24, commonA));
  await state.journal.append(event("COMMIT_STARTED", "multi-run", BASE + 25, { ...commonA, transaction_id: "tx-a" }));
  await state.journal.append(event("COMMIT_SUCCEEDED", "multi-run", BASE + 26, { ...commonA, transaction_id: "tx-a" }));
  const restarted = createEnvironment(t, { directory: state.directory, storage: state.storage, clock: clock(BASE + 100) });
  const status = await restarted.daemon.refreshStatus();
  assert.equal(status.incompleteRunCount, 1);
  assert.equal(status.recoveryRequired, true);
  const run = (await state.journal.findIncompleteRuns())[0];
  assert.deepEqual(run.terminalClusters, [clusterA]);
  assert.deepEqual(run.incompleteClusters, [claimed.clusterId]);
});

test("persisted source failure without ACK is needs_reconciliation after restart", async t => {
  const state = createEnvironment(t);
  await appendClaimLifecycle(state, { runId: "failed-ack-run", persistFailure: true });
  const restarted = createEnvironment(t, { directory: state.directory, storage: state.storage, clock: clock(BASE + 100) });
  const status = await restarted.daemon.refreshStatus();
  assert.equal(status.recoveryState, HIPPOCAMPUS_RECOVERY_STATES.NEEDS_RECONCILIATION);
  assert.equal(status.recoveryRequired, true);
  assert.equal(status.incompleteRunCount, 1);
});

test("valid storage commit without journal ACK remains needs_reconciliation", async t => {
  const state = createEnvironment(t);
  const memories = [raw("commit-a"), raw("commit-b"), raw("commit-c")];
  await state.storage.saveMemories(USER, memories);
  const selection = selectConsolidationCandidates(memories);
  const plan = buildConsolidationPlan(selection);
  const cluster = (await createClusterEngineAdapter({ embeddingProvider: embeddingProvider() }).buildClusterCandidates({ consolidationPlan: plan, memories })).clusters[0];
  let failed = false;
  const wrapper = {
    ...state.journal,
    async append(input) {
      if (input.event_type === "COMMIT_SUCCEEDED" && !failed) {
        failed = true;
        throw new Error(PROVIDER_SENTINEL);
      }
      return state.journal.append(input);
    }
  };
  const daemon = createHippocampusDaemon({
    storage: state.storage,
    userId: USER,
    embeddingProvider: embeddingProvider(),
    modelProvider: modelProvider(),
    clock: clock(BASE + 200),
    idGenerator: () => "commit-ack-run",
    commitEnabled: true,
    journal: wrapper,
    recoveryManager: state.recoveryManager
  });
  const report = await daemon.runOnce({
    mode: "commit",
    phase: "commit",
    confirmCommit: "COMMIT_HIPPOCAMPUS_V1",
    maxClustersPerRun: 1,
    approvedClusterIds: [cluster.clusterId]
  });
  assert.equal(report.status, "needs_reconciliation");
  const restarted = createEnvironment(t, { directory: state.directory, storage: state.storage, clock: clock(BASE + 500) });
  const status = await restarted.daemon.refreshStatus();
  assert.equal(status.recoveryState, HIPPOCAMPUS_RECOVERY_STATES.NEEDS_RECONCILIATION);
  assert.equal(status.incompleteRunCount, 1);
  assert.equal((await state.storage.loadMemories(USER)).filter(memory => memory.memoryKind === "super_memory").length, 1);
  assertPrivateFree({ report, status });
});

test("successful recovery hydrates ready after restart and stays ready in a third instance", async t => {
  const state = createEnvironment(t);
  await appendClaimLifecycle(state, { runId: "recover-run", persistFailure: true });
  const plan = await state.recoveryManager.buildRecoveryPlan({ generatedAt: BASE + 100 });
  const result = await state.recoveryManager.executeRecovery({
    plan,
    execute: true,
    confirmRecovery: "RECOVER_HIPPOCAMPUS_V1"
  });
  assert.equal(result.status, "completed");
  const second = createEnvironment(t, { directory: state.directory, storage: state.storage, clock: clock(BASE + 200) });
  const secondStatus = await second.daemon.refreshStatus();
  assert.equal(secondStatus.recoveryState, HIPPOCAMPUS_RECOVERY_STATES.READY);
  assert.equal(secondStatus.incompleteRunCount, 0);
  const third = createEnvironment(t, { directory: state.directory, storage: state.storage, clock: clock(BASE + 300) });
  assert.equal((await third.daemon.refreshStatus()).recoveryRequired, false);
});

test("ambiguous and corrupt journals fail closed and reject commit", async t => {
  await t.test("ambiguous", async () => {
    const state = createEnvironment(t);
    await state.journal.append(event("RUN_STARTED", "ambiguous-run", BASE));
    await state.journal.append(event("CLUSTER_SELECTED", "ambiguous-run", BASE + 1, { cluster_id: "cluster-a" }));
    await state.journal.append(event("RUN_COMPLETED", "ambiguous-run", BASE + 2));
    const status = await state.daemon.refreshStatus();
    assert.equal(status.recoveryState, HIPPOCAMPUS_RECOVERY_STATES.BLOCKED);
    await assert.rejects(state.daemon.runOnce({ mode: "commit", phase: "commit", confirmCommit: "COMMIT_HIPPOCAMPUS_V1", maxClustersPerRun: 1 }), { code: "COMMIT_NOT_ENABLED" });
    const enabled = createHippocampusDaemon({ storage: state.storage, userId: USER, clock: clock(BASE + 20), commitEnabled: true, journal: state.journal, recoveryManager: state.recoveryManager });
    await assert.rejects(enabled.runOnce({ mode: "commit", phase: "commit", confirmCommit: "COMMIT_HIPPOCAMPUS_V1", maxClustersPerRun: 1 }), { code: "RECOVERY_STATUS_BLOCKED" });
  });
  await t.test("corrupt", async () => {
    const state = createEnvironment(t);
    await state.journal.append(event("RUN_STARTED", "corrupt-run", BASE));
    await state.journal.append(event("PLAN_COMPLETED", "corrupt-run", BASE + 1));
    const file = path.join(state.directory, state.journal.fileName);
    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    fs.writeFileSync(file, `${lines[0]}\nnot-json\n${lines[1]}\n`);
    const status = await state.daemon.refreshStatus();
    assert.equal(status.recoveryState, HIPPOCAMPUS_RECOVERY_STATES.CORRUPT);
    assert.equal(status.journalValid, false);
    const enabled = createHippocampusDaemon({ storage: state.storage, userId: USER, clock: clock(BASE + 20), commitEnabled: true, journal: state.journal, recoveryManager: state.recoveryManager });
    await assert.rejects(enabled.runOnce({ mode: "commit", phase: "commit", confirmCommit: "COMMIT_HIPPOCAMPUS_V1", maxClustersPerRun: 1 }), { code: "RECOVERY_STATUS_CORRUPT" });
  });
});

test("truncated tail and stale lock are reported without automatic repair", async t => {
  await t.test("tail", async () => {
    const state = createEnvironment(t);
    await state.journal.append(event("RUN_STARTED", "tail-run", BASE));
    const file = path.join(state.directory, state.journal.fileName);
    fs.appendFileSync(file, '{"partial"');
    const before = fs.readFileSync(file, "utf8");
    const status = await state.daemon.refreshStatus();
    assert.equal(status.tailRepairRequired, true);
    assert.equal(status.recoveryState, HIPPOCAMPUS_RECOVERY_STATES.BLOCKED);
    assert.equal(fs.readFileSync(file, "utf8"), before);
  });
  await t.test("stale lock", async () => {
    const state = createEnvironment(t);
    const lockDirectory = path.join(state.directory, ".locks");
    fs.mkdirSync(lockDirectory, { recursive: true });
    const lockFile = path.join(lockDirectory, `${sha(`user:${USER}`)}.lock`);
    fs.writeFileSync(lockFile, JSON.stringify({ schemaVersion: 1, token: "synthetic", ownerId: "synthetic", pid: 99999999, host: os.hostname(), createdAt: 0 }));
    const status = await state.daemon.refreshStatus();
    assert.equal(status.staleLockDetected, true);
    assert.equal(status.recoveryRequired, true);
    assert.equal(fs.existsSync(lockFile), true);
  });
});

test("commit preflight refreshes persistent state instead of trusting ready cache", async () => {
  let inspections = 0;
  const recoveryManager = {
    async inspect() {
      inspections++;
      return inspections === 1
        ? emptyInspection()
        : emptyInspection({ incompleteRuns: [{ runId: "new-incomplete", blocked: false, reasonCodes: [] }], recoveryRequired: true });
    }
  };
  const journal = { async append() {}, async getRunState() { return null; } };
  const storage = { async loadMemories() { throw new Error("preflight must stop before storage"); } };
  const daemon = createHippocampusDaemon({ storage, userId: USER, clock: clock(), commitEnabled: true, journal, recoveryManager });
  assert.equal((await daemon.refreshStatus()).recoveryState, "ready");
  await assert.rejects(daemon.runOnce({ mode: "commit", phase: "commit", confirmCommit: "COMMIT_HIPPOCAMPUS_V1", maxClustersPerRun: 1 }), { code: "RECOVERY_REQUIRED" });
  assert.equal(inspections, 2);
  assert.equal(daemon.getStatus().incompleteRunCount, 1);
});

test("dry-run refreshes status read-only and reports persistent recovery state", async t => {
  const state = createEnvironment(t);
  const before = fs.readdirSync(state.directory).sort();
  const report = await state.daemon.runOnce();
  assert.equal(report.dryRun, true);
  assert.equal(report.writesAttempted, 0);
  assert.equal(report.recoveryStatus.recoveryState, "ready");
  assert.equal(state.daemon.getStatus().statusHydrated, true);
  assert.deepEqual(fs.readdirSync(state.directory).sort(), before);
});

test("concurrent refresh completion cannot let an older inspection overwrite a newer one", async () => {
  const resolvers = [];
  const recoveryManager = { inspect: () => new Promise(resolve => resolvers.push(resolve)) };
  const daemon = createHippocampusDaemon({ storage: {}, userId: USER, clock: clock(), recoveryManager });
  const older = daemon.refreshStatus();
  const newer = daemon.refreshStatus();
  assert.equal(resolvers.length, 2);
  resolvers[1](emptyInspection());
  await newer;
  resolvers[0](emptyInspection({ incompleteRuns: [{ runId: "stale-result", blocked: false, reasonCodes: [] }], recoveryRequired: true }));
  await older;
  const status = daemon.getStatus();
  assert.equal(status.recoveryState, "ready");
  assert.equal(status.incompleteRunCount, 0);
});

test("inspection failure and legacy privacy remain conservative and sanitized", async () => {
  const failedManager = { async inspect() { throw new Error(PROVIDER_SENTINEL); } };
  const failed = createHippocampusDaemon({ storage: {}, userId: USER, clock: clock(), recoveryManager: failedManager });
  const failedStatus = await failed.refreshStatus();
  assert.equal(failedStatus.recoveryState, "blocked");
  assert.equal(failedStatus.reasonCode, "STATUS_INSPECTION_FAILED");
  assertPrivateFree(failedStatus);
  const guarded = createHippocampusDaemon({
    storage: {},
    userId: USER,
    clock: clock(BASE + 10),
    commitEnabled: true,
    journal: { async append() {}, async getRunState() { return null; } },
    recoveryManager: failedManager
  });
  await assert.rejects(
    guarded.runOnce({ mode: "commit", phase: "commit", confirmCommit: "COMMIT_HIPPOCAMPUS_V1", maxClustersPerRun: 1 }),
    error => {
      assert.equal(error.code, "RECOVERY_STATUS_BLOCKED");
      assertPrivateFree({ code: error.code, phase: error.phase, reasonCode: error.reasonCode, message: error.message });
      return true;
    }
  );

  const legacy = createHippocampusDaemon({
    storage: {},
    userId: USER,
    clock: clock(BASE + 20),
    recoveryManager: {
      async inspect() {
        return emptyInspection({
          journal: { ...emptyInspection().journal, legacyPrivacyDetected: true, legacyPrivacyEventCount: 2 }
        });
      }
    }
  });
  const legacyStatus = await legacy.refreshStatus();
  assert.equal(legacyStatus.legacyPrivacyDetected, true);
  assert.equal(legacyStatus.legacyPrivacyEventCount, 2);
  assertPrivateFree(legacyStatus);
});
