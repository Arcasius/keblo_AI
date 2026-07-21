"use strict";

const { randomUUID } = require("node:crypto");
const { selectConsolidationCandidates } = require("../consolidation/CandidateSelector");
const { buildConsolidationPlan, buildConsolidationPlanScalable } = require("../consolidation/ConsolidationPlan");
const { createClusterEngineAdapter } = require("../clustering/ClusterEngineAdapter");
const { createClusterRecord } = require("../clustering/ClusterRecord");
const { createSynthesisEngine } = require("../synthesis/SynthesisEngine");
const { createProcessingTransitionPlan } = require("../consolidation/ProcessingState");
const { createConsolidationCommitPlan, commitConsolidation } = require("../consolidation/ConsolidationTransaction");
const { createMaturityGate } = require("./MaturityGate");
const {
  createSourceClaimPlan,
  createJournalSourceClaimDescriptor,
  claimSources,
  failClaimedSources
} = require("./SourceClaimTransaction");
const { STORAGE_CAPABILITIES, assertStorageCapabilities } = require("../StorageCapabilityContract");

const HIPPOCAMPUS_DAEMON_SCHEMA_VERSION = 1;
const HIPPOCAMPUS_MODES = Object.freeze({ DRY_RUN: "dry-run", COMMIT: "commit" });
const HIPPOCAMPUS_PHASES = Object.freeze({ PLAN: "plan", CLUSTER: "cluster", SYNTHESIS: "synthesis", COMMIT: "commit" });
const HIPPOCAMPUS_RECOVERY_STATES = Object.freeze({
  UNKNOWN: "unknown",
  READY: "ready",
  RECOVERY_REQUIRED: "recovery_required",
  NEEDS_RECONCILIATION: "needs_reconciliation",
  BLOCKED: "blocked",
  CORRUPT: "corrupt"
});
const DAEMON_REASON_CODES = Object.freeze({
  RUN_ALREADY_ACTIVE: "RUN_ALREADY_ACTIVE",
  COMMIT_NOT_ENABLED: "COMMIT_NOT_ENABLED",
  COMMIT_CONFIRMATION_REQUIRED: "COMMIT_CONFIRMATION_REQUIRED",
  CLUSTER_NOT_MATURE: "CLUSTER_NOT_MATURE",
  MAX_CLUSTERS_DEFERRED: "MAX_CLUSTERS_DEFERRED",
  CLUSTER_FAILED: "CLUSTER_FAILED",
  EVENT_SINK_FAILED: "EVENT_SINK_FAILED",
  STATUS_NOT_INSPECTED: "STATUS_NOT_INSPECTED",
  STATUS_INSPECTION_UNAVAILABLE: "STATUS_INSPECTION_UNAVAILABLE",
  STATUS_INSPECTION_FAILED: "STATUS_INSPECTION_FAILED",
  JOURNAL_TAIL_REPAIR_REQUIRED: "JOURNAL_TAIL_REPAIR_REQUIRED",
  JOURNAL_CORRUPT: "JOURNAL_CORRUPT",
  STALE_USER_LOCK: "STALE_USER_LOCK",
  RECOVERY_STATUS_BLOCKED: "RECOVERY_STATUS_BLOCKED",
  RECOVERY_STATUS_CORRUPT: "RECOVERY_STATUS_CORRUPT",
  RECOVERY_STATUS_UNKNOWN: "RECOVERY_STATUS_UNKNOWN"
});
const COMMIT_TOKEN = "COMMIT_HIPPOCAMPUS_V1";

class HippocampusDaemonError extends Error {
  constructor(code, phase, message, details = {}) { super(message); this.name = "HippocampusDaemonError"; this.code = code; this.phase = phase; Object.assign(this, details); }
}

function isPlain(value) { return value && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)); }
function freeze(value) { Object.freeze(value); for (const child of Object.values(value)) if (child && typeof child === "object" && !Object.isFrozen(child)) freeze(child); return value; }
function providerMetadata(provider) {
  for (const key of ["providerId", "model", "version"]) if (typeof provider?.[key] !== "string" || !provider[key].trim()) throw new HippocampusDaemonError("INVALID_EMBEDDING_METADATA", "cluster", "Embedding provider metadata is required");
  return { providerId: provider.providerId, model: provider.model, version: provider.version };
}
function now(clock) { const value = clock(); if (!Number.isSafeInteger(value) || value < 0) throw new HippocampusDaemonError("INVALID_CLOCK", "run", "Clock must return epoch milliseconds"); return value; }
function stableFailureCode(error) { return typeof error?.code === "string" && /^[A-Z0-9_]+$/.test(error.code) ? error.code : "CLUSTER_FAILURE"; }

