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
  claimSources
} = require("../../core/hippocampus/SourceClaimTransaction");
const { createHippocampusJournal } = require("../../core/hippocampus/HippocampusJournal");
const { createRecoveryManager, RECOVERY_ACTIONS } = require("../../core/hippocampus/RecoveryManager");
const { createHippocampusDaemon } = require("../../core/hippocampus/HippocampusDaemon");

const USER = "fix20-private-user-sentinel";
const OTHER_USER = "fix20-other-private-user";
const PROVIDER_SENTINEL = "provider-private-message-sentinel";
const BASE = 1940000000000;
const sha = value => createHash("sha256").update(value, "utf8").digest("hex");

const REQUIRED_SCENARIOS = Object.freeze([
  "A01", "A02", "A03", "A04", "A05", "A06",
  "B07", "B08", "B09", "B10", "B11", "B12", "B13",
  "C14", "C15", "C16", "C17", "C18", "C19", "C20",
  "D21", "D22", "D23", "D24", "D25", "D26",
  "E27", "E28", "E29", "E30", "E31", "E32", "E33", "E34",
  "F35", "F36", "F37", "F38", "F39",
  "G40", "G41", "G42", "G43", "G44", "G45"
]);
const registeredScenarios = new Map();

function matrixTest(name, scenarioIds, callback) {
  for (const id of scenarioIds) {
    if (!REQUIRED_SCENARIOS.includes(id)) throw new Error(`Unknown matrix scenario ${id}`);
    if (registeredScenarios.has(id)) throw new Error(`Duplicate matrix scenario ${id}`);
    registeredScenarios.set(id, name);
  }
  test(`[${scenarioIds.join(",")}] ${name}`, callback);
}
function stable(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
}
function temp(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fix20-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function clock(start = BASE) {
  let value = start;
  return () => value++;
}
function raw(id, index = 0, userId = USER) {
  return {
    id,
    type: "episodic",
    content: { text: `synthetic source ${id}`, preserve: true },
    timestamp: BASE - 1000 - index,
    memoryKind: "raw",
    storageTier: "warm",
    tags: ["preserve"],
    unknown: { preserve: true },
    meta: { user_id: userId, preserve: true },
    processing: createProcessingState({
      state: "raw", revision: 0, attempt_id: null, updated_at: BASE - 2000, error: null
    })
  };
}
function embeddingProvider(clusterCount) {
  return {
    schemaVersion: 1,
    providerId: "synthetic-embedding",
    model: "embedding-v1",
    version: "1",
    async getEmbedding({ memoryId }) {
      const group = Number(memoryId.split("-")[1]);
      return Array.from({ length: Math.max(2, clusterCount) }, (_, index) => index === group ? 1 : 0);
    }
  };
}
function sourceIdsFromMessages(messages) {
  const lines = messages.find(message => message.role === "user").content.split("\n");
  const payload = JSON.parse(lines[1]);
  return payload.sources.map(source => source.id);
}
function validOutput(ids, rejected = []) {
  const used = ids.filter(id => !rejected.includes(id));
  return {
    schema_version: 1,
    title: "Synthetic title",
    synthesis: "Synthetic synthesis",
    facts: [{ text: "Synthetic fact", source_memory_ids: [used[0]] }],
    uncertainties: [],
    contradictions: [],
    source_memory_ids: used,
    confidence: 0.8,
    rejected_source_ids: rejected
  };
}
function modelProvider(behavior) {
  return {
    schemaVersion: 1,
    providerId: "synthetic-model",
    model: "model-v1",
    version: "1",
    async generate(request) {
      const ids = sourceIdsFromMessages(request.messages);
      if (behavior) return behavior({ ...request, ids });
      return { ok: true, status: 200, text: JSON.stringify(validOutput(ids)) };
    }
  };
}
function memoriesForClusters(clusterCount, userId = USER) {
  return Array.from({ length: clusterCount }, (_, group) =>
    Array.from({ length: 3 }, (_, member) => raw(`m-${group}-${member}`, group * 3 + member, userId))
  ).flat();
}
async function candidatesFor(memories, provider) {
  const plan = buildConsolidationPlan(selectConsolidationCandidates(memories));
  return (await createClusterEngineAdapter({ embeddingProvider: provider }).buildClusterCandidates({
    consolidationPlan: plan,
    memories
  })).clusters;
}
async function daemonEnvironment(t, options = {}) {
  const directory = options.directory || temp(t);
  const userId = options.userId || USER;
  const clusterCount = options.clusterCount || 1;
  const storage = options.storage || new JsonMemoryStorage(directory);
  const memories = options.memories || memoriesForClusters(clusterCount, userId);
  await storage.saveMemories(userId, memories);
  const embed = embeddingProvider(clusterCount);
  const clusters = await candidatesFor(memories, embed);
  const runtimeClock = clock(options.clockStart || BASE);
  const journal = createHippocampusJournal({ directory, userId, clock: runtimeClock });
  const recoveryManager = createRecoveryManager({ storage, journal, userId, clock: runtimeClock, recoveryGraceMs: 0 });
  const daemonJournal = options.wrapJournal ? options.wrapJournal(journal) : journal;
  const daemonStorage = options.wrapStorage ? options.wrapStorage(storage) : storage;
  const daemon = createHippocampusDaemon({
    storage: daemonStorage,
    userId,
    embeddingProvider: embed,
    modelProvider: modelProvider(options.modelBehavior),
    synthesisLimits: options.synthesisLimits,
    clock: runtimeClock,
    idGenerator: () => options.runId || "run-composition",
    commitEnabled: true,
    journal: daemonJournal,
    recoveryManager
  });
  return { directory, userId, storage, memories, clusters, journal, recoveryManager, daemon };
}
function commitRequest(state, overrides = {}) {
  return {
    mode: "commit",
    phase: "commit",
    confirmCommit: "COMMIT_HIPPOCAMPUS_V1",
    maxClustersPerRun: state.clusters.length,
    approvedClusterIds: state.clusters.map(cluster => cluster.clusterId),
    ...overrides
  };
}
function storageProxy(storage, overrides = {}) {
  return new Proxy(storage, {
    get(target, property) {
      if (Object.hasOwn(overrides, property)) return overrides[property];
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}
function deferred() {
  let resolve;
  const promise = new Promise(res => { resolve = res; });
  return { promise, resolve };
}
async function nextTurn() {
  await new Promise(resolve => setImmediate(resolve));
}
function claimPlan(userId, clusterId, memories) {
  return createSourceClaimPlan({
    userId,
    sourceMemories: memories,
    sourceIds: memories.map(memory => memory.id),
    attemptId: `attempt-${clusterId}`,
    claimedAt: BASE,
    sourceContentHashes: Object.fromEntries(memories.map(memory => [memory.id, sha(memory.content.text)]))
  });
}
async function claimedEnvironment(t, { count = 1, userId = USER, directory, storage } = {}) {
  directory ||= temp(t);
  storage ||= new JsonMemoryStorage(directory);
  const memories = Array.from({ length: count }, (_, index) => raw(`claimed-${index}`, index, userId));
  await storage.saveMemories(userId, memories);
  const plans = memories.map((memory, index) => claimPlan(userId, `c-${index}`, [memory]));
  for (const plan of plans) await claimSources({ storage, plan });
  const journal = createHippocampusJournal({ directory, userId, clock: () => BASE + 1000 });
  await journal.append({ event_type: "RUN_STARTED", run_id: "run-claimed", mode: "commit", phase: "commit", status: "started", timestamp: BASE - 100, details: {} });
  for (let index = 0; index < plans.length; index++) {
    const plan = plans[index];
    await journal.append({
      event_type: "SOURCES_CLAIMED", run_id: "run-claimed", mode: "commit", phase: "synthesis",
      status: "claimed", timestamp: BASE - 90 + index, cluster_id: `c-${index}`,
      attempt_id: plan.attemptId, source_memory_ids: plan.sources.map(source => source.memoryId),
      details: { claimPlan: createJournalSourceClaimDescriptor(plan) }
    });
  }
  const recovery = createRecoveryManager({ storage, journal, userId, clock: () => BASE + 2000, recoveryGraceMs: 0 });
  const recoveryPlan = await recovery.buildRecoveryPlan({ generatedAt: BASE + 3000 });
  return { directory, userId, storage, memories, plans, journal, recovery, recoveryPlan };
}
function executeRecovery(recovery, plan, extra = {}) {
  return recovery.executeRecovery({ plan, execute: true, confirmRecovery: "RECOVER_HIPPOCAMPUS_V1", ...extra });
}
function assertJournalIntegrity(events) {
  assert.deepEqual(events.map(event => event.sequence), Array.from({ length: events.length }, (_, index) => index + 1));
  for (const event of events) {
    assert.match(event.event_id, /^[a-f0-9]{64}$/);
    assert.match(event.event_fingerprint, /^[a-f0-9]{64}$/);
    assert.equal(Object.isFrozen(event), true);
  }
}
function assertNoPrivatePayload(value, seen = new WeakSet()) {
  if (typeof value === "string") {
    assert.doesNotMatch(value, new RegExp(`${USER}|${PROVIDER_SENTINEL}|synthetic source`, "i"));
    return;
  }
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    assert.equal(["text", "content", "prompt", "messages", "rawoutput", "embedding", "centroid", "sourcesnapshot"].includes(normalized), false, `private field ${key}`);
    assertNoPrivatePayload(child, seen);
  }
}
function legacyRecord(input, sequence) {
  const normalized = {
    event_type: input.event_type,
    run_id: input.run_id,
    mode: input.mode ?? null,
    phase: input.phase ?? null,
    status: input.status ?? null,
    timestamp: input.timestamp,
    cluster_id: input.cluster_id ?? null,
    transaction_id: input.transaction_id ?? null,
    attempt_id: input.attempt_id ?? null,
    source_memory_ids: [...(input.source_memory_ids || [])].sort(),
    details: input.details || {}
  };
  const record = {
    schema_version: 1,
    event_id: sha(stable(normalized)),
    event_type: normalized.event_type,
    sequence,
    run_id: normalized.run_id,
    mode: normalized.mode,
    phase: normalized.phase,
    status: normalized.status,
    timestamp: normalized.timestamp,
    cluster_id: normalized.cluster_id,
    transaction_id: normalized.transaction_id,
    attempt_id: normalized.attempt_id,
    source_memory_ids: normalized.source_memory_ids,
    details: normalized.details,
    event_fingerprint: ""
  };
  record.event_fingerprint = sha(stable({ ...record, event_fingerprint: undefined }));
  return record;
}

matrixTest("single-cluster happy path is deterministic, immutable and raw-preserving", ["A01", "A04", "A05", "A06"], async t => {
  const first = await daemonEnvironment(t);
  const firstReport = await first.daemon.runOnce(commitRequest(first));
  assert.equal(firstReport.status, "completed");
  assert.equal(Object.isFrozen(firstReport), true);
  const firstMemories = await first.storage.loadMemories(USER);
  const firstSuper = firstMemories.find(memory => memory.memoryKind === "super_memory");
  assert.ok(firstSuper);
  for (const original of first.memories) {
    const current = firstMemories.find(memory => memory.id === original.id);
    assert.deepEqual(current.content, original.content);
    assert.equal(current.timestamp, original.timestamp);
    assert.deepEqual(current.tags, original.tags);
    assert.deepEqual(current.unknown, original.unknown);
    assert.equal(current.processing.state, "consolidated");
    assert.equal(current.processing.revision, 3);
  }
  const state = await first.journal.getRunState(firstReport.runId);
  assert.equal(state.complete, true);
  assert.deepEqual(state.terminalClusters, [first.clusters[0].clusterId]);
  assertJournalIntegrity(await first.journal.readAll());

  const second = await daemonEnvironment(t);
  await second.daemon.runOnce(commitRequest(second));
  const secondSuper = (await second.storage.loadMemories(USER)).find(memory => memory.memoryKind === "super_memory");
  assert.equal(secondSuper.id, firstSuper.id);
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, "../../core/consolidation/ConsolidationTransaction.js"), "utf8"), /ColdMemoryCompressor/);
});

