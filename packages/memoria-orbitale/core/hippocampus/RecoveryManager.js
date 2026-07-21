"use strict";

const { createHash } = require("node:crypto");
const { validateSuperMemoryRecord } = require("../consolidation/SuperMemoryRecord");
const {
  createJournalSourceClaimDescriptor,
  failClaimedSources,
  restoreSourceClaimPlanFromJournal
} = require("./SourceClaimTransaction");

const RECOVERY_SCHEMA_VERSION = 1;
const RECOVERY_ACTIONS = Object.freeze({
  NOOP_ALREADY_COMPLETE: "NOOP_ALREADY_COMPLETE",
  RECORD_RECOVERED_COMMIT_SUCCESS: "RECORD_RECOVERED_COMMIT_SUCCESS",
  MARK_INTERRUPTED_CLAIM_FAILED: "MARK_INTERRUPTED_CLAIM_FAILED",
  RECORD_ORPHAN_CLUSTER: "RECORD_ORPHAN_CLUSTER",
  RECORD_RECOVERED_SOURCE_FAILURE: "RECORD_RECOVERED_SOURCE_FAILURE",
  RECORD_RUN_RECONCILED: "RECORD_RUN_RECONCILED",
  REPAIR_TRUNCATED_JOURNAL_TAIL: "REPAIR_TRUNCATED_JOURNAL_TAIL",
  RECOVER_STALE_USER_LOCK: "RECOVER_STALE_USER_LOCK",
  BLOCK_INCONSISTENT_STATE: "BLOCK_INCONSISTENT_STATE",
  BLOCK_UNATTRIBUTED_SYNTHESIZING: "BLOCK_UNATTRIBUTED_SYNTHESIZING"
});
const RECOVERY_REASON_CODES = Object.freeze({
  RECOVERY_REQUIRED: "RECOVERY_REQUIRED",
  GRACE_PERIOD_ACTIVE: "GRACE_PERIOD_ACTIVE",
  SNAPSHOT_CHANGED: "SNAPSHOT_CHANGED",
  AMBIGUOUS_STATE: "AMBIGUOUS_STATE",
  STALE_RECOVERY_PLAN: "STALE_RECOVERY_PLAN",
  NEEDS_RECONCILIATION: "NEEDS_RECONCILIATION"
});
const HEX_64 = /^[a-f0-9]{64}$/;

class RecoveryManagerError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "RecoveryManagerError";
    this.code = code;
    Object.assign(this, details);
  }
}

function fail(code, message, details) {
  throw new RecoveryManagerError(code, message, details);
}
function plain(value) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (plain(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)]));
  return value;
}
function freeze(value) {
  Object.freeze(value);
  for (const child of Object.values(value)) {
    if (child && typeof child === "object" && !Object.isFrozen(child)) freeze(child);
  }
  return value;
}
function stable(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
}
function sha(value) {
  return createHash("sha256").update(typeof value === "string" ? value : stable(value), "utf8").digest("hex");
}
function sortedById(records) {
  return records.slice().sort((left, right) => String(left.id).localeCompare(String(right.id)));
}

