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
  claimSources,
  failClaimedSources
} = require("../../core/hippocampus/SourceClaimTransaction");
const { createHippocampusJournal } = require("../../core/hippocampus/HippocampusJournal");
const {
  createRecoveryManager,
  RECOVERY_ACTIONS
} = require("../../core/hippocampus/RecoveryManager");

const USER = "fix19-private-user";
const OTHER_USER = "fix19-other-user";
const PRIVATE_SENTINEL = "fix19-private-user";
const BASE = 1930000000000;

function sha(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
function temp(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fix19-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function raw(id, userId = USER) {
  return {
    id,
    type: "episodic",
    content: { text: `synthetic ${id}` },
    timestamp: BASE - 20,
    memoryKind: "raw",
    storageTier: "warm",
    meta: { user_id: userId },
    processing: createProcessingState({
      state: "raw", revision: 0, attempt_id: null, updated_at: BASE - 30, error: null
    })
  };
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
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
async function nextTurn() {
  await new Promise(resolve => setImmediate(resolve));
}
function emitter(journal, runId) {
  let timestamp = BASE - 100;
  return (event_type, cluster_id = null, extra = {}) => journal.append({
    event_type,
    run_id: runId,
    mode: "commit",
    phase: "synthesis",
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
async function fixture(t, { userId = USER, clusterCount = 2, storage, directory } = {}) {
  directory ||= temp(t);
  storage ||= new JsonMemoryStorage(directory);
  const plans = [];
  const memories = [];
  for (let index = 0; index < clusterCount; index++) {
    const clusterId = `cluster-${index}`;
    const memory = raw(`source-${index}`, userId);
    memories.push(memory);
    plans.push(claimPlan(userId, clusterId, [memory]));
  }
  await storage.saveMemories(userId, memories);
  for (const plan of plans) await claimSources({ storage, plan });
  const journal = createHippocampusJournal({ directory, userId, clock: () => BASE + 1000 });
  const emit = emitter(journal, userId === USER ? "run-left" : "run-right");
  await emit("RUN_STARTED");
  for (let index = 0; index < plans.length; index++) await appendClaim(emit, `cluster-${index}`, plans[index]);
  const recovery = createRecoveryManager({ storage, journal, userId, clock: () => BASE + 2000, recoveryGraceMs: 1 });
  const plan = await recovery.buildRecoveryPlan({ generatedAt: BASE + 3000 });
  return { directory, storage, journal, recovery, plan, plans, memories, userId };
}
function execute(recovery, plan, extra = {}) {
  return recovery.executeRecovery({
    plan,
    execute: true,
    confirmRecovery: "RECOVER_HIPPOCAMPUS_V1",
    ...extra
  });
}

test("multi-action recovery acquires and releases once and passes one verified handle", async t => {
  const state = await fixture(t);
  let acquires = 0;
  let releases = 0;
  const handles = [];
  const wrapped = storageProxy(state.storage, {
    acquireLock: async (...args) => { acquires++; return state.storage.acquireLock(...args); },
    releaseLock: async handle => { releases++; return state.storage.releaseLock(handle); },
    saveMemories: async (userId, memories, options) => {
      handles.push(options?.lockHandle);
      return state.storage.saveMemories(userId, memories, options);
    }
  });
  const recovery = createRecoveryManager({ storage: wrapped, journal: state.journal, userId: USER, clock: () => BASE + 4000, recoveryGraceMs: 1 });
  const report = await execute(recovery, state.plan);
  assert.equal(report.status, "completed");
  assert.equal(acquires, 1);
  assert.equal(releases, 1);
  assert.equal(handles.length, 2);
  assert.ok(handles[0]);
  assert.equal(handles[0], handles[1]);
  assert.equal(state.plan.actions.filter(action => action.action === RECOVERY_ACTIONS.MARK_INTERRUPTED_CLAIM_FAILED).length, 2);
});

test("memory and cluster writers wait until the single recovery lock is released", async t => {
  const state = await fixture(t, { clusterCount: 1 });
  const entered = deferred();
  const resume = deferred();
  let first = true;
  const wrapped = storageProxy(state.storage, {
    saveMemories: async (userId, memories, options) => {
      if (first) {
        first = false;
        entered.resolve();
        await resume.promise;
      }
      return state.storage.saveMemories(userId, memories, options);
    }
  });
  const recovery = createRecoveryManager({ storage: wrapped, journal: state.journal, userId: USER, clock: () => BASE + 4000, recoveryGraceMs: 1 });
  const recoveryPromise = execute(recovery, state.plan);
  await entered.promise;
  let memoryDone = false;
  let clusterDone = false;
  const memoryWriter = state.storage.saveMemory(USER, raw("writer-memory")).then(() => { memoryDone = true; });
  const clusterWriter = state.storage.deleteCluster(USER, "missing-cluster").then(() => { clusterDone = true; });
  await nextTurn();
  assert.equal(memoryDone, false);
  assert.equal(clusterDone, false);
  resume.resolve();
  await recoveryPromise;
  await Promise.all([memoryWriter, clusterWriter]);
  assert.equal(memoryDone, true);
  assert.equal(clusterDone, true);
});

test("two recoveries for one user serialize and the second rejects its stale plan", async t => {
  const state = await fixture(t, { clusterCount: 1 });
  const entered = deferred();
  const resume = deferred();
  let firstSave = true;
  const wrapped = storageProxy(state.storage, {
    saveMemories: async (userId, memories, options) => {
      if (firstSave) {
        firstSave = false;
        entered.resolve();
        await resume.promise;
      }
      return state.storage.saveMemories(userId, memories, options);
    }
  });
  const recovery = createRecoveryManager({ storage: wrapped, journal: state.journal, userId: USER, clock: () => BASE + 4000, recoveryGraceMs: 1 });
  const first = execute(recovery, state.plan);
  await entered.promise;
  let secondSettled = false;
  const second = execute(recovery, state.plan).then(
    () => { secondSettled = true; return null; },
    error => { secondSettled = true; return error; }
  );
  await nextTurn();
  assert.equal(secondSettled, false);
  resume.resolve();
  await first;
  assert.equal((await second).code, "STALE_RECOVERY_PLAN");
});

test("different users use independent logical locks", async t => {
  const directory = temp(t);
  const storage = new JsonMemoryStorage(directory);
  const left = await fixture(t, { directory, storage, userId: USER, clusterCount: 1 });
  const right = await fixture(t, { directory, storage, userId: OTHER_USER, clusterCount: 1 });
  const entered = deferred();
  const resume = deferred();
  const wrapped = storageProxy(storage, {
    saveMemories: async (userId, memories, options) => {
      if (userId === USER) {
        entered.resolve();
        await resume.promise;
      }
      return storage.saveMemories(userId, memories, options);
    }
  });
  const leftRecovery = createRecoveryManager({ storage: wrapped, journal: left.journal, userId: USER, clock: () => BASE + 4000, recoveryGraceMs: 1 });
  const rightRecovery = createRecoveryManager({ storage: wrapped, journal: right.journal, userId: OTHER_USER, clock: () => BASE + 4000, recoveryGraceMs: 1 });
  const leftRun = execute(leftRecovery, left.plan);
  await entered.promise;
  const rightReport = await execute(rightRecovery, right.plan);
  assert.equal(rightReport.status, "completed");
  resume.resolve();
  await leftRun;
});

test("dataset changed while recovery waits yields STALE_RECOVERY_PLAN without recovery mutation", async t => {
  const state = await fixture(t, { clusterCount: 1 });
  const held = await state.storage.acquireLock(USER);
  const pending = execute(state.recovery, state.plan);
  const memories = await state.storage.loadMemories(USER);
  memories[0].processing.updated_at += 1;
  memories[0].processing.attempt_id = "different-attempt";
  await state.storage.saveMemories(USER, memories, { lockHandle: held });
  await state.storage.releaseLock(held);
  await assert.rejects(pending, { code: "STALE_RECOVERY_PLAN" });
  assert.equal((await state.storage.getMemory(USER, memories[0].id)).processing.state, "synthesizing");
});

test("foreign and forged handles are rejected before failure mutation", async t => {
  const state = await fixture(t, { clusterCount: 1 });
  const other = await state.storage.acquireLock(OTHER_USER);
  const foreignStorage = new JsonMemoryStorage(temp(t));
  const foreignManagerHandle = await foreignStorage.acquireLock(USER);
  const input = {
    storage: state.storage,
    plan: state.plans[0],
    failedAt: BASE + 1,
    error: { code: "RECOVERY_INTERRUPTED_ATTEMPT", message: "Synthetic failure", retryable: true }
  };
  await assert.rejects(failClaimedSources({ ...input, lockHandle: other }), { code: "LOCK_KEY_MISMATCH" });
  await state.storage.releaseLock(other);
  await assert.rejects(failClaimedSources({ ...input, lockHandle: foreignManagerHandle }), { code: "LOCK_INVALID_HANDLE" });
  await foreignStorage.releaseLock(foreignManagerHandle);
  await assert.rejects(failClaimedSources({ ...input, lockHandle: Object.freeze({}) }), { code: "LOCK_INVALID_HANDLE" });
  assert.equal((await state.storage.getMemory(USER, state.memories[0].id)).processing.state, "synthesizing");
});

test("failure immediately after acquire releases the lock without a data mutation", async t => {
  const state = await fixture(t, { clusterCount: 1 });
  let releases = 0;
  const wrapped = storageProxy(state.storage, {
    validateLock: () => { throw new Error("after acquire sentinel"); },
    releaseLock: async handle => { releases++; return state.storage.releaseLock(handle); }
  });
  const recovery = createRecoveryManager({ storage: wrapped, journal: state.journal, userId: USER, clock: () => BASE + 4000, recoveryGraceMs: 1 });
  await assert.rejects(execute(recovery, state.plan), error => {
    assert.equal(error.code, "RECOVERY_DATA_ACTION_FAILED");
    assert.doesNotMatch(error.message, /sentinel/);
    return true;
  });
  assert.equal(releases, 1);
  assert.equal((await state.storage.getMemory(USER, state.memories[0].id)).processing.state, "synthesizing");
  assert.equal((await state.storage.inspectUserLock(USER, { staleAfterMs: 1 })).exists, false);
});

test("second data-action failure rolls the first action back and emits no terminal ACK", async t => {
  const state = await fixture(t);
  let saves = 0;
  const wrapped = storageProxy(state.storage, {
    saveMemories: async (userId, memories, options) => {
      saves++;
      if (saves === 2) throw new Error("second action sentinel");
      return state.storage.saveMemories(userId, memories, options);
    }
  });
  const recovery = createRecoveryManager({ storage: wrapped, journal: state.journal, userId: USER, clock: () => BASE + 4000, recoveryGraceMs: 1 });
  await assert.rejects(execute(recovery, state.plan), error => {
    assert.equal(error.code, "RECOVERY_DATA_ACTION_FAILED");
    assert.doesNotMatch(error.message, /sentinel/);
    return true;
  });
  assert.equal(saves, 3);
  for (const memory of state.memories) {
    const current = await state.storage.getMemory(USER, memory.id);
    assert.equal(current.processing.state, "synthesizing");
    assert.equal(current.processing.revision, 2);
  }
  assert.equal((await state.journal.readAll()).some(event => event.event_type === "SOURCES_FAILED"), false);
});

test("post-action verification failure uses the same-lock rollback", async t => {
  const state = await fixture(t, { clusterCount: 1 });
  let loads = 0;
  let injected = false;
  const wrapped = storageProxy(state.storage, {
    loadMemories: async userId => {
      loads++;
      if (!injected && loads === 3) {
        injected = true;
        throw new Error("verification sentinel");
      }
      return state.storage.loadMemories(userId);
    }
  });
  const recovery = createRecoveryManager({ storage: wrapped, journal: state.journal, userId: USER, clock: () => BASE + 4000, recoveryGraceMs: 1 });
  await assert.rejects(execute(recovery, state.plan), { code: "RECOVERY_DATA_ACTION_FAILED" });
  const current = await state.storage.getMemory(USER, state.memories[0].id);
  assert.equal(current.processing.state, "synthesizing");
  assert.equal(current.processing.revision, 2);
});

test("release failure is sanitized and never reports false success", async t => {
  const state = await fixture(t, { clusterCount: 1 });
  const wrapped = storageProxy(state.storage, {
    releaseLock: async handle => {
      await state.storage.releaseLock(handle);
      throw new Error("private release sentinel");
    }
  });
  const recovery = createRecoveryManager({ storage: wrapped, journal: state.journal, userId: USER, clock: () => BASE + 4000, recoveryGraceMs: 1 });
  await assert.rejects(execute(recovery, state.plan), error => {
    assert.equal(error.code, "RECOVERY_LOCK_RELEASE_FAILED");
    assert.equal(error.status, "unknown");
    assert.doesNotMatch(error.message, /private release sentinel/);
    return true;
  });
  assert.equal((await state.journal.readAll()).some(event => event.event_type === "SOURCES_FAILED"), false);
});

test("journal ACK failure returns reconciliation and storage-first retry is idempotent", async t => {
  const state = await fixture(t, { clusterCount: 1 });
  let failAck = true;
  const journal = {
    ...state.journal,
    append: async event => {
      if (failAck && event.event_type === "SOURCES_FAILED") {
        failAck = false;
        throw new Error("private journal sentinel");
      }
      return state.journal.append(event);
    }
  };
  const recovery = createRecoveryManager({ storage: state.storage, journal, userId: USER, clock: () => BASE + 4000, recoveryGraceMs: 1 });
  const report = await execute(recovery, state.plan);
  assert.equal(report.status, "needs_reconciliation");
  assert.equal(report.reasonCode, "NEEDS_RECONCILIATION");
  assert.doesNotMatch(JSON.stringify(report), /private journal sentinel/);
  const revision = (await state.storage.getMemory(USER, state.memories[0].id)).processing.revision;

  const retryManager = createRecoveryManager({ storage: state.storage, journal: state.journal, userId: USER, clock: () => BASE + 5000, recoveryGraceMs: 1 });
  const retryPlan = await retryManager.buildRecoveryPlan({ generatedAt: BASE + 6000 });
  assert.equal(retryPlan.actions.some(action => action.action === RECOVERY_ACTIONS.RECORD_RECOVERED_SOURCE_FAILURE), true);
  assert.equal((await execute(retryManager, retryPlan)).status, "completed");
  assert.equal((await state.storage.getMemory(USER, state.memories[0].id)).processing.revision, revision);
  assert.equal((await state.storage.loadMemories(USER)).filter(memory => memory.memoryKind === "super_memory").length, 0);
});

test("journal ACKs run only after user-lock release and preserve multi-cluster targeting/privacy", async t => {
  const state = await fixture(t);
  const journal = {
    ...state.journal,
    append: async event => {
      const lock = await state.storage.inspectUserLock(USER, { staleAfterMs: 1 });
      assert.equal(lock.exists, false);
      return state.journal.append(event);
    }
  };
  const recovery = createRecoveryManager({ storage: state.storage, journal, userId: USER, clock: () => BASE + 4000, recoveryGraceMs: 1 });
  await execute(recovery, state.plan);
  const events = await state.journal.readAll();
  assert.deepEqual(events.filter(event => event.event_type === "SOURCES_FAILED").map(event => event.cluster_id).sort(), ["cluster-0", "cluster-1"]);
  const rawJournal = fs.readFileSync(path.join(state.directory, state.journal.fileName), "utf8");
  assert.doesNotMatch(rawJournal, new RegExp(PRIVATE_SENTINEL));
  assert.doesNotMatch(JSON.stringify(events), /prompt|raw_output|embedding|centroid|sourceSnapshot/);
});

test("lock acquisition timeout is controlled and leaves sources unchanged", async t => {
  const state = await fixture(t, { clusterCount: 1 });
  const held = await state.storage.acquireLock(USER);
  await assert.rejects(execute(state.recovery, state.plan, {
    lockOptions: { timeoutMs: 20, retryIntervalMs: 5 }
  }), { code: "LOCK_ACQUIRE_TIMEOUT" });
  await state.storage.releaseLock(held);
  assert.equal((await state.storage.getMemory(USER, state.memories[0].id)).processing.state, "synthesizing");
});