matrixTest("two clusters complete independently in one terminal run", ["A02"], async t => {
  const state = await daemonEnvironment(t, { clusterCount: 2 });
  const report = await state.daemon.runOnce(commitRequest(state));
  assert.equal(report.commitStats.committed, 2);
  assert.equal((await state.storage.loadMemories(USER)).filter(memory => memory.memoryKind === "super_memory").length, 2);
  const run = await state.journal.getRunState(report.runId);
  assert.equal(run.complete, true);
  assert.equal(run.terminalClusters.length, 2);
});

matrixTest("twelve clusters commit without an implicit top five", ["A03"], async t => {
  const state = await daemonEnvironment(t, { clusterCount: 12 });
  const report = await state.daemon.runOnce(commitRequest(state));
  assert.equal(report.clusterStats.clusterCount, 12);
  assert.equal(report.commitStats.committed, 12);
  assert.equal((await state.storage.loadMemories(USER)).filter(memory => memory.memoryKind === "super_memory").length, 12);
  assert.equal((await state.journal.getRunState(report.runId)).terminalClusters.length, 12);
});

matrixTest("provider failure on A does not hide successful B when continuation is explicit", ["B07", "B12", "B13"], async t => {
  let failingId;
  const state = await daemonEnvironment(t, {
    clusterCount: 2,
    modelBehavior: async ({ ids }) => {
      if (ids.includes(failingId)) throw new Error(PROVIDER_SENTINEL);
      return { ok: true, status: 200, text: JSON.stringify(validOutput(ids)) };
    }
  });
  failingId = state.clusters[0].memberIds[0];
  const report = await state.daemon.runOnce(commitRequest(state, { continueOnClusterFailure: true }));
  assert.equal(report.status, "failed");
  assert.equal(report.commitStats.committed, 1);
  const failedCluster = state.clusters[0];
  for (const id of failedCluster.memberIds) {
    const memory = await state.storage.getMemory(USER, id);
    assert.equal(memory.processing.state, "failed");
    assert.equal(memory.processing.revision, 3);
    assert.equal(memory.processing.error.code, "HIPPOCAMPUS_CLUSTER_FAILED");
  }
  const events = await state.journal.readAll();
  const failedEvents = events.filter(event => event.cluster_id === failedCluster.clusterId).map(event => event.event_type);
  assert.ok(failedEvents.indexOf("SYNTHESIS_FAILED") < failedEvents.indexOf("SOURCES_FAILED"));
  assert.equal((await state.journal.getRunState(report.runId)).classification, "FAILED_COMPLETE");
});

