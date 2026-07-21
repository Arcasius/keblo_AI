"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");

const JsonMemoryStorage = require("../../core/JsonMemoryStorage.js");
const { createProcessingState } = require("../../core/consolidation/ProcessingState.js");
const { selectConsolidationCandidates } = require("../../core/consolidation/CandidateSelector.js");
const { buildConsolidationPlan } = require("../../core/consolidation/ConsolidationPlan.js");
const { createClusterEngineAdapter } = require("../../core/clustering/ClusterEngineAdapter.js");
const { createMaturityGate } = require("../../core/hippocampus/MaturityGate.js");
const { createSourceClaimPlan, claimSources, failClaimedSources } = require("../../core/hippocampus/SourceClaimTransaction.js");
const { createHippocampusJournal } = require("../../core/hippocampus/HippocampusJournal.js");
const { createRecoveryManager } = require("../../core/hippocampus/RecoveryManager.js");
const {
  HIPPOCAMPUS_MODES, HIPPOCAMPUS_PHASES, DAEMON_REASON_CODES, createHippocampusDaemon
} = require("../../core/hippocampus/HippocampusDaemon.js");

const USER = "synthetic-user";
const BASE = 1800000000000;
const IDS = ["m-a", "m-b", "m-c"];
const sha = text => createHash("sha256").update(text, "utf8").digest("hex");