function createHippocampusDaemon(options = {}) {
  if (!isPlain(options)) throw new HippocampusDaemonError("INVALID_OPTIONS", "configuration", "Daemon options must be plain data");
  const allowed = new Set(["storage", "userId", "embeddingProvider", "modelProvider", "candidatePolicy", "clusterPolicy", "synthesisLimits", "maturityGate", "clock", "idGenerator", "intervalMs", "commitEnabled", "eventSink", "journal", "recoveryManager", "boundedPipelineAdapter"]);
  if (Object.keys(options).some(key => !allowed.has(key)) || !options.storage || typeof options.userId !== "string" || !options.userId.trim()) throw new HippocampusDaemonError("INVALID_OPTIONS", "configuration", "Storage and one userId are required");
  if (options.clock !== undefined && typeof options.clock !== "function" || options.idGenerator !== undefined && typeof options.idGenerator !== "function" || options.eventSink !== undefined && typeof options.eventSink !== "function") throw new HippocampusDaemonError("INVALID_OPTIONS", "configuration", "Injected functions are invalid");
  if (options.boundedPipelineAdapter !== undefined &&
      (!isPlain(options.boundedPipelineAdapter) ||
       typeof options.boundedPipelineAdapter.run !== "function")) {
    throw new HippocampusDaemonError("INVALID_OPTIONS", "configuration", "boundedPipelineAdapter must expose run");
  }
  const intervalMs = options.intervalMs === undefined ? 60000 : options.intervalMs;
  if (!Number.isInteger(intervalMs) || intervalMs <= 0) throw new HippocampusDaemonError("INVALID_OPTIONS", "configuration", "intervalMs must be positive");
  const clock = options.clock || Date.now;
  const idGenerator = options.idGenerator || (() => randomUUID());
  const maturityGate = options.maturityGate || createMaturityGate();
  if (typeof maturityGate.evaluate !== "function") throw new HippocampusDaemonError("INVALID_OPTIONS", "configuration", "maturityGate must expose evaluate");
  let active = false;
  let timer = null;
  let lastRun = null;
  let statusGeneration = 0;
  let recoveryStatus = freeze({
    statusHydrated: false,
    recoveryState: HIPPOCAMPUS_RECOVERY_STATES.UNKNOWN,
    recoveryRequired: null,
    incompleteRunCount: null,
    blockedRunCount: null,
    ambiguousRunCount: null,
    tailRepairRequired: null,
    staleLockDetected: null,
    journalValid: null,
    legacyPrivacyDetected: null,
    legacyPrivacyEventCount: null,
    lastInspectionAt: null,
    reasonCode: DAEMON_REASON_CODES.STATUS_NOT_INSPECTED
  });

  function statusFromInspection(inspection, recoveryPlan, inspectedAt) {
    const journal = isPlain(inspection?.journal) ? inspection.journal : {};
    const incompleteRuns = Array.isArray(inspection?.incompleteRuns) ? inspection.incompleteRuns : [];
    const planBlockedItems = Array.isArray(recoveryPlan?.blockedItems) ? recoveryPlan.blockedItems : [];
    const blockedRunIds = new Set(incompleteRuns.filter(run => run?.blocked === true).map(run => run.runId));
    for (const item of planBlockedItems) if (typeof item?.runId === "string") blockedRunIds.add(item.runId);
    const ambiguousRunCount = incompleteRuns.filter(run => run?.blocked === true ||
      run?.reasonCodes?.includes("AMBIGUOUS_STATE")).length;
    const tailRepairRequired = journal.tailIncomplete === true;
    const staleLockDetected = inspection?.staleUserLock?.staleCandidate === true;
    const journalValid = journal.valid === true;
    const reconciliationActions = new Set([
      "RECORD_RECOVERED_COMMIT_SUCCESS",
      "RECORD_RECOVERED_SOURCE_FAILURE"
    ]);
    const needsReconciliation = Array.isArray(recoveryPlan?.actions) &&
      recoveryPlan.actions.some(action => reconciliationActions.has(action?.action));
    let recoveryState;
    let reasonCode = null;
    if (!journalValid && !tailRepairRequired) {
      recoveryState = HIPPOCAMPUS_RECOVERY_STATES.CORRUPT;
      reasonCode = DAEMON_REASON_CODES.JOURNAL_CORRUPT;
    } else if (tailRepairRequired) {
      recoveryState = HIPPOCAMPUS_RECOVERY_STATES.BLOCKED;
      reasonCode = DAEMON_REASON_CODES.JOURNAL_TAIL_REPAIR_REQUIRED;
    } else if (blockedRunIds.size > 0 || planBlockedItems.length > 0) {
      recoveryState = HIPPOCAMPUS_RECOVERY_STATES.BLOCKED;
      reasonCode = DAEMON_REASON_CODES.RECOVERY_STATUS_BLOCKED;
    } else if (needsReconciliation) {
      recoveryState = HIPPOCAMPUS_RECOVERY_STATES.NEEDS_RECONCILIATION;
      reasonCode = "NEEDS_RECONCILIATION";
    } else if (incompleteRuns.length > 0 || staleLockDetected || inspection?.recoveryRequired === true) {
      recoveryState = HIPPOCAMPUS_RECOVERY_STATES.RECOVERY_REQUIRED;
      reasonCode = staleLockDetected ? DAEMON_REASON_CODES.STALE_USER_LOCK : "RECOVERY_REQUIRED";
    } else {
      recoveryState = HIPPOCAMPUS_RECOVERY_STATES.READY;
    }
    return freeze({
      statusHydrated: true,
      recoveryState,
      recoveryRequired: recoveryState !== HIPPOCAMPUS_RECOVERY_STATES.READY,
      incompleteRunCount: incompleteRuns.length,
      blockedRunCount: blockedRunIds.size,
      ambiguousRunCount,
      tailRepairRequired,
      staleLockDetected,
      journalValid,
      legacyPrivacyDetected: journal.legacyPrivacyDetected === true,
      legacyPrivacyEventCount: Number.isInteger(journal.legacyPrivacyEventCount) ? journal.legacyPrivacyEventCount : 0,
      lastInspectionAt: inspectedAt,
      reasonCode
    });
  }

  async function refreshStatus() {
    const generation = ++statusGeneration;
    const inspectedAt = now(clock);
    let next;
    if (!options.recoveryManager || typeof options.recoveryManager.inspect !== "function") {
      next = freeze({ ...recoveryStatus, lastInspectionAt: inspectedAt, reasonCode: DAEMON_REASON_CODES.STATUS_INSPECTION_UNAVAILABLE });
    } else {
      try {
        const inspection = await options.recoveryManager.inspect();
        let recoveryPlan = null;
        if (inspection?.journal?.valid === true && Array.isArray(inspection.incompleteRuns) &&
            inspection.incompleteRuns.length > 0 && typeof options.recoveryManager.buildRecoveryPlan === "function") {
          recoveryPlan = await options.recoveryManager.buildRecoveryPlan({ generatedAt: inspectedAt });
        }
        next = statusFromInspection(inspection, recoveryPlan, inspectedAt);
      } catch {
        next = freeze({
          statusHydrated: true,
          recoveryState: HIPPOCAMPUS_RECOVERY_STATES.BLOCKED,
          recoveryRequired: true,
          incompleteRunCount: 0,
          blockedRunCount: 0,
          ambiguousRunCount: 0,
          tailRepairRequired: false,
          staleLockDetected: false,
          journalValid: null,
          legacyPrivacyDetected: null,
          legacyPrivacyEventCount: null,
          lastInspectionAt: inspectedAt,
          reasonCode: DAEMON_REASON_CODES.STATUS_INSPECTION_FAILED
        });
      }
    }
    if (generation === statusGeneration) recoveryStatus = next;
    return getStatus();
  }

  function assertCommitRecoveryReady(status) {
    if (status.recoveryState === HIPPOCAMPUS_RECOVERY_STATES.READY) return;
    let code = "RECOVERY_REQUIRED";
    if (status.recoveryState === HIPPOCAMPUS_RECOVERY_STATES.BLOCKED) code = DAEMON_REASON_CODES.RECOVERY_STATUS_BLOCKED;
    else if (status.recoveryState === HIPPOCAMPUS_RECOVERY_STATES.CORRUPT) code = DAEMON_REASON_CODES.RECOVERY_STATUS_CORRUPT;
    else if (status.recoveryState === HIPPOCAMPUS_RECOVERY_STATES.UNKNOWN) code = DAEMON_REASON_CODES.RECOVERY_STATUS_UNKNOWN;
    throw new HippocampusDaemonError(code, "preflight", "Persistent recovery status does not permit commit", {
      recoveryState: status.recoveryState,
      incompleteRunCount: status.incompleteRunCount,
      reasonCode: status.reasonCode
    });
  }

  async function emit(type, runId, fields, eventFailures) {
    if (!options.eventSink) return;
    try { await options.eventSink(freeze({ schemaVersion: 1, type, runId, ...fields })); }
    catch { eventFailures.push({ reasonCode: DAEMON_REASON_CODES.EVENT_SINK_FAILED, eventType: type }); }
  }

  function validateRequest(request = {}) {
    if (!isPlain(request)) throw new HippocampusDaemonError("INVALID_REQUEST", "request", "Run request must be plain data");
    const keys = new Set(["runId", "mode", "phase", "confirmCommit", "approvedClusterIds", "maxClustersPerRun", "allowLegacyUnclassified", "continueOnClusterFailure", "constraints"]);
    if (Object.keys(request).some(key => !keys.has(key))) throw new HippocampusDaemonError("INVALID_REQUEST", "request", "Run request has unknown properties");
    const mode = request.mode || "dry-run";
    const phase = request.phase || "plan";
    if (!Object.values(HIPPOCAMPUS_MODES).includes(mode) || !Object.values(HIPPOCAMPUS_PHASES).includes(phase) || mode === "commit" && phase !== "commit") throw new HippocampusDaemonError("INVALID_REQUEST", "request", "Mode and phase are inconsistent");
    if (mode === "commit" && options.commitEnabled !== true) throw new HippocampusDaemonError(DAEMON_REASON_CODES.COMMIT_NOT_ENABLED, "authorization", "Commit is disabled");
    if (mode === "commit" && request.confirmCommit !== COMMIT_TOKEN) throw new HippocampusDaemonError(DAEMON_REASON_CODES.COMMIT_CONFIRMATION_REQUIRED, "authorization", "Commit confirmation is required");
    if (mode === "commit" && request.allowLegacyUnclassified === true) throw new HippocampusDaemonError("LEGACY_COMMIT_FORBIDDEN", "request", "Legacy sources cannot be committed");
    if (mode === "commit" && (!options.journal || typeof options.journal.append !== "function" || typeof options.journal.getRunState !== "function")) throw new HippocampusDaemonError("JOURNAL_REQUIRED", "authorization", "Commit requires a persistent journal");
    if (mode === "commit" && (!options.recoveryManager || typeof options.recoveryManager.inspect !== "function")) throw new HippocampusDaemonError("RECOVERY_MANAGER_REQUIRED", "authorization", "Commit requires a recovery manager");
    if (["synthesis", "commit"].includes(phase) && (!Number.isInteger(request.maxClustersPerRun) || request.maxClustersPerRun <= 0)) throw new HippocampusDaemonError("MAX_CLUSTERS_REQUIRED", "request", "maxClustersPerRun must be explicit and positive");
    if (request.approvedClusterIds !== undefined && (!Array.isArray(request.approvedClusterIds) || request.approvedClusterIds.some(id => typeof id !== "string"))) throw new HippocampusDaemonError("INVALID_APPROVALS", "request", "approvedClusterIds is invalid");
    if (request.allowLegacyUnclassified !== undefined && typeof request.allowLegacyUnclassified !== "boolean" || request.continueOnClusterFailure !== undefined && typeof request.continueOnClusterFailure !== "boolean") throw new HippocampusDaemonError("INVALID_REQUEST", "request", "Boolean options are invalid");
    const runId = request.runId === undefined ? idGenerator() : request.runId;
    if (typeof runId !== "string" || !runId.trim() || runId.includes(options.userId)) throw new HippocampusDaemonError("INVALID_RUN_ID", "request", "runId must be non-private");
    return { ...request, runId, mode, phase, approvedClusterIds: request.approvedClusterIds || [], allowLegacyUnclassified: request.allowLegacyUnclassified === true, continueOnClusterFailure: request.continueOnClusterFailure === true };
  }

  async function execute(request) {
    const startedAt = now(clock);
    const eventFailures = [];
    const processedClusters = [];
    const deferredClusters = [];
    const failures = [];
    let writesAttempted = 0;
    let persistentStatus = recoveryStatus;
    if (options.recoveryManager) persistentStatus = await refreshStatus();
    if (request.mode === "commit") {
      assertCommitRecoveryReady(persistentStatus);
      await options.journal.append({ event_type: "RUN_STARTED", run_id: request.runId, mode: request.mode, phase: request.phase, status: "started", timestamp: startedAt, details: {} });
    }
    await emit("run_started", request.runId, { mode: request.mode, phase: request.phase }, eventFailures);
    assertStorageCapabilities(options.storage, [STORAGE_CAPABILITIES.MEMORY_READ_ALL]);
    if (request.mode === "commit") assertStorageCapabilities(options.storage, [
      STORAGE_CAPABILITIES.MEMORY_READ_ALL, STORAGE_CAPABILITIES.MEMORY_WRITE_ALL,
      STORAGE_CAPABILITIES.CLUSTER_READ_ALL, STORAGE_CAPABILITIES.CLUSTER_READ_ONE,
      STORAGE_CAPABILITIES.CLUSTER_WRITE_ONE, STORAGE_CAPABILITIES.COMMIT_ATOMIC,
      STORAGE_CAPABILITIES.LOCK_ACQUIRE, STORAGE_CAPABILITIES.LOCK_RELEASE
    ]);
    const memories = await options.storage.loadMemories(options.userId);
    const candidateOptions = { ...options.candidatePolicy, allowLegacyUnclassified: request.allowLegacyUnclassified };
    let plan;
    let scaleTelemetry = null;
    if (request.mode === "dry-run") {
      const scalable = await buildConsolidationPlanScalable(memories, candidateOptions);
      plan = scalable.plan;
      scaleTelemetry = scalable.telemetry;
    } else {
      const { batchSize: ignoredBatchSize, budget: ignoredBudget, signal: ignoredSignal, ...policyOptions } = candidateOptions;
      plan = buildConsolidationPlan(selectConsolidationCandidates(memories, policyOptions));
    }
    await emit("plan_completed", request.runId, { candidateCount: plan.candidateIds.length }, eventFailures);
    if (request.mode === "commit") await options.journal.append({ event_type: "PLAN_COMPLETED", run_id: request.runId, mode: request.mode, phase: "plan", status: "completed", timestamp: now(clock), details: { candidateCount: plan.candidateIds.length } });
    let clusterResult = null;
    if (request.phase !== "plan") {
      if (!options.embeddingProvider) throw new HippocampusDaemonError("EMBEDDING_PROVIDER_REQUIRED", "cluster", "Embedding provider is required");
      clusterResult = await createClusterEngineAdapter({ embeddingProvider: options.embeddingProvider, policy: options.clusterPolicy }).buildClusterCandidates({ consolidationPlan: plan, memories });
      await emit("cluster_completed", request.runId, { clusterCount: clusterResult.clusters.length }, eventFailures);
    }
    const maturityResults = [];
    if (["synthesis", "commit"].includes(request.phase)) {
      if (!options.modelProvider) throw new HippocampusDaemonError("MODEL_PROVIDER_REQUIRED", "synthesis", "Model provider is required");
      const approved = [];
      for (const candidate of clusterResult.clusters) {
        const maturity = await maturityGate.evaluate(candidate, { approvedClusterIds: request.approvedClusterIds });
        maturityResults.push(maturity);
        await emit("maturity_evaluated", request.runId, { clusterId: candidate.clusterId, mature: maturity.mature, reasonCodes: maturity.reasonCodes }, eventFailures);
        if (maturity.mature) approved.push(candidate);
        else deferredClusters.push({ clusterId: candidate.clusterId, reasonCodes: [DAEMON_REASON_CODES.CLUSTER_NOT_MATURE, ...maturity.reasonCodes] });
      }
      const selected = approved.slice(0, request.maxClustersPerRun);
      for (const candidate of approved.slice(request.maxClustersPerRun)) deferredClusters.push({ clusterId: candidate.clusterId, reasonCodes: [DAEMON_REASON_CODES.MAX_CLUSTERS_DEFERRED] });
      for (const candidate of selected) {
        let claimPlan = null;
        let commitStarted = false;
        try {
          const createdAt = now(clock);
          const clusterRecord = createClusterRecord({ userId: options.userId, clusterCandidate: candidate, planId: plan.planId, createdAt, embedding: providerMetadata(options.embeddingProvider) });
          const sourceMemories = candidate.memberIds.map(id => memories.find(memory => memory.id === id));
          if (request.mode === "commit") {
            await options.journal.append({ event_type: "CLUSTER_SELECTED", run_id: request.runId, mode: request.mode, phase: "cluster", status: "selected", timestamp: now(clock), cluster_id: candidate.clusterId, source_memory_ids: candidate.memberIds, details: {} });
            await options.storage.saveCluster(options.userId, clusterRecord); writesAttempted += 1;
            await options.journal.append({ event_type: "CLUSTER_PERSISTED", run_id: request.runId, mode: request.mode, phase: "cluster", status: "persisted", timestamp: now(clock), cluster_id: candidate.clusterId, details: { clusterRecordId: clusterRecord.id } });
            const hashes = Object.fromEntries(plan.decisions.filter(item => candidate.memberIds.includes(item.memoryId)).map(item => [item.memoryId, item.contentHash]));
            claimPlan = createSourceClaimPlan({ userId: options.userId, sourceMemories, sourceIds: candidate.memberIds, attemptId: `${request.runId}:${candidate.clusterId}`, claimedAt: now(clock), sourceContentHashes: hashes });
            const claimReport = await claimSources({ storage: options.storage, plan: claimPlan }); writesAttempted += claimReport.writesAttempted;
            const journalClaim = createJournalSourceClaimDescriptor(claimPlan);
            await options.journal.append({ event_type: "SOURCES_CLAIMED", run_id: request.runId, mode: request.mode, phase: "synthesis", status: "claimed", timestamp: now(clock), cluster_id: candidate.clusterId, attempt_id: claimPlan.attemptId, source_memory_ids: candidate.memberIds, details: { claimPlan: journalClaim } });
            await options.journal.append({ event_type: "SYNTHESIS_STARTED", run_id: request.runId, mode: request.mode, phase: "synthesis", status: "started", timestamp: now(clock), cluster_id: candidate.clusterId, attempt_id: claimPlan.attemptId, source_memory_ids: candidate.memberIds, details: {} });
          }
          const synthesis = await createSynthesisEngine({ modelProvider: options.modelProvider, limits: options.synthesisLimits }).synthesize({ clusterRecord, memories: sourceMemories, constraints: request.constraints });
          if (request.mode === "commit") await options.journal.append({ event_type: "SYNTHESIS_SUCCEEDED", run_id: request.runId, mode: request.mode, phase: "synthesis", status: "succeeded", timestamp: now(clock), cluster_id: candidate.clusterId, attempt_id: claimPlan.attemptId, source_memory_ids: candidate.memberIds, details: { requestId: synthesis.requestId, providerId: synthesis.provider.providerId, model: synthesis.provider.model, version: synthesis.provider.version } });
          await emit("synthesis_completed", request.runId, { clusterId: candidate.clusterId, requestId: synthesis.requestId }, eventFailures);
          let commitReport = null;
          if (request.mode === "commit") {
            const committedAt = now(clock);
            const transitions = claimPlan.sources.map(source => createProcessingTransitionPlan({
              memoryId: source.memoryId,
              current: source.claimedProcessing,
              toState: synthesis.output.source_memory_ids.includes(source.memoryId) ? "consolidated" : "failed",
              updatedAt: committedAt,
              attemptId: claimPlan.attemptId,
              error: synthesis.output.rejected_source_ids.includes(source.memoryId) ? { code: "SYNTHESIS_SOURCE_REJECTED", message: "Source rejected by validated synthesis output", retryable: true } : undefined,
              reason: "hippocampus_consolidation_commit"
            }));
            const commitPlan = createConsolidationCommitPlan({ userId: options.userId, clusterRecord, synthesisResult: synthesis, sourceTransitionPlans: transitions, committedAt, processingAttemptId: claimPlan.attemptId });
            await options.journal.append({ event_type: "COMMIT_STARTED", run_id: request.runId, mode: request.mode, phase: "commit", status: "started", timestamp: now(clock), cluster_id: candidate.clusterId, transaction_id: commitPlan.transactionId, attempt_id: claimPlan.attemptId, source_memory_ids: candidate.memberIds, details: {} });
            commitStarted = true;
            commitReport = await commitConsolidation({ storage: options.storage, plan: commitPlan });
            if (commitReport.committed) writesAttempted += 1;
            try {
              await options.journal.append({ event_type: "COMMIT_SUCCEEDED", run_id: request.runId, mode: request.mode, phase: "commit", status: "succeeded", timestamp: now(clock), cluster_id: candidate.clusterId, transaction_id: commitPlan.transactionId, attempt_id: claimPlan.attemptId, source_memory_ids: candidate.memberIds, details: { superMemoryId: commitReport.superMemoryId, committed: commitReport.committed, idempotentReplay: commitReport.idempotentReplay } });
            } catch {
              throw new HippocampusDaemonError("NEEDS_RECONCILIATION", "journal", "Commit succeeded but journal acknowledgement failed");
            }
            await emit("commit_completed", request.runId, { clusterId: candidate.clusterId, transactionId: commitReport.transactionId, committed: commitReport.committed }, eventFailures);
          }
          processedClusters.push({ clusterId: candidate.clusterId, clusterRecordId: clusterRecord.id, synthesisRequestId: synthesis.requestId, committed: commitReport?.committed || false, idempotentReplay: commitReport?.idempotentReplay || false });
        } catch (error) {
          let failureCode = stableFailureCode(error);
          let failurePhase = error.phase || "pipeline";
          if (claimPlan && error.code !== "NEEDS_RECONCILIATION" && request.mode === "commit") {
            try {
              await options.journal.append({
                event_type: commitStarted ? "COMMIT_FAILED" : "SYNTHESIS_FAILED",
                run_id: request.runId,
                mode: request.mode,
                phase: commitStarted ? "commit" : "synthesis",
                status: "failed",
                timestamp: now(clock),
                cluster_id: candidate.clusterId,
                attempt_id: claimPlan.attemptId,
                source_memory_ids: claimPlan.sources.map(source => source.memoryId),
                details: { errorCode: failureCode, claimId: claimPlan.claimId }
              });
              const failed = await failClaimedSources({ storage: options.storage, plan: claimPlan, failedAt: now(clock), error: { code: "HIPPOCAMPUS_CLUSTER_FAILED", message: "Cluster processing failed after source claim", retryable: true } });
              writesAttempted += failed.writesAttempted;
              const persisted = await options.storage.loadMemories(options.userId);
              const persistedById = new Map(persisted.map(memory => [memory.id, memory]));
              const verified = claimPlan.sources.every(source => {
                const processing = persistedById.get(source.memoryId)?.processing;
                return processing?.state === "failed" && processing.revision === source.claimedProcessing.revision + 1 &&
                  processing.attempt_id === claimPlan.attemptId && processing.error?.code === "HIPPOCAMPUS_CLUSTER_FAILED" &&
                  processing.error?.retryable === true;
              });
              if (!verified) throw new HippocampusDaemonError("FAILURE_STATE_NOT_VERIFIED", "failure", "Persisted source failure state could not be verified");
              await options.journal.append({
                event_type: "SOURCES_FAILED",
                run_id: request.runId,
                mode: request.mode,
                phase: "failure",
                status: "failed",
                timestamp: now(clock),
                cluster_id: candidate.clusterId,
                attempt_id: claimPlan.attemptId,
                source_memory_ids: claimPlan.sources.map(source => source.memoryId),
                details: { errorCode: "HIPPOCAMPUS_CLUSTER_FAILED", claimId: claimPlan.claimId, retryable: true }
              });
            } catch {
              failureCode = "NEEDS_RECONCILIATION";
              failurePhase = "journal";
            }
          }
          failures.push({ clusterId: candidate.clusterId, reasonCode: DAEMON_REASON_CODES.CLUSTER_FAILED, code: error.code === "NEEDS_RECONCILIATION" ? "NEEDS_RECONCILIATION" : failureCode, phase: error.code === "NEEDS_RECONCILIATION" ? "journal" : failurePhase });
          await emit("cluster_failed", request.runId, failures.at(-1), eventFailures);
          if (!request.continueOnClusterFailure) break;
        }
      }
    }
    const completedAt = now(clock);
    let reportStatus = failures.length ? "failed" : "completed";
    if (request.mode === "commit") {
      const reconciliationFailure = failures.find(failure => failure.code === "NEEDS_RECONCILIATION");
      if (reconciliationFailure) reportStatus = "needs_reconciliation";
      else {
        try {
          const runState = await options.journal.getRunState(request.runId);
          if (!runState || runState.blocked || runState.clusters.some(cluster => !cluster.terminal)) throw new HippocampusDaemonError("NEEDS_RECONCILIATION", "journal", "Run terminal precondition is not satisfied");
          await options.journal.append({ event_type: failures.length ? "RUN_FAILED" : "RUN_COMPLETED", run_id: request.runId, mode: request.mode, phase: request.phase, status: failures.length ? "failed" : "completed", timestamp: completedAt, details: { writesAttempted, failedClusterCount: failures.length } });
        } catch {
          reportStatus = "needs_reconciliation";
          if (failures.length) failures[failures.length - 1] = { ...failures[failures.length - 1], code: "NEEDS_RECONCILIATION", phase: "journal" };
          else failures.push({ clusterId: null, reasonCode: DAEMON_REASON_CODES.CLUSTER_FAILED, code: "NEEDS_RECONCILIATION", phase: "journal" });
        }
      }
    }
    const report = {
      schemaVersion: 1, runId: request.runId, mode: request.mode, phase: request.phase,
      dryRun: request.mode === "dry-run", startedAt, completedAt,
      status: reportStatus,
      scaleTelemetry,
      recoveryStatus: {
        statusHydrated: persistentStatus.statusHydrated,
        recoveryState: persistentStatus.recoveryState,
        recoveryRequired: persistentStatus.recoveryRequired,
        incompleteRunCount: persistentStatus.incompleteRunCount,
        reasonCode: persistentStatus.reasonCode
      },
      candidateStats: plan.stats,
      clusterStats: clusterResult?.stats || { clusterCount: 0 },
      maturityStats: { evaluated: maturityResults.length, mature: maturityResults.filter(item => item.mature).length, deferred: maturityResults.filter(item => !item.mature).length },
      synthesisStats: { succeeded: processedClusters.length, failed: failures.length },
      commitStats: { committed: processedClusters.filter(item => item.committed).length, idempotentReplay: processedClusters.filter(item => item.idempotentReplay).length },
      processedClusters, deferredClusters, failures, eventFailures, writesAttempted
    };
    await emit("run_completed", request.runId, { status: report.status, writesAttempted }, eventFailures);
    return freeze(report);
  }

  async function runOnce(input = {}) {
    const request = validateRequest(input);
    if (active) {
      const skipped = freeze({ schemaVersion: 1, runId: request.runId, mode: request.mode, phase: request.phase, dryRun: request.mode === "dry-run", status: "skipped", reasonCodes: [DAEMON_REASON_CODES.RUN_ALREADY_ACTIVE], writesAttempted: 0 });
      const ignored = []; await emit("run_skipped", request.runId, { reasonCodes: skipped.reasonCodes }, ignored); return skipped;
    }
    active = true;
    let completed = false;
    try { lastRun = await execute(request); completed = true; return lastRun; }
    finally {
      active = false;
      if (completed && request.mode === "commit" && options.recoveryManager) await refreshStatus();
    }
  }

  function start(input = {}) {
    if (input?.mode === "commit") throw new HippocampusDaemonError("SCHEDULED_COMMIT_FORBIDDEN", "scheduler", "Scheduler accepts dry-run only");
    const request = validateRequest(input);
    if (request.mode !== "dry-run") throw new HippocampusDaemonError("SCHEDULED_COMMIT_FORBIDDEN", "scheduler", "Scheduler accepts dry-run only");
    if (timer) return false;
    timer = setInterval(() => { runOnce(request).catch(() => {}); }, intervalMs);
    return true;
  }
  function stop() { if (!timer) return false; clearInterval(timer); timer = null; return true; }
  function getStatus() { return freeze({ running: active, scheduled: timer !== null, userBound: true, lastRunId: lastRun?.runId || null, journalConfigured: Boolean(options.journal), ...recoveryStatus }); }
  async function runBoundedSynthetic(input) {
    if (!options.boundedPipelineAdapter) {
      throw new HippocampusDaemonError(
        "BOUNDED_PIPELINE_DISABLED", "configuration",
        "Bounded pipeline requires explicit adapter injection"
      );
    }
    return options.boundedPipelineAdapter.run(input);
  }
  return Object.freeze({
    runOnce, start, stop, getStatus, refreshStatus, runBoundedSynthetic
  });
}

module.exports = { HIPPOCAMPUS_DAEMON_SCHEMA_VERSION, HIPPOCAMPUS_MODES, HIPPOCAMPUS_PHASES, HIPPOCAMPUS_RECOVERY_STATES, DAEMON_REASON_CODES, HippocampusDaemonError, createHippocampusDaemon };