matrixTest("successful A and failed B remain separately terminal; stop policy leaves later raw", ["B08", "B09"], async t => {
  let failingId;
  const continued = await daemonEnvironment(t, {
    clusterCount: 2,
    modelBehavior: async ({ ids }) => {
      if (ids.includes(failingId)) throw new Error(PROVIDER_SENTINEL);
      return { ok: true, status: 200, text: JSON.stringify(validOutput(ids)) };
    }
  });
  failingId = continued.clusters[1].memberIds[0];
  const continuedReport = await continued.daemon.runOnce(commitRequest(continued, { continueOnClusterFailure: true }));
  assert.equal(continuedReport.commitStats.committed, 1);
  assert.equal((await continued.journal.getRunState(continuedReport.runId)).terminalClusters.length, 2);

  let stopId;
  const stopped = await daemonEnvironment(t, {
    clusterCount: 2,
    runId: "run-stop",
    clockStart: BASE + 10000,
    modelBehavior: async ({ ids }) => {
      if (ids.includes(stopId)) throw new Error(PROVIDER_SENTINEL);
      return { ok: true, status: 200, text: JSON.stringify(validOutput(ids)) };
    }
  });
  stopId = stopped.clusters[0].memberIds[0];
  const stoppedReport = await stopped.daemon.runOnce(commitRequest(stopped));
  assert.equal(stoppedReport.failures.length, 1);
  for (const id of stopped.clusters[1].memberIds) assert.equal((await stopped.storage.getMemory(USER, id)).processing.state, "raw");
});