function raw(id, index = 0, overrides = {}) {
  return {
    id, type: "episodic", content: { text: `Synthetic source ${id}`, extra: "preserve" },
    timestamp: BASE - index, memoryKind: "raw", storageTier: "warm", embedding_ref: `emb-${id}`,
    tags: ["keep"], unknown: { keep: true },
    processing: createProcessingState({ state: "raw", revision: 0, attempt_id: null, updated_at: BASE - 100, error: null }),
    ...overrides
  };
}
function embeddingProvider(extra = {}) {
  return { schemaVersion: 1, providerId: "synthetic-embed", model: "embed-v1", version: "1", async getEmbedding() { return [1, 0]; }, ...extra };
}
function output(ids = IDS, rejected = []) {
  const used = ids.filter(id => !rejected.includes(id));
  return {
    schema_version: 1, title: "Synthetic title", synthesis: "Synthetic synthesis",
    facts: [{ text: "Synthetic fact", source_memory_ids: [used[0]] }], uncertainties: [], contradictions: [],
    source_memory_ids: used, confidence: 0.8, rejected_source_ids: rejected
  };
}
function modelProvider(generate) {
  return {
    schemaVersion: 1, providerId: "synthetic-model", model: "model-v1", version: "1",
    generate: generate || (async () => ({ ok: true, status: 200, text: JSON.stringify(output()) }))
  };
}
function clock() { let value = BASE; return () => value++; }
function temp(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fix13-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
async function candidateFor(memories) {
  const selection = selectConsolidationCandidates(memories);
  const plan = buildConsolidationPlan(selection);
  const result = await createClusterEngineAdapter({ embeddingProvider: embeddingProvider() }).buildClusterCandidates({ consolidationPlan: plan, memories });
  return result.clusters[0];
}
async function fixture(t, overrides = {}) {
  const directory = temp(t);
  const storage = new JsonMemoryStorage(directory);
  const memories = IDS.map(raw);
  await storage.saveMemories(USER, memories);
  const candidate = await candidateFor(memories);
  const runtimeClock = clock();
  const journal = createHippocampusJournal({ directory, userId: USER, clock: runtimeClock });
  const recoveryManager = createRecoveryManager({ storage, journal, userId: USER, clock: runtimeClock, recoveryGraceMs: 0 });
  const daemon = createHippocampusDaemon({ storage, userId: USER, embeddingProvider: embeddingProvider(), modelProvider: modelProvider(), clock: runtimeClock, idGenerator: () => "run-synthetic", commitEnabled: true, journal, recoveryManager, ...overrides });
  return { directory, storage, memories, candidate, daemon, journal, recoveryManager };
}

test("module import has no auto-start and exports modes/phases", () => {
  assert.deepEqual(HIPPOCAMPUS_MODES, { DRY_RUN: "dry-run", COMMIT: "commit" });
  assert.deepEqual(HIPPOCAMPUS_PHASES, { PLAN: "plan", CLUSTER: "cluster", SYNTHESIS: "synthesis", COMMIT: "commit" });
  const daemon = createHippocampusDaemon({ storage: { loadMemories: async () => [] }, userId: USER, idGenerator: () => "run", clock: clock() });
  assert.equal(daemon.getStatus().running, false);
  assert.equal(daemon.getStatus().scheduled, false);
  assert.equal(daemon.getStatus().statusHydrated, false);
  assert.equal(daemon.getStatus().recoveryState, "unknown");
  assert.equal(daemon.getStatus().recoveryRequired, null);
  assert.equal(daemon.getStatus().incompleteRunCount, null);
});

test("default run is plan dry-run without providers or writes", async () => {
  let writes = 0;
  const storage = { capabilities: { schemaVersion: 1, statuses: { "memory.readAll": { status: "supported", verified: true } } }, async loadMemories() { return [raw("one")]; }, async saveMemories() { writes += 1; } };
  const report = await createHippocampusDaemon({ storage, userId: USER, idGenerator: () => "run-plan", clock: clock() }).runOnce();
  assert.equal(report.dryRun, true); assert.equal(report.phase, "plan"); assert.equal(report.writesAttempted, 0); assert.equal(writes, 0);
});

test("cluster and synthesis phases require their explicit providers and max limit", async () => {
  const storage = { capabilities: { schemaVersion: 1, statuses: { "memory.readAll": { status: "supported", verified: true } } }, async loadMemories() { return []; } };
  const base = { storage, userId: USER, idGenerator: () => "run", clock: clock() };
  await assert.rejects(createHippocampusDaemon(base).runOnce({ phase: "cluster" }), { code: "EMBEDDING_PROVIDER_REQUIRED" });
  await assert.rejects(createHippocampusDaemon({ ...base, embeddingProvider: embeddingProvider() }).runOnce({ phase: "synthesis" }), { code: "MAX_CLUSTERS_REQUIRED" });
  await assert.rejects(createHippocampusDaemon({ ...base, embeddingProvider: embeddingProvider() }).runOnce({ phase: "synthesis", maxClustersPerRun: 1 }), { code: "MODEL_PROVIDER_REQUIRED" });
});

test("commit requires both constructor enablement and exact confirmation", async (t) => {
  const directory = temp(t); const storage = new JsonMemoryStorage(directory);
  const base = { storage, userId: USER, embeddingProvider: embeddingProvider(), modelProvider: modelProvider(), clock: clock(), idGenerator: () => "run" };
  await assert.rejects(createHippocampusDaemon(base).runOnce({ mode: "commit", phase: "commit", maxClustersPerRun: 1, confirmCommit: "COMMIT_HIPPOCAMPUS_V1" }), { code: "COMMIT_NOT_ENABLED" });
  const enabled = createHippocampusDaemon({ ...base, commitEnabled: true });
  await assert.rejects(enabled.runOnce({ mode: "commit", phase: "commit", maxClustersPerRun: 1 }), { code: "COMMIT_CONFIRMATION_REQUIRED" });
  await assert.rejects(enabled.runOnce({ mode: "commit", phase: "commit", maxClustersPerRun: 1, confirmCommit: "wrong" }), { code: "COMMIT_CONFIRMATION_REQUIRED" });
  await assert.rejects(enabled.runOnce({ mode: "commit", phase: "commit", maxClustersPerRun: 1, confirmCommit: "COMMIT_HIPPOCAMPUS_V1" }), { code: "JOURNAL_REQUIRED" });
  const journal = createHippocampusJournal({ directory, userId: USER });
  await assert.rejects(createHippocampusDaemon({ ...base, commitEnabled: true, journal }).runOnce({ mode: "commit", phase: "commit", maxClustersPerRun: 1, confirmCommit: "COMMIT_HIPPOCAMPUS_V1" }), { code: "RECOVERY_MANAGER_REQUIRED" });
});

test("maturity gate is conservative, explicit and supports structured evaluator", async () => {
  const candidate = await candidateFor(IDS.map(raw));
  const gate = createMaturityGate();
  assert.equal((await gate.evaluate(candidate, {})).mature, false);
  assert.equal((await gate.evaluate(candidate, { approvedClusterIds: [candidate.clusterId] })).mature, true);
  const evaluated = createMaturityGate({ requireExplicitApproval: false, evaluator: async () => ({ mature: true, evidence: { cycles: 2 } }) });
  const result = await evaluated.evaluate(candidate, {});
  assert.equal(result.mature, true); assert.deepEqual(result.evidence.evaluator, { cycles: 2 }); assert.equal(Object.hasOwn(result.evidence, "centroid"), false);
});

test("source claim performs raw→candidate→synthesizing atomically and preserves fields", async (t) => {
  const directory = temp(t); const storage = new JsonMemoryStorage(directory); const memories = IDS.map(raw); await storage.saveMemories(USER, memories);
  const hashes = Object.fromEntries(memories.map(memory => [memory.id, sha(memory.content.text)]));
  const plan = createSourceClaimPlan({ userId: USER, sourceMemories: memories, sourceIds: IDS, attemptId: "attempt", claimedAt: BASE, sourceContentHashes: hashes });
  const report = await claimSources({ storage, plan });
  assert.equal(report.claimed, true); assert.equal(report.writesAttempted, 1);
  for (const memory of await storage.loadMemories(USER)) { assert.equal(memory.processing.state, "synthesizing"); assert.equal(memory.processing.revision, 2); assert.equal(memory.processing.attempt_id, "attempt"); assert.deepEqual(memory.unknown, { keep: true }); }
  assert.equal((await claimSources({ storage, plan })).idempotentReplay, true);
});

test("claim rejects legacy and optimistic/hash mismatch without partial write", async (t) => {
  const legacy = raw("legacy"); delete legacy.processing;
  assert.throws(() => createSourceClaimPlan({ userId: USER, sourceMemories: [legacy], sourceIds: ["legacy"], attemptId: "a", claimedAt: BASE, sourceContentHashes: { legacy: sha(legacy.content.text) } }), { code: "SOURCE_NOT_EXPLICIT_RAW" });
  const directory = temp(t); const storage = new JsonMemoryStorage(directory); const memories = IDS.map(raw); await storage.saveMemories(USER, memories);
  assert.throws(() => createSourceClaimPlan({ userId: USER, sourceMemories: memories, sourceIds: IDS, attemptId: "a", claimedAt: BASE, sourceContentHashes: { ...Object.fromEntries(memories.map(m => [m.id, sha(m.content.text)])), "m-b": "0".repeat(64) } }), { code: "SOURCE_CONTENT_HASH_MISMATCH" });
});

test("failed claim transitions once and does not overwrite evolved state", async (t) => {
  const directory = temp(t); const storage = new JsonMemoryStorage(directory); const memories = IDS.map(raw); await storage.saveMemories(USER, memories);
  const plan = createSourceClaimPlan({ userId: USER, sourceMemories: memories, sourceIds: IDS, attemptId: "attempt", claimedAt: BASE, sourceContentHashes: Object.fromEntries(memories.map(m => [m.id, sha(m.content.text)])) });
  await claimSources({ storage, plan });
  const error = { code: "SYNTHESIS_FAILED", message: "Synthetic provider failure", retryable: true };
  const failed = await failClaimedSources({ storage, plan, failedAt: BASE + 1, error });
  assert.equal(failed.failed, true); assert.equal((await failClaimedSources({ storage, plan, failedAt: BASE + 1, error })).idempotentReplay, true);
  assert.equal((await storage.getMemory(USER, "m-a")).processing.state, "failed");
});

test("dry-run synthesis requires explicit maturity and performs no writes", async (t) => {
  const state = await fixture(t);
  const deferred = await state.daemon.runOnce({ phase: "synthesis", maxClustersPerRun: 1 });
  assert.equal(deferred.processedClusters.length, 0); assert.equal(deferred.writesAttempted, 0);
  const approved = await state.daemon.runOnce({ runId: "run-approved", phase: "synthesis", maxClustersPerRun: 1, approvedClusterIds: [state.candidate.clusterId] });
  assert.equal(approved.processedClusters.length, 1); assert.equal(approved.writesAttempted, 0);
  assert.equal((await state.storage.loadClusters(USER)).length, 0);
  assert.equal((await state.storage.getMemory(USER, "m-a")).processing.state, "raw");
});

test("authorized commit persists cluster, claims, synthesizes outside lock and commits once", async (t) => {
  let directory;
  const state = await fixture(t, { modelProvider: modelProvider(async () => {
    assert.equal(fs.existsSync(path.join(directory, ".locks")) && fs.readdirSync(path.join(directory, ".locks")).length > 0, false);
    return { ok: true, status: 200, text: JSON.stringify(output(IDS, ["m-c"])) };
  }) });
  directory = state.directory;
  const report = await state.daemon.runOnce({ mode: "commit", phase: "commit", confirmCommit: "COMMIT_HIPPOCAMPUS_V1", maxClustersPerRun: 1, approvedClusterIds: [state.candidate.clusterId] });
  assert.equal(report.status, "completed", JSON.stringify(report)); assert.equal(report.commitStats.committed, 1);
  assert.equal((await state.storage.loadClusters(USER)).length, 1);
  const memories = await state.storage.loadMemories(USER); const map = Object.fromEntries(memories.map(m => [m.id, m]));
  assert.equal(map["m-a"].processing.state, "consolidated"); assert.equal(map["m-b"].processing.state, "consolidated"); assert.equal(map["m-c"].processing.state, "failed");
  assert.equal(memories.filter(m => m.memoryKind === "super_memory").length, 1); assert.deepEqual(map["m-a"].unknown, { keep: true });
  const journalEvents = await state.journal.readAll();
  assert.deepEqual(journalEvents.map(event => event.event_type), ["RUN_STARTED","PLAN_COMPLETED","CLUSTER_SELECTED","CLUSTER_PERSISTED","SOURCES_CLAIMED","SYNTHESIS_STARTED","SYNTHESIS_SUCCEEDED","COMMIT_STARTED","COMMIT_SUCCEEDED","RUN_COMPLETED"]);
  assert.equal(Object.hasOwn(journalEvents.find(event => event.event_type === "SOURCES_CLAIMED").details.claimPlan, "userId"), false);
  assert.doesNotMatch(fs.readFileSync(path.join(state.directory, state.journal.fileName), "utf8"), new RegExp(USER));
  const replay = await state.daemon.runOnce({ runId: "run-replay", mode: "commit", phase: "commit", confirmCommit: "COMMIT_HIPPOCAMPUS_V1", maxClustersPerRun: 1, approvedClusterIds: [state.candidate.clusterId] });
  assert.equal(replay.commitStats.committed, 0);
  assert.equal((await state.storage.loadMemories(USER)).filter(m => m.memoryKind === "super_memory").length, 1);
});

test("recovery preflight and journal failures guard commit boundaries", async (t) => {
  const pre = await fixture(t);
  await pre.journal.append({ event_type:"RUN_STARTED",run_id:"old-run",mode:"commit",phase:"commit",status:"started",timestamp:BASE,details:{} });
  await assert.rejects(pre.daemon.runOnce({ mode:"commit",phase:"commit",confirmCommit:"COMMIT_HIPPOCAMPUS_V1",maxClustersPerRun:1,approvedClusterIds:[pre.candidate.clusterId] }),{code:"RECOVERY_REQUIRED"});
  assert.equal((await pre.storage.loadClusters(USER)).length,0);

  const before = await fixture(t);
  const failingJournal = { ...before.journal, append: async () => { throw new Error("journal unavailable"); } };
  const daemon = createHippocampusDaemon({ storage:before.storage,userId:USER,embeddingProvider:embeddingProvider(),modelProvider:modelProvider(),clock:clock(),idGenerator:()=>"preclaim-run",commitEnabled:true,journal:failingJournal,recoveryManager:before.recoveryManager });
  await assert.rejects(daemon.runOnce({mode:"commit",phase:"commit",confirmCommit:"COMMIT_HIPPOCAMPUS_V1",maxClustersPerRun:1,approvedClusterIds:[before.candidate.clusterId]}));
  assert.equal((await before.storage.loadClusters(USER)).length,0);
  assert.equal((await before.storage.getMemory(USER,"m-a")).processing.state,"raw");
});

test("post-commit journal failure yields reconciliation and recovery records success", async (t) => {
  const state = await fixture(t); let failed=false;
  const wrapper = { ...state.journal, append: async event => { if(event.event_type==="COMMIT_SUCCEEDED"&&!failed){failed=true;throw new Error("journal unavailable");}return state.journal.append(event); } };
  const daemon=createHippocampusDaemon({storage:state.storage,userId:USER,embeddingProvider:embeddingProvider(),modelProvider:modelProvider(),clock:clock(),idGenerator:()=>"postcommit-run",commitEnabled:true,journal:wrapper,recoveryManager:state.recoveryManager});
  const report=await daemon.runOnce({mode:"commit",phase:"commit",confirmCommit:"COMMIT_HIPPOCAMPUS_V1",maxClustersPerRun:1,approvedClusterIds:[state.candidate.clusterId]});
  assert.equal(report.failures[0].code,"NEEDS_RECONCILIATION");
  assert.equal((await state.storage.loadMemories(USER)).filter(m=>m.memoryKind==="super_memory").length,1);
  const plan=await state.recoveryManager.buildRecoveryPlan({generatedAt:BASE+10000});
  assert.equal(plan.actions.some(a=>a.action==="RECORD_RECOVERED_COMMIT_SUCCESS"),true);
  await state.recoveryManager.executeRecovery({plan,execute:true,confirmRecovery:"RECOVER_HIPPOCAMPUS_V1"});
  assert.equal((await state.recoveryManager.inspect()).incompleteRuns.length,0);
});

test("provider failure fails claimed sources and honors stop policy", async (t) => {
  const state = await fixture(t, { modelProvider: modelProvider(async () => { throw new Error("private provider payload"); }) });
  const report = await state.daemon.runOnce({ mode: "commit", phase: "commit", confirmCommit: "COMMIT_HIPPOCAMPUS_V1", maxClustersPerRun: 1, approvedClusterIds: [state.candidate.clusterId] });
  assert.equal(report.status, "failed"); assert.equal(report.failures.length, 1); assert.doesNotMatch(JSON.stringify(report), /private provider payload|Synthetic source/);
  for (const id of IDS) assert.equal((await state.storage.getMemory(USER, id)).processing.state, "failed");
});

test("legacy opt-in is dry-run only and twelve clusters have no implicit five", async () => {
  const legacy = { id: "legacy", content: { text: "legacy" }, timestamp: BASE };
  const storage = { capabilities: { schemaVersion: 1, statuses: { "memory.readAll": { status: "supported", verified: true } } }, async loadMemories() { return [legacy]; } };
  const daemon = createHippocampusDaemon({ storage, userId: USER, idGenerator: () => "run", clock: clock() });
  const dry = await daemon.runOnce({ allowLegacyUnclassified: true }); assert.equal(dry.candidateStats.eligibleIncluded, 1);
  await assert.rejects(createHippocampusDaemon({ storage, userId: USER, commitEnabled: true, idGenerator: () => "run2", clock: clock() }).runOnce({ mode: "commit", phase: "commit", confirmCommit: "COMMIT_HIPPOCAMPUS_V1", maxClustersPerRun: 12, allowLegacyUnclassified: true }), { code: "LEGACY_COMMIT_FORBIDDEN" });
});

test("dry-run cluster analyzes twelve clusters without an implicit five", async (t) => {
  const directory = temp(t); const storage = new JsonMemoryStorage(directory);
  const memories = Array.from({ length: 12 }, (_, cluster) => Array.from({ length: 3 }, (_, member) => raw(`m-${cluster}-${member}`, cluster * 3 + member))).flat();
  await storage.saveMemories(USER, memories);
  const provider = embeddingProvider({ async getEmbedding({ memoryId }) { const cluster = Number(memoryId.split("-")[1]); return Array.from({ length: 12 }, (_, index) => index === cluster ? 1 : 0); } });
  const daemon = createHippocampusDaemon({ storage, userId: USER, embeddingProvider: provider, idGenerator: () => "run-twelve", clock: clock() });
  const report = await daemon.runOnce({ phase: "cluster" });
  assert.equal(report.clusterStats.clusterCount, 12);
  assert.equal(report.writesAttempted, 0);
});

test("continueOnClusterFailure controls deterministic multi-cluster processing", async (t) => {
  const directory = temp(t); const storage = new JsonMemoryStorage(directory);
  const memories = ["a", "b"].flatMap((group, groupIndex) => Array.from({ length: 3 }, (_, index) => raw(`${group}-${index}`, groupIndex * 3 + index)));
  await storage.saveMemories(USER, memories);
  const provider = embeddingProvider({ async getEmbedding({ memoryId }) { return memoryId.startsWith("a-") ? [1, 0] : [0, 1]; } });
  const clusters = (await createClusterEngineAdapter({ embeddingProvider: provider }).buildClusterCandidates({ consolidationPlan: buildConsolidationPlan(selectConsolidationCandidates(memories)), memories })).clusters;
  const make = () => createHippocampusDaemon({ storage, userId: USER, embeddingProvider: provider, modelProvider: modelProvider(async () => { throw new Error("synthetic"); }), idGenerator: (() => { let i = 0; return () => `failure-run-${++i}`; })(), clock: clock() });
  const stopped = await make().runOnce({ phase: "synthesis", maxClustersPerRun: 2, approvedClusterIds: clusters.map(c => c.clusterId) });
  assert.equal(stopped.failures.length, 1);
  const continued = await make().runOnce({ phase: "synthesis", maxClustersPerRun: 2, approvedClusterIds: clusters.map(c => c.clusterId), continueOnClusterFailure: true });
  assert.equal(continued.failures.length, 2);
});

test("single-process guard rejects overlap", async () => {
  let release; const wait = new Promise(resolve => { release = resolve; });
  const storage = { capabilities: { schemaVersion: 1, statuses: { "memory.readAll": { status: "supported", verified: true } } }, async loadMemories() { await wait; return []; } };
  const daemon = createHippocampusDaemon({ storage, userId: USER, idGenerator: (() => { let i = 0; return () => `run-${++i}`; })(), clock: clock() });
  const first = daemon.runOnce(); const second = await daemon.runOnce();
  assert.equal(second.status, "skipped"); assert.deepEqual(second.reasonCodes, [DAEMON_REASON_CODES.RUN_ALREADY_ACTIVE]); release(); await first;
});

test("scheduler is local dry-run only and stop is idempotent", async () => {
  const storage = { capabilities: { schemaVersion: 1, statuses: { "memory.readAll": { status: "supported", verified: true } } }, async loadMemories() { return []; } };
  const daemon = createHippocampusDaemon({ storage, userId: USER, intervalMs: 5, idGenerator: () => "scheduled-run", clock: clock() });
  assert.equal(daemon.start({ mode: "dry-run" }), true); assert.equal(daemon.start({ mode: "dry-run" }), false); assert.equal(daemon.getStatus().scheduled, true);
  assert.throws(() => createHippocampusDaemon({ storage, userId: USER, commitEnabled: true }).start({ mode: "commit", phase: "commit", confirmCommit: "COMMIT_HIPPOCAMPUS_V1", maxClustersPerRun: 1 }), /Scheduler accepts dry-run only/);
  assert.equal(daemon.stop(), true); assert.equal(daemon.stop(), false);
});

test("event sink receives sanitized events and failure does not corrupt run", async () => {
  const events = [];
  const storage = { capabilities: { schemaVersion: 1, statuses: { "memory.readAll": { status: "supported", verified: true } } }, async loadMemories() { return []; } };
  const daemon = createHippocampusDaemon({ storage, userId: USER, idGenerator: () => "run-events", clock: clock(), eventSink: async event => { events.push(event); if (event.type === "plan_completed") throw new Error("sink private"); } });
  const report = await daemon.runOnce();
  assert.deepEqual(events.map(e => e.type), ["run_started", "plan_completed", "run_completed"]); assert.equal(report.eventFailures.length, 1); assert.doesNotMatch(JSON.stringify({ events, report }), /content|prompt|centroid|sink private/);
});

test("implementation does not import or execute prototypes, models, network or real data", () => {
  const source = fs.readFileSync(path.join(__dirname, "../../core/hippocampus/HippocampusDaemon.js"), "utf8");
  assert.doesNotMatch(source, /hyppocampus|hyppocampo_Jace|fetch\s*\(|Ollama|Qwen|orbitale_chat_data|child_process/);
  assert.doesNotMatch(source, /new\s+HippocampusDaemon\s*\(|\.start\s*\(\s*\)\s*;/);
});