function createRecoveryManager(options = {}) {
  if (!plain(options) || !options.storage || !options.journal ||
      typeof options.journal.inspect !== "function" || typeof options.clock !== "function") {
    fail("INVALID_OPTIONS", "Recovery storage, journal and clock are required");
  }
  const storage = options.storage;
  for (const method of ["acquireLock", "releaseLock", "validateLock", "loadMemories", "saveMemories"]) {
    if (typeof storage[method] !== "function") fail("INVALID_OPTIONS", "Recovery storage lock contract is incomplete");
  }
  const userId = options.userId || storage.defaultUserId;
  if (typeof userId !== "string" || !userId) fail("INVALID_OPTIONS", "Recovery userId is required for unscoped storage");
  const grace = options.recoveryGraceMs === undefined ? 300000 : options.recoveryGraceMs;
  if (!Number.isInteger(grace) || grace < 0) fail("INVALID_OPTIONS", "recoveryGraceMs must be non-negative");

  async function datasetSnapshot() {
    const memories = await storage.loadMemories(userId);
    const clusters = typeof storage.loadClusters === "function" ? await storage.loadClusters(userId) : [];
    return {
      memories,
      clusters,
      memoryFingerprint: sha(sortedById(memories)),
      clusterFingerprint: sha(sortedById(clusters))
    };
  }

  async function inspect() {
    const journal = await options.journal.inspect();
    const incomplete = journal.valid ? await options.journal.findIncompleteRuns() : [];
    const dataset = await datasetSnapshot();
    const lock = typeof storage.inspectUserLock === "function"
      ? await storage.inspectUserLock(userId, { staleAfterMs: Math.max(1, grace) })
      : null;
    return freeze({
      journal,
      incompleteRuns: incomplete,
      memorySnapshotFingerprint: dataset.memoryFingerprint,
      clusterSnapshotFingerprint: dataset.clusterFingerprint,
      staleUserLock: lock,
      recoveryRequired: !journal.valid || incomplete.length > 0 || Boolean(lock?.staleCandidate)
    });
  }

  async function buildRecoveryPlan(request = {}) {
    const generatedAt = request.generatedAt === undefined ? options.clock() : request.generatedAt;
    if (!Number.isSafeInteger(generatedAt) || generatedAt < 0) fail("INVALID_REQUEST", "generatedAt is invalid");

    const journal = await options.journal.inspect();
    const incompleteRuns = journal.valid ? await options.journal.findIncompleteRuns() : [];
    const dataset = await datasetSnapshot();
    const staleUserLock = typeof storage.inspectUserLock === "function"
      ? await storage.inspectUserLock(userId, { staleAfterMs: Math.max(1, grace) })
      : null;
    const state = { journal, incompleteRuns, staleUserLock };
    const memories = dataset.memories;
    const actions = [];
    const blockedItems = [];
    const superMemories = [];

    for (const memory of memories) {
      if (memory?.memoryKind !== "super_memory") continue;
      try {
        superMemories.push(validateSuperMemoryRecord(memory));
      } catch {
        blockedItems.push({ action: RECOVERY_ACTIONS.BLOCK_INCONSISTENT_STATE, id: memory.id || null, reasonCode: "INVALID_SUPER_MEMORY" });
      }
    }
    const keys = new Map();
    for (const superMemory of superMemories) {
      if (keys.has(superMemory.idempotency_key)) {
        blockedItems.push({ action: RECOVERY_ACTIONS.BLOCK_INCONSISTENT_STATE, id: superMemory.id, reasonCode: "DUPLICATE_SEMANTIC_SUPER_MEMORY" });
      } else {
        keys.set(superMemory.idempotency_key, superMemory.id);
      }
    }

    for (const run of state.incompleteRuns) {
      if (run.blocked) {
        blockedItems.push({ action: RECOVERY_ACTIONS.BLOCK_INCONSISTENT_STATE, runId: run.runId, reasonCode: run.reasonCodes[0] || RECOVERY_REASON_CODES.AMBIGUOUS_STATE });
        continue;
      }
      const events = await options.journal.getRunEvents(run.runId);
      let recoverableClusters = 0;
      for (const cluster of run.clusters) {
        if (cluster.terminal) continue;
        const clusterEvents = events.filter(event => event.cluster_id === cluster.clusterId);
        const oldEnough = generatedAt - cluster.lastTimestamp >= grace;
        const claimEvent = [...clusterEvents].reverse().find(event => event.event_type === "SOURCES_CLAIMED");
        const superMemory = superMemories.find(item => item.cluster_id === cluster.clusterRecordId || item.cluster_id === cluster.clusterId);
        if (superMemory && ["COMMIT_STARTED_NO_RESULT", "SYNTHESIS_SUCCEEDED_NO_COMMIT"].includes(cluster.classification)) {
          const usedOk = superMemory.source_memory_ids.every(id => {
            const memory = memories.find(item => item.id === id);
            return memory?.processing?.state === "consolidated" && memory.consolidation?.super_memory_id === superMemory.id;
          });
          const rejectedOk = superMemory.rejected_source_ids.every(id => memories.find(item => item.id === id)?.processing?.state === "failed");
          if (usedOk && rejectedOk) {
            actions.push({ action: RECOVERY_ACTIONS.RECORD_RECOVERED_COMMIT_SUCCESS, runId: run.runId, clusterId: cluster.clusterId, transactionId: superMemory.consolidation?.transaction_id || null, superMemoryId: superMemory.id });
            recoverableClusters++;
          } else {
            blockedItems.push({ action: RECOVERY_ACTIONS.BLOCK_INCONSISTENT_STATE, runId: run.runId, clusterId: cluster.clusterId, reasonCode: "COMMIT_STATE_MIXED" });
          }
          continue;
        }
        if (cluster.classification === "CLUSTER_PERSISTED_NO_CLAIM") {
          actions.push({ action: RECOVERY_ACTIONS.RECORD_ORPHAN_CLUSTER, runId: run.runId, clusterId: cluster.clusterId });
          recoverableClusters++;
          continue;
        }
        const interrupted = [
          "CLAIMED_NO_SYNTHESIS", "SYNTHESIS_STARTED_NO_RESULT", "SYNTHESIS_SUCCEEDED_NO_COMMIT",
          "COMMIT_STARTED_NO_RESULT", "SYNTHESIS_FAILED_NO_SOURCE_TERMINAL", "COMMIT_FAILED_NO_SOURCE_TERMINAL"
        ].includes(cluster.classification);
        if (interrupted) {
          if (!oldEnough) {
            blockedItems.push({ action: RECOVERY_ACTIONS.BLOCK_INCONSISTENT_STATE, runId: run.runId, clusterId: cluster.clusterId, reasonCode: RECOVERY_REASON_CODES.GRACE_PERIOD_ACTIVE });
            continue;
          }
          let claimPlan = null;
          try {
            if (claimEvent?.details?.claimPlan) claimPlan = restoreSourceClaimPlanFromJournal(claimEvent.details.claimPlan, userId);
          } catch {
            // Invalid or cross-scope journal claims remain blocked without exposing content.
          }
          const ids = claimEvent?.source_memory_ids || [];
          const attributable = claimPlan && claimPlan.claimId === cluster.claimId &&
            claimPlan.attemptId === cluster.attemptId && ids.length > 0 && ids.every(id => {
              const memory = memories.find(item => item.id === id);
              return memory?.processing?.state === "synthesizing" && memory.processing.attempt_id === cluster.attemptId;
            });
          const persistedFailureCode = claimPlan && ids.length > 0
            ? ["HIPPOCAMPUS_CLUSTER_FAILED", "RECOVERY_INTERRUPTED_ATTEMPT"].find(errorCode => ids.every(id => {
              const source = claimPlan.sources.find(item => item.memoryId === id);
              const processing = memories.find(item => item.id === id)?.processing;
              return source && processing?.state === "failed" &&
                processing.revision === source.claimedProcessing.revision + 1 &&
                processing.attempt_id === cluster.attemptId &&
                processing.error?.code === errorCode && processing.error?.retryable === true;
            }))
            : null;
          if (persistedFailureCode) {
            actions.push({ action: RECOVERY_ACTIONS.RECORD_RECOVERED_SOURCE_FAILURE, runId: run.runId, clusterId: cluster.clusterId, correlationKey: cluster.correlationKey, errorCode: persistedFailureCode, claimDescriptor: createJournalSourceClaimDescriptor(claimPlan) });
            recoverableClusters++;
          } else if (attributable) {
            actions.push({ action: RECOVERY_ACTIONS.MARK_INTERRUPTED_CLAIM_FAILED, runId: run.runId, clusterId: cluster.clusterId, correlationKey: cluster.correlationKey, claimDescriptor: createJournalSourceClaimDescriptor(claimPlan) });
            recoverableClusters++;
          } else {
            blockedItems.push({ action: RECOVERY_ACTIONS.BLOCK_INCONSISTENT_STATE, runId: run.runId, clusterId: cluster.clusterId, reasonCode: "CLAIM_NOT_ATTRIBUTABLE" });
          }
          continue;
        }
        blockedItems.push({ action: RECOVERY_ACTIONS.BLOCK_INCONSISTENT_STATE, runId: run.runId, clusterId: cluster.clusterId, reasonCode: RECOVERY_REASON_CODES.AMBIGUOUS_STATE });
      }
      const nonterminalCount = run.clusters.filter(cluster => !cluster.terminal).length;
      const runBlocked = blockedItems.some(item => item.runId === run.runId);
      if (!runBlocked && recoverableClusters === nonterminalCount) {
        actions.push({ action: RECOVERY_ACTIONS.RECORD_RUN_RECONCILED, runId: run.runId });
      }
    }

    const attributed = new Set(state.incompleteRuns.flatMap(run => run.attemptIds));
    for (const memory of memories) {
      if (memory?.processing?.state === "synthesizing" && !attributed.has(memory.processing.attempt_id)) {
        blockedItems.push({ action: RECOVERY_ACTIONS.BLOCK_UNATTRIBUTED_SYNTHESIZING, id: memory.id, reasonCode: "UNATTRIBUTED_ATTEMPT" });
      }
    }
    if (state.journal.tailIncomplete) actions.push({ action: RECOVERY_ACTIONS.REPAIR_TRUNCATED_JOURNAL_TAIL });
    if (state.staleUserLock?.staleCandidate) actions.push({ action: RECOVERY_ACTIONS.RECOVER_STALE_USER_LOCK });
    actions.sort((left, right) => stable(left).localeCompare(stable(right)));
    blockedItems.sort((left, right) => stable(left).localeCompare(stable(right)));

    const plan = {
      schemaVersion: RECOVERY_SCHEMA_VERSION,
      recoveryPlanId: "",
      userIdHash: options.journal.userIdHash,
      journalFingerprint: state.journal.journalFingerprint,
      memorySnapshotFingerprint: dataset.memoryFingerprint,
      clusterSnapshotFingerprint: dataset.clusterFingerprint,
      generatedAt,
      dryRun: true,
      actions,
      blockedItems,
      stats: { actionCount: actions.length, blockedCount: blockedItems.length, incompleteRunCount: state.incompleteRuns.length }
    };
    plan.recoveryPlanId = sha({ ...plan, recoveryPlanId: undefined });
    return freeze(plan);
  }

  function validatePlan(plan) {
    if (!plain(plan) || plan.schemaVersion !== RECOVERY_SCHEMA_VERSION ||
        !HEX_64.test(plan.recoveryPlanId || "") || !HEX_64.test(plan.journalFingerprint || "") ||
        !HEX_64.test(plan.memorySnapshotFingerprint || "") || !HEX_64.test(plan.clusterSnapshotFingerprint || "") ||
        plan.userIdHash !== options.journal.userIdHash || !Array.isArray(plan.actions) ||
        !Array.isArray(plan.blockedItems) || !plain(plan.stats)) {
      fail("INVALID_PLAN", "Recovery plan is invalid");
    }
    const copy = clone(plan);
    const expectedId = sha({ ...copy, recoveryPlanId: undefined });
    if (expectedId !== copy.recoveryPlanId) fail("INVALID_PLAN", "Recovery plan identity is invalid");
    return freeze(copy);
  }

  function verifyFailureAction(action, memories) {
    const claimPlan = restoreSourceClaimPlanFromJournal(action.claimDescriptor, userId);
    const expectedCode = action.action === RECOVERY_ACTIONS.MARK_INTERRUPTED_CLAIM_FAILED
      ? "RECOVERY_INTERRUPTED_ATTEMPT"
      : action.errorCode || "HIPPOCAMPUS_CLUSTER_FAILED";
    for (const source of claimPlan.sources) {
      const processing = memories.find(memory => memory.id === source.memoryId)?.processing;
      if (processing?.state !== "failed" || processing.attempt_id !== claimPlan.attemptId ||
          processing.revision !== source.claimedProcessing.revision + 1 ||
          processing.error?.code !== expectedCode || processing.error?.retryable !== true) {
        fail("RECOVERY_POSTCONDITION_FAILED", "Recovered source state could not be verified");
      }
    }
  }

  function journalEventsForAction(action) {
    if ([RECOVERY_ACTIONS.MARK_INTERRUPTED_CLAIM_FAILED, RECOVERY_ACTIONS.RECORD_RECOVERED_SOURCE_FAILURE].includes(action.action)) {
      const claimPlan = restoreSourceClaimPlanFromJournal(action.claimDescriptor, userId);
      return [{
        event_type: "SOURCES_FAILED", run_id: action.runId, mode: "recovery", phase: "failure", status: "failed",
        timestamp: options.clock(), cluster_id: action.clusterId, attempt_id: claimPlan.attemptId,
        source_memory_ids: claimPlan.sources.map(source => source.memoryId),
        details: {
          action: action.action,
          claimId: claimPlan.claimId,
          errorCode: action.action === RECOVERY_ACTIONS.MARK_INTERRUPTED_CLAIM_FAILED ? "RECOVERY_INTERRUPTED_ATTEMPT" : action.errorCode || "HIPPOCAMPUS_CLUSTER_FAILED",
          retryable: true
        }
      }];
    }
    if ([RECOVERY_ACTIONS.RECORD_RECOVERED_COMMIT_SUCCESS, RECOVERY_ACTIONS.RECORD_ORPHAN_CLUSTER].includes(action.action)) {
      return [{
        event_type: "RUN_RECONCILED", run_id: action.runId, mode: "recovery", phase: "recovery", status: "reconciled",
        timestamp: options.clock(), cluster_id: action.clusterId, transaction_id: action.transactionId || null,
        details: { action: action.action }
      }];
    }
    if (action.action === RECOVERY_ACTIONS.RECORD_RUN_RECONCILED) {
      return [{
        event_type: "RUN_RECONCILED", run_id: action.runId, mode: "recovery", phase: "recovery", status: "reconciled",
        timestamp: options.clock(), details: { action: action.action }
      }];
    }
    return [];
  }

  async function executeRecovery(request = {}) {
    if (!plain(request) || request.execute !== true || request.confirmRecovery !== "RECOVER_HIPPOCAMPUS_V1") {
      fail("RECOVERY_CONFIRMATION_REQUIRED", "Explicit recovery confirmation is required");
    }
    const plan = validatePlan(request.plan);
    if (plan.blockedItems.length) fail("RECOVERY_BLOCKED", "Recovery plan contains blocked states");

    let expectedJournalFingerprint = plan.journalFingerprint;
    const tailRepair = plan.actions.find(action => action.action === RECOVERY_ACTIONS.REPAIR_TRUNCATED_JOURNAL_TAIL);
    if (tailRepair) {
      await options.journal.repairTail({ commitRepair: true, confirmRepair: "REPAIR_HIPPOCAMPUS_JOURNAL_V1" });
      expectedJournalFingerprint = (await options.journal.inspect()).journalFingerprint;
    }
    const staleRecovery = plan.actions.find(action => action.action === RECOVERY_ACTIONS.RECOVER_STALE_USER_LOCK);
    if (staleRecovery) {
      await storage.recoverStaleUserLock(userId, {
        staleAfterMs: Math.max(1, grace), recover: true, confirmRecovery: "RECOVER_STALE_LOCK_V1"
      });
    }

    let lockHandle;
    let releaseError = null;
    let dataError = null;
    let dataWrites = 0;
    let before = null;
    try {
      lockHandle = await storage.acquireLock(userId, request.lockOptions);
      try {
        storage.validateLock(userId, lockHandle);
        const journalState = await options.journal.inspect();
        before = await datasetSnapshot();
        if (!journalState.valid || journalState.journalFingerprint !== expectedJournalFingerprint ||
            before.memoryFingerprint !== plan.memorySnapshotFingerprint ||
            before.clusterFingerprint !== plan.clusterSnapshotFingerprint) {
          fail(RECOVERY_REASON_CODES.STALE_RECOVERY_PLAN, "Recovery plan no longer matches the locked state");
        }

        for (const action of plan.actions) {
          if (action.action !== RECOVERY_ACTIONS.MARK_INTERRUPTED_CLAIM_FAILED) continue;
          const claimPlan = restoreSourceClaimPlanFromJournal(action.claimDescriptor, userId);
          const result = await failClaimedSources({
            storage,
            plan: claimPlan,
            failedAt: options.clock(),
            error: {
              code: "RECOVERY_INTERRUPTED_ATTEMPT",
              message: "Interrupted synthesis attempt recovered as failed",
              retryable: true
            },
            lockHandle
          });
          dataWrites += result.writesAttempted;
        }

        const after = await datasetSnapshot();
        if (after.clusterFingerprint !== plan.clusterSnapshotFingerprint) {
          fail("RECOVERY_POSTCONDITION_FAILED", "Cluster snapshot changed during recovery");
        }
        for (const action of plan.actions) {
          if ([RECOVERY_ACTIONS.MARK_INTERRUPTED_CLAIM_FAILED, RECOVERY_ACTIONS.RECORD_RECOVERED_SOURCE_FAILURE].includes(action.action)) {
            verifyFailureAction(action, after.memories);
          }
        }
      } catch (error) {
        dataError = error;
        if (dataWrites > 0 && before) {
          try {
            await storage.saveMemories(userId, before.memories, { lockHandle });
            const restored = await datasetSnapshot();
            if (restored.memoryFingerprint !== before.memoryFingerprint || restored.clusterFingerprint !== before.clusterFingerprint) {
              throw new Error("rollback verification failed");
            }
          } catch {
            dataError = new RecoveryManagerError(
              "RECOVERY_ROLLBACK_FAILED_STATE_UNKNOWN",
              "Recovery data action and rollback failed",
              { status: "unknown" }
            );
          }
        }
      }
    } finally {
      if (lockHandle) {
        try {
          await storage.releaseLock(lockHandle);
        } catch {
          releaseError = new RecoveryManagerError(
            "RECOVERY_LOCK_RELEASE_FAILED",
            "Recovery user lock release failed",
            { status: "unknown" }
          );
        }
      }
    }
    if (releaseError) throw releaseError;
    if (dataError) {
      if (dataError instanceof RecoveryManagerError) throw dataError;
      throw new RecoveryManagerError("RECOVERY_DATA_ACTION_FAILED", "Recovery data action failed", { status: "blocked" });
    }

    const recoveryRunId = `recovery:${plan.recoveryPlanId}`;
    const events = [{
      event_type: "RECOVERY_STARTED", run_id: recoveryRunId, mode: "recovery", phase: "recovery",
      status: "started", timestamp: options.clock(), details: { recoveryPlanId: plan.recoveryPlanId }
    }];
    for (const action of plan.actions) {
      events.push(...journalEventsForAction(action));
      events.push({
        event_type: "RECOVERY_ACTION", run_id: recoveryRunId, mode: "recovery", phase: "recovery",
        status: "completed", timestamp: options.clock(), cluster_id: action.clusterId || null,
        details: { action: action.action, targetRunId: action.runId || null }
      });
    }
    events.push({
      event_type: "RECOVERY_COMPLETED", run_id: recoveryRunId, mode: "recovery", phase: "recovery",
      status: "completed", timestamp: options.clock(), details: { executed: plan.actions.length }
    });

    let acknowledged = 0;
    try {
      for (const event of events) {
        await options.journal.append(event);
        acknowledged++;
      }
    } catch {
      return freeze({
        recoveryPlanId: plan.recoveryPlanId,
        executed: plan.actions.length,
        acknowledged,
        idempotentReplay: dataWrites === 0,
        status: "needs_reconciliation",
        reasonCode: RECOVERY_REASON_CODES.NEEDS_RECONCILIATION
      });
    }
    return freeze({
      recoveryPlanId: plan.recoveryPlanId,
      executed: plan.actions.length,
      acknowledged,
      idempotentReplay: dataWrites === 0,
      status: "completed"
    });
  }

  return Object.freeze({ inspect, buildRecoveryPlan, executeRecovery });
}

module.exports = {
  RECOVERY_SCHEMA_VERSION,
  RECOVERY_ACTIONS,
  RECOVERY_REASON_CODES,
  RecoveryManagerError,
  createRecoveryManager
};