matrixTest("timeout and invalid JSON/schema/provenance close with sanitized lifecycle", ["B10", "B11"], async t => {
  await t.test("timeout", async () => {
    const state = await daemonEnvironment(t, {
      runId: "run-timeout",
      synthesisLimits: { timeoutMs: 5 },
      modelBehavior: async ({ signal }) => new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(new Error(PROVIDER_SENTINEL)), { once: true }))
    });
    const report = await state.daemon.runOnce(commitRequest(state));
    assert.equal(report.failures[0].code, "SYNTHESIS_TIMEOUT");
    assert.doesNotMatch(JSON.stringify(report), new RegExp(PROVIDER_SENTINEL));
  });
  for (const [runId, behavior] of [
    ["run-json", async () => ({ ok: true, status: 200, text: "{invalid" })],
    ["run-schema", async ({ ids }) => ({ ok: true, status: 200, text: JSON.stringify({ ...validOutput(ids), confidence: 2 }) })]
  ]) {
    const state = await daemonEnvironment(t, { runId, clockStart: BASE + runId.length * 1000, modelBehavior: behavior });
    const report = await state.daemon.runOnce(commitRequest(state));
    assert.equal(report.status, "failed");
    assert.deepEqual((await state.journal.readAll()).map(event => event.event_type).slice(-4), ["SYNTHESIS_STARTED", "SYNTHESIS_FAILED", "SOURCES_FAILED", "RUN_FAILED"]);
  }
});

matrixTest("claimed crash is reconstructed after restart and repeated recovery is idempotent", ["C14", "C18", "C19", "C20"], async t => {
  const state = await claimedEnvironment(t);
  const restartedJournal = createHippocampusJournal({ directory: state.directory, userId: USER, clock: () => BASE + 4000 });
  const restarted = createRecoveryManager({ storage: state.storage, journal: restartedJournal, userId: USER, clock: () => BASE + 4000, recoveryGraceMs: 0 });
  const plan = await restarted.buildRecoveryPlan({ generatedAt: BASE + 5000 });
  assert.equal(plan.actions.some(action => action.action === RECOVERY_ACTIONS.MARK_INTERRUPTED_CLAIM_FAILED), true);
  await executeRecovery(restarted, plan);
  const revision = (await state.storage.getMemory(USER, state.memories[0].id)).processing.revision;
  const next = await restarted.buildRecoveryPlan({ generatedAt: BASE + 6000 });
  assert.equal(next.actions.length, 0);
  assert.equal((await state.storage.getMemory(USER, state.memories[0].id)).processing.revision, revision);
  assert.equal((await state.storage.loadMemories(USER)).filter(memory => memory.memoryKind === "super_memory").length, 0);
});

matrixTest("pre-mutation append loss and missing SOURCES_FAILED ACK reconcile storage-first", ["C15", "C16"], async t => {
  let failCause = true;
  const beforeMutation = await daemonEnvironment(t, {
    runId: "run-before-mutation",
    modelBehavior: async () => { throw new Error(PROVIDER_SENTINEL); },
    wrapJournal: journal => ({
      ...journal,
      append: async event => {
        if (failCause && event.event_type === "SYNTHESIS_FAILED") { failCause = false; throw new Error("append failure"); }
        return journal.append(event);
      }
    })
  });
  const report = await beforeMutation.daemon.runOnce(commitRequest(beforeMutation));
  assert.equal(report.status, "needs_reconciliation");
  for (const memory of beforeMutation.memories) assert.equal((await beforeMutation.storage.getMemory(USER, memory.id)).processing.state, "synthesizing");

  let failAck = true;
  const afterMutation = await daemonEnvironment(t, {
    runId: "run-after-mutation",
    clockStart: BASE + 10000,
    modelBehavior: async () => { throw new Error(PROVIDER_SENTINEL); },
    wrapJournal: journal => ({
      ...journal,
      append: async event => {
        if (failAck && event.event_type === "SOURCES_FAILED") { failAck = false; throw new Error("ack failure"); }
        return journal.append(event);
      }
    })
  });
  const failedReport = await afterMutation.daemon.runOnce(commitRequest(afterMutation));
  assert.equal(failedReport.status, "needs_reconciliation");
  const revision = (await afterMutation.storage.getMemory(USER, afterMutation.memories[0].id)).processing.revision;
  const plan = await afterMutation.recoveryManager.buildRecoveryPlan({ generatedAt: BASE + 20000 });
  assert.equal(plan.actions.some(action => action.action === RECOVERY_ACTIONS.RECORD_RECOVERED_SOURCE_FAILURE), true);
  await executeRecovery(afterMutation.recoveryManager, plan);
  assert.equal((await afterMutation.storage.getMemory(USER, afterMutation.memories[0].id)).processing.revision, revision);
});

matrixTest("valid storage commit without COMMIT_SUCCEEDED is reconciled without rewrite", ["C17"], async t => {
  let failAck = true;
  const state = await daemonEnvironment(t, {
    runId: "run-commit-gap",
    wrapJournal: journal => ({
      ...journal,
      append: async event => {
        if (failAck && event.event_type === "COMMIT_SUCCEEDED") { failAck = false; throw new Error("ack failure"); }
        return journal.append(event);
      }
    })
  });
  const report = await state.daemon.runOnce(commitRequest(state));
  assert.equal(report.status, "needs_reconciliation");
  const superMemory = (await state.storage.loadMemories(USER)).find(memory => memory.memoryKind === "super_memory");
  assert.ok(superMemory);
  const plan = await state.recoveryManager.buildRecoveryPlan({ generatedAt: BASE + 10000 });
  assert.equal(plan.actions.some(action => action.action === RECOVERY_ACTIONS.RECORD_RECOVERED_COMMIT_SUCCESS), true);
  await executeRecovery(state.recoveryManager, plan);
  assert.equal((await state.storage.loadMemories(USER)).filter(memory => memory.memoryKind === "super_memory").length, 1);
});

matrixTest("real multi-cluster crash keeps committed A and recovers only claimed B", ["D21", "D23", "D25", "D26"], async t => {
  let synthesisStarts = 0;
  let crashed = false;
  const state = await daemonEnvironment(t, {
    clusterCount: 2,
    runId: "run-multi-crash",
    wrapJournal: journal => ({
      ...journal,
      append: async event => {
        if (event.event_type === "SYNTHESIS_STARTED" && ++synthesisStarts === 2) crashed = true;
        if (crashed) throw new Error("synthetic crash boundary");
        return journal.append(event);
      }
    })
  });
  const report = await state.daemon.runOnce(commitRequest(state, { continueOnClusterFailure: true }));
  assert.equal(report.status, "needs_reconciliation");
  const before = await state.storage.loadMemories(USER);
  const committed = state.clusters.find(cluster => cluster.memberIds.every(id => before.find(memory => memory.id === id)?.processing?.state === "consolidated"));
  const claimed = state.clusters.find(cluster => cluster.memberIds.every(id => before.find(memory => memory.id === id)?.processing?.state === "synthesizing"));
  assert.ok(committed);
  assert.ok(claimed);
  const originalSuperId = before.find(memory => memory.memoryKind === "super_memory").id;
  const restartedJournal = createHippocampusJournal({ directory: state.directory, userId: USER, clock: () => BASE + 30000 });
  const restarted = createRecoveryManager({ storage: state.storage, journal: restartedJournal, userId: USER, clock: () => BASE + 30000, recoveryGraceMs: 0 });
  const plan = await restarted.buildRecoveryPlan({ generatedAt: BASE + 40000 });
  const marks = plan.actions.filter(action => action.action === RECOVERY_ACTIONS.MARK_INTERRUPTED_CLAIM_FAILED);
  assert.deepEqual(marks.map(action => action.clusterId), [claimed.clusterId]);
  await executeRecovery(restarted, plan);
  const after = await state.storage.loadMemories(USER);
  assert.equal(after.filter(memory => memory.memoryKind === "super_memory").length, 1);
  assert.equal(after.find(memory => memory.memoryKind === "super_memory").id, originalSuperId);
  for (const id of claimed.memberIds) assert.equal(after.find(memory => memory.id === id).processing.state, "failed");
});

matrixTest("interleaved cluster events remain independent and contradictions fail closed", ["D22", "D24"], async t => {
  const state = await claimedEnvironment(t, { count: 2 });
  await state.journal.append({ event_type: "SYNTHESIS_STARTED", run_id: "run-claimed", mode: "commit", phase: "synthesis", status: "started", timestamp: BASE, cluster_id: "c-0", attempt_id: state.plans[0].attemptId, source_memory_ids: [state.memories[0].id], details: {} });
  const run = await state.journal.getRunState("run-claimed");
  assert.equal(run.incompleteClusters.length, 2);
  assert.equal(run.clusters.find(cluster => cluster.clusterId === "c-0").classification, "SYNTHESIS_STARTED_NO_RESULT");
  assert.equal(run.clusters.find(cluster => cluster.clusterId === "c-1").classification, "CLAIMED_NO_SYNTHESIS");

  const directory = temp(t);
  const journal = createHippocampusJournal({ directory, userId: USER });
  const descriptor = createJournalSourceClaimDescriptor(state.plans[0]);
  await journal.append({ event_type: "RUN_STARTED", run_id: "run-conflict", mode: "commit", phase: "commit", status: "started", timestamp: BASE, details: {} });
  for (const clusterId of ["x", "y"]) {
    await journal.append({ event_type: "SOURCES_CLAIMED", run_id: "run-conflict", mode: "commit", phase: "synthesis", status: "claimed", timestamp: BASE + (clusterId === "x" ? 1 : 2), cluster_id: clusterId, attempt_id: state.plans[0].attemptId, source_memory_ids: [state.memories[0].id], details: { claimPlan: descriptor } });
  }
  const conflict = await journal.getRunState("run-conflict");
  assert.equal(conflict.blocked, true);
  assert.ok(conflict.blockedClusters.length > 0 || conflict.reasonCodes.length > 0);
});

matrixTest("one recovery lock serializes memory/cluster writers and ACK follows release", ["E27", "E28", "E32", "E33", "E34"], async t => {
  const state = await claimedEnvironment(t, { count: 2 });
  const entered = deferred();
  const resume = deferred();
  let acquisitions = 0;
  let releases = 0;
  let firstSave = true;
  const wrapped = storageProxy(state.storage, {
    acquireLock: async (...args) => { acquisitions++; return state.storage.acquireLock(...args); },
    releaseLock: async handle => { releases++; return state.storage.releaseLock(handle); },
    saveMemories: async (userId, memories, options) => {
      if (firstSave) { firstSave = false; entered.resolve(); await resume.promise; }
      return state.storage.saveMemories(userId, memories, options);
    }
  });
  const journal = {
    ...state.journal,
    append: async event => {
      assert.equal((await state.storage.inspectUserLock(USER, { staleAfterMs: 1 })).exists, false);
      return state.journal.append(event);
    }
  };
  const recovery = createRecoveryManager({ storage: wrapped, journal, userId: USER, clock: () => BASE + 4000, recoveryGraceMs: 0 });
  const running = executeRecovery(recovery, state.recoveryPlan);
  await entered.promise;
  let memoryDone = false;
  let clusterDone = false;
  const memoryWriter = state.storage.saveMemory(USER, raw("writer", 0)).then(() => { memoryDone = true; });
  const clusterWriter = state.storage.deleteCluster(USER, "missing").then(() => { clusterDone = true; });
  await nextTurn();
  assert.equal(memoryDone, false);
  assert.equal(clusterDone, false);
  resume.resolve();
  await running;
  await Promise.all([memoryWriter, clusterWriter]);
  assert.equal(acquisitions, 1);
  assert.equal(releases, 1);
  assert.equal((await state.storage.inspectUserLock(USER, { staleAfterMs: 1 })).exists, false);
});

matrixTest("same-user recoveries serialize, other users remain independent, stale plans fail", ["E29", "E30", "E31"], async t => {
  const state = await claimedEnvironment(t);
  const held = await state.storage.acquireLock(USER);
  const first = executeRecovery(state.recovery, state.recoveryPlan, { lockOptions: { timeoutMs: 1000, retryIntervalMs: 5 } });
  const memories = await state.storage.loadMemories(USER);
  memories[0].processing.updated_at += 1;
  await state.storage.saveMemories(USER, memories, { lockHandle: held });
  await state.storage.releaseLock(held);
  await assert.rejects(first, { code: "STALE_RECOVERY_PLAN" });

  const directory = temp(t);
  const shared = new JsonMemoryStorage(directory);
  const left = await claimedEnvironment(t, { directory, storage: shared, userId: USER });
  const right = await claimedEnvironment(t, { directory, storage: shared, userId: OTHER_USER });
  const gate = deferred();
  const resume = deferred();
  const wrapped = storageProxy(shared, {
    saveMemories: async (userId, records, options) => {
      if (userId === USER) { gate.resolve(); await resume.promise; }
      return shared.saveMemories(userId, records, options);
    }
  });
  const leftRecovery = createRecoveryManager({ storage: wrapped, journal: left.journal, userId: USER, clock: () => BASE + 5000, recoveryGraceMs: 0 });
  const rightRecovery = createRecoveryManager({ storage: wrapped, journal: right.journal, userId: OTHER_USER, clock: () => BASE + 5000, recoveryGraceMs: 0 });
  const leftRun = executeRecovery(leftRecovery, left.recoveryPlan);
  await gate.promise;
  assert.equal((await executeRecovery(rightRecovery, right.recoveryPlan)).status, "completed");
  resume.resolve();
  await leftRun;
});

matrixTest("reports, errors, current JSONL and legacy inspection enforce privacy", ["F35", "F36", "F37", "F38", "F39"], async t => {
  const state = await daemonEnvironment(t, { modelBehavior: async () => { throw new Error(PROVIDER_SENTINEL); } });
  const report = await state.daemon.runOnce(commitRequest(state));
  const events = await state.journal.readAll();
  const rawJournal = fs.readFileSync(path.join(state.directory, state.journal.fileName), "utf8");
  const forbidden = new RegExp(`${USER}|${PROVIDER_SENTINEL}|synthetic source|prompt|raw_output|sourceSnapshot`, "i");
  assert.doesNotMatch(JSON.stringify({ report, events }), forbidden);
  assertNoPrivatePayload({ report, events });
  assert.doesNotMatch(rawJournal, forbidden);
  await assert.rejects(state.journal.append({ event_type: "RECOVERY_ACTION", run_id: "private-reject", mode: "recovery", phase: "recovery", status: "failed", timestamp: BASE + 10000, details: { nested: [{ user_id: USER }] } }), error => {
    assert.doesNotMatch(error.message, new RegExp(USER));
    return true;
  });

  const legacyDirectory = temp(t);
  const legacyJournal = createHippocampusJournal({ directory: legacyDirectory, userId: USER });
  const legacy = legacyRecord({ event_type: "RUN_STARTED", run_id: "legacy-run", mode: "commit", phase: "commit", status: "started", timestamp: BASE, details: { userId: USER } }, 1);
  fs.writeFileSync(path.join(legacyDirectory, legacyJournal.fileName), `${JSON.stringify(legacy)}\n`, { mode: 0o600 });
  assert.equal((await legacyJournal.readAll()).length, 1);
  const inspection = await legacyJournal.inspect();
  assert.equal(inspection.legacyPrivacyDetected, true);
  assert.doesNotMatch(JSON.stringify(inspection), new RegExp(USER));
});

matrixTest("mid-plan failure stops later actions; rollback success and failure are explicit", ["G40", "G41", "G42", "G43"], async t => {
  const restored = await claimedEnvironment(t, { count: 2 });
  let saves = 0;
  const rollbackStorage = storageProxy(restored.storage, {
    saveMemories: async (userId, memories, options) => {
      saves++;
      if (saves === 2) throw new Error("second action failure");
      return restored.storage.saveMemories(userId, memories, options);
    }
  });
  const rollbackRecovery = createRecoveryManager({ storage: rollbackStorage, journal: restored.journal, userId: USER, clock: () => BASE + 5000, recoveryGraceMs: 0 });
  await assert.rejects(executeRecovery(rollbackRecovery, restored.recoveryPlan), { code: "RECOVERY_DATA_ACTION_FAILED" });
  assert.equal(saves, 3);
  for (const memory of restored.memories) {
    const current = await restored.storage.getMemory(USER, memory.id);
    assert.equal(current.processing.state, "synthesizing");
    assert.equal(current.processing.revision, 2);
  }
  assert.equal((await restored.journal.readAll()).some(event => event.event_type === "SOURCES_FAILED"), false);

  const unknown = await claimedEnvironment(t, { count: 2, directory: temp(t) });
  let unknownSaves = 0;
  const unknownStorage = storageProxy(unknown.storage, {
    saveMemories: async (userId, memories, options) => {
      unknownSaves++;
      if (unknownSaves >= 2) throw new Error("action and rollback failure");
      return unknown.storage.saveMemories(userId, memories, options);
    }
  });
  const unknownRecovery = createRecoveryManager({ storage: unknownStorage, journal: unknown.journal, userId: USER, clock: () => BASE + 6000, recoveryGraceMs: 0 });
  await assert.rejects(executeRecovery(unknownRecovery, unknown.recoveryPlan), error => {
    assert.equal(error.code, "RECOVERY_ROLLBACK_FAILED_STATE_UNKNOWN");
    assert.equal(error.status, "unknown");
    return true;
  });
  assert.equal((await unknown.storage.inspectUserLock(USER, { staleAfterMs: 1 })).exists, false);
});

matrixTest("ACK loss after valid data returns reconciliation and retry adds no revision", ["G44", "G45"], async t => {
  const state = await claimedEnvironment(t);
  let failAck = true;
  const journal = {
    ...state.journal,
    append: async event => {
      if (failAck && event.event_type === "SOURCES_FAILED") { failAck = false; throw new Error("ack failure"); }
      return state.journal.append(event);
    }
  };
  const recovery = createRecoveryManager({ storage: state.storage, journal, userId: USER, clock: () => BASE + 5000, recoveryGraceMs: 0 });
  const report = await executeRecovery(recovery, state.recoveryPlan);
  assert.equal(report.status, "needs_reconciliation");
  const revision = (await state.storage.getMemory(USER, state.memories[0].id)).processing.revision;
  const retry = createRecoveryManager({ storage: state.storage, journal: state.journal, userId: USER, clock: () => BASE + 6000, recoveryGraceMs: 0 });
  const retryPlan = await retry.buildRecoveryPlan({ generatedAt: BASE + 7000 });
  await executeRecovery(retry, retryPlan);
  assert.equal((await state.storage.getMemory(USER, state.memories[0].id)).processing.revision, revision);
});

test("FIX 20 matrix registry contains every required scenario exactly once", () => {
  assert.deepEqual([...registeredScenarios.keys()].sort(), [...REQUIRED_SCENARIOS].sort());
  assert.equal(new Set(registeredScenarios.keys()).size, REQUIRED_SCENARIOS.length);
});
