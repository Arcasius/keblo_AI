"use strict";

const LIVE_PILOT_CONFIRMATION = "RUN_HIPPOCAMPUS_LIVE_PILOT_V1";
const LIVE_PILOT_USER_ID = "francesco";
const LIVE_PILOT_SCHEMA_VERSION = 1;
const COMMIT_CONFIRMATION = "COMMIT_HIPPOCAMPUS_BOUNDED_V1";
const COMMIT_CAPABILITY_ID = "hippocampus-authoritative-commit-v1";
const { sanitizeHact9Failure } = require("./Hact9FailureDiagnostic");

class HippocampusControlledLivePilotError extends Error {
  constructor(code) {
    super("Hippocampus controlled LIVE pilot failed");
    this.name = "HippocampusControlledLivePilotError";
    this.code = code;
    this.phase = "controlled_live_pilot";
    this.retryable = false;
  }
}

function plain(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function freeze(value) {
  Object.freeze(value);
  for (const child of Object.values(value)) {
    if (child && typeof child === "object" && !Object.isFrozen(child)) freeze(child);
  }
  return value;
}

function validSignal(signal) {
  return signal && typeof signal.aborted === "boolean" &&
    typeof signal.addEventListener === "function";
}

function validCapability(capability) {
  return plain(capability) && capability.schemaVersion === 1 &&
    capability.capabilityId === COMMIT_CAPABILITY_ID &&
    typeof capability.commit === "function";
}

function validateRequest(request) {
  const keys = ["confirmation", "maxCandidates", "maxCommits", "mode", "pilot", "runOnce", "signal", "userId"];
  if (!plain(request) || Object.keys(request).sort().join(",") !== keys.sort().join(",") ||
      request.mode !== "LIVE" || request.pilot !== true || request.runOnce !== true ||
      request.confirmation !== LIVE_PILOT_CONFIRMATION ||
      request.userId !== LIVE_PILOT_USER_ID || request.maxCommits !== 1 ||
      !Number.isSafeInteger(request.maxCandidates) || request.maxCandidates < 1 ||
      request.maxCandidates > 100 || !validSignal(request.signal)) {
    throw new HippocampusControlledLivePilotError(
      request?.maxCommits !== 1 ? "MAX_COMMITS_MUST_EQUAL_ONE" :
        request?.confirmation !== LIVE_PILOT_CONFIRMATION ? "LIVE_PILOT_CONFIRMATION_REQUIRED" :
          "INVALID_LIVE_PILOT_REQUEST"
    );
  }
  if (request.signal.aborted) throw new HippocampusControlledLivePilotError("RUN_ABORTED");
}

function validateDependencies(options) {
  if (!plain(options) || !options.exclusiveRun || !options.preflight ||
      !options.boundedRuntime || !options.backup || !options.bridge ||
      !options.postCommitVerifier || !options.recovery ||
      typeof options.exclusiveRun.acquire !== "function" ||
      typeof options.exclusiveRun.release !== "function" ||
      typeof options.preflight.run !== "function" ||
      typeof options.boundedRuntime.runFirstFinalizable !== "function" ||
      typeof options.backup.createVerified !== "function" ||
      typeof options.backup.verifyUnchangedOrRollback !== "function" ||
      typeof options.bridge.prepare !== "function" ||
      typeof options.bridge.commit !== "function" ||
      typeof options.postCommitVerifier.verify !== "function" ||
      typeof options.recovery.verify !== "function") {
    throw new HippocampusControlledLivePilotError("INVALID_LIVE_PILOT_COMPOSITION");
  }
}

function receipt(state) {
  return freeze({
    schemaVersion: LIVE_PILOT_SCHEMA_VERSION,
    status: state.status,
    reasonCode: state.reasonCode,
    preflight: state.preflight,
    clusterSelectedCount: state.clusterSelectedCount,
    sourceCount: state.sourceCount,
    superMemoryCreatedCount: state.superMemoryCreatedCount,
    authoritativeMemoryReads: state.authoritativeMemoryReads,
    authoritativeMemoryWrites: state.authoritativeMemoryWrites,
    processingStateWrites: state.processingStateWrites,
    commitCalls: state.commitCalls,
    backupFileCount: state.backupFileCount,
    rollbackPerformed: state.rollbackPerformed,
    recoveryVerified: state.recoveryVerified,
    recallSuperMemoryVerified: state.recallSuperMemoryVerified,
    recallRawVerified: state.recallRawVerified,
    realDataModified: state.realDataModified,
    failurePhase: state.failurePhase,
    failureProvider: state.failureProvider,
    failureOperation: state.failureOperation,
    lastCompletedPhase: state.lastCompletedPhase,
    elapsedMsAtFailure: state.elapsedMsAtFailure,
    candidateCountVerified: state.candidateCountVerified,
    cacheLookupCount: state.cacheLookupCount,
    cacheHitCount: state.cacheHitCount,
    cacheMissCount: state.cacheMissCount,
    neighborQueryCount: state.neighborQueryCount,
    exactCertificateCount: state.exactCertificateCount,
    clusterCount: state.clusterCount
  });
}

function initialState() {
  return {
    status: "BLOCKED", reasonCode: "RUN_NOT_STARTED", preflight: "NOT_RUN",
    clusterSelectedCount: 0, sourceCount: 0, superMemoryCreatedCount: 0,
    authoritativeMemoryReads: 0, authoritativeMemoryWrites: 0,
    processingStateWrites: 0, commitCalls: 0, backupFileCount: 0,
    rollbackPerformed: false, recoveryVerified: false,
    recallSuperMemoryVerified: false, recallRawVerified: false,
    realDataModified: false,
    failurePhase: null, failureProvider: null, failureOperation: null,
    lastCompletedPhase: "NONE", elapsedMsAtFailure: 0,
    candidateCountVerified: 0, cacheLookupCount: 0, cacheHitCount: 0,
    cacheMissCount: 0, neighborQueryCount: 0, exactCertificateCount: 0,
    clusterCount: 0
  };
}

function applyBoundedMetrics(state, bounded) {
  for (const key of [
    "candidateCountVerified", "cacheLookupCount", "cacheHitCount",
    "cacheMissCount", "neighborQueryCount", "exactCertificateCount",
    "clusterCount"
  ]) {
    if (Number.isSafeInteger(bounded?.[key]) && bounded[key] >= 0) {
      state[key] = bounded[key];
    }
  }
}

function pending(state, phase, provider, operation) {
  state.failurePhase = phase;
  state.failureProvider = provider;
  state.failureOperation = operation;
}

function clearFailure(state) {
  state.failurePhase = null;
  state.failureProvider = null;
  state.failureOperation = null;
  state.elapsedMsAtFailure = 0;
}

function reason(error, fallback) {
  return typeof error?.code === "string" && /^[A-Z][A-Z0-9_]*$/.test(error.code)
    ? error.code : fallback;
}

function createHippocampusControlledLivePilot(options) {
  validateDependencies(options);

  async function run(request) {
    const state = initialState();
    const startedAt = Date.now();
    let lockHandle = null;
    let backupManifest = null;
    try {
      validateRequest(request);
      lockHandle = await options.exclusiveRun.acquire({ userId: request.userId, signal: request.signal });
      if (!lockHandle) throw new HippocampusControlledLivePilotError("CONCURRENT_RUN_DETECTED");
      pending(state, "PREFLIGHT", "INTERNAL", "RUN_PREFLIGHT");
      const preflight = await options.preflight.run({
        userId: request.userId,
        maxCandidates: request.maxCandidates,
        commitCapabilityPresent: validCapability(options.commitCapability),
        signal: request.signal
      });
      state.preflight = preflight?.passed === true ? "PASS" : "FAIL";
      state.authoritativeMemoryReads += preflight?.authoritativeMemoryReads || 0;
      if (preflight?.passed !== true || preflight.storageAttestationValid !== true) {
        throw new HippocampusControlledLivePilotError(preflight?.reasonCode || "PREFLIGHT_FAILED");
      }
      state.lastCompletedPhase = "PREFLIGHT";
      if (!validCapability(options.commitCapability)) {
        throw new HippocampusControlledLivePilotError("COMMIT_CAPABILITY_REQUIRED");
      }
      pending(state, "ARTIFACT_DELIVERY", "INTERNAL", "FINALIZE_ARTIFACT");
      const bounded = await options.boundedRuntime.runFirstFinalizable({
        userId: request.userId, maxCandidates: request.maxCandidates, signal: request.signal
      });
      applyBoundedMetrics(state, bounded);
      state.lastCompletedPhase = "ARTIFACT_DELIVERY";
      state.authoritativeMemoryReads += bounded?.authoritativeMemoryReads || 0;
      if (bounded?.status === "NO_FINALIZABLE_CLUSTER") {
        state.status = "NO_COMMIT";
        state.reasonCode = "NO_FINALIZABLE_CLUSTER";
        clearFailure(state);
        return receipt(state);
      }
      if (bounded?.status !== "FINALIZABLE" || !plain(bounded.commitInput) ||
          !Array.isArray(bounded.transactionFiles) || bounded.transactionFiles.length === 0) {
        throw new HippocampusControlledLivePilotError("INVALID_BOUNDED_PILOT_ARTIFACT");
      }
      state.clusterSelectedCount = 1;
      state.sourceCount = bounded.sourceCount;
      pending(state, "BACKUP", "INTERNAL", "CREATE_BACKUP");
      backupManifest = await options.backup.createVerified({
        files: bounded.transactionFiles, signal: request.signal
      });
      if (backupManifest?.verified !== true) {
        throw new HippocampusControlledLivePilotError("BACKUP_VERIFICATION_FAILED");
      }
      state.backupFileCount = backupManifest.fileCount;
      state.lastCompletedPhase = "BACKUP";
      pending(state, "COMMIT_PREPARE", "INTERNAL", "PREPARE_COMMIT");
      const prepared = options.bridge.prepare(bounded.commitInput);
      if (prepared?.receipt?.status !== "PREPARED" || !prepared.preparedCommit) {
        throw new HippocampusControlledLivePilotError(prepared?.receipt?.reasonCode || "INVALID_PREPARED_COMMIT");
      }
      state.lastCompletedPhase = "COMMIT_PREPARE";
      pending(state, "COMMIT", "AUTHORITATIVE_STORAGE", "COMMIT_TRANSACTION");
      const committed = await options.bridge.commit({
        preparedCommit: prepared.preparedCommit,
        confirmation: COMMIT_CONFIRMATION,
        signal: request.signal
      });
      state.lastCompletedPhase = "COMMIT";
      state.authoritativeMemoryReads += committed?.receipt?.authoritativeReadCount || 0;
      state.commitCalls = committed?.receipt?.commitCalls || 0;
      if (committed?.receipt?.status === "IDEMPOTENT_REPLAY") {
        state.status = "IDEMPOTENT_REPLAY";
        state.reasonCode = "IDEMPOTENT_COMMIT_REPLAY";
        state.recoveryVerified = true;
        clearFailure(state);
        return receipt(state);
      }
      if (committed?.receipt?.status !== "COMMITTED" || state.commitCalls !== 1 ||
          committed.receipt.authoritativeWriteCount !== 1) {
        throw new HippocampusControlledLivePilotError(committed?.receipt?.reasonCode || "TRANSACTION_COMMIT_FAILED");
      }
      state.authoritativeMemoryWrites = 1;
      state.processingStateWrites = state.sourceCount;
      pending(state, "RECALL_VERIFICATION", "INTERNAL", "VERIFY_RECALL");
      const verified = await options.postCommitVerifier.verify({
        bounded, preparedCommit: prepared.preparedCommit,
        backupManifest, signal: request.signal
      });
      if (!plain(verified) || verified.valid !== true ||
          verified.superMemoryCreatedCount !== 1 ||
          verified.recallSuperMemoryVerified !== true || verified.recallRawVerified !== true) {
        throw new HippocampusControlledLivePilotError("POST_COMMIT_VERIFICATION_FAILED");
      }
      state.status = "PASSED";
      state.reasonCode = "CONTROLLED_LIVE_PILOT_PASSED";
      state.superMemoryCreatedCount = 1;
      state.recoveryVerified = true;
      state.recallSuperMemoryVerified = true;
      state.recallRawVerified = true;
      state.realDataModified = true;
      state.lastCompletedPhase = "RECALL_VERIFICATION";
      clearFailure(state);
      return receipt(state);
    } catch (error) {
      state.status = "BLOCKED";
      state.reasonCode = reason(error, "CONTROLLED_LIVE_PILOT_FAILED");
      Object.assign(state, sanitizeHact9Failure(error?.hact9Failure, {
        ...state,
        failurePhase: state.failurePhase || "ARTIFACT_DELIVERY",
        failureProvider: state.failureProvider || "INTERNAL",
        failureOperation: state.failureOperation || "FINALIZE_ARTIFACT",
        lastCompletedPhase: state.lastCompletedPhase,
        elapsedMsAtFailure: Date.now() - startedAt
      }));
      if (backupManifest && (state.commitCalls > 0 || state.authoritativeMemoryWrites > 0)) {
        const recovery = await options.recovery.verify({ signal: request?.signal });
        state.recoveryVerified = recovery?.verified === true;
        const restored = await options.backup.verifyUnchangedOrRollback({
          manifest: backupManifest, allowRollback: true, signal: request?.signal
        });
        state.rollbackPerformed = restored?.rollbackPerformed === true;
        state.realDataModified = restored?.matchesBackup !== true;
        if (!state.recoveryVerified || restored?.matchesBackup !== true) {
          state.reasonCode = "RECOVERY_OR_ROLLBACK_VERIFICATION_FAILED";
        } else {
          state.authoritativeMemoryWrites = 0;
          state.processingStateWrites = 0;
        }
      }
      return receipt(state);
    } finally {
      if (lockHandle) await options.exclusiveRun.release(lockHandle);
    }
  }

  return freeze({ run });
}

module.exports = {
  LIVE_PILOT_CONFIRMATION,
  LIVE_PILOT_USER_ID,
  LIVE_PILOT_SCHEMA_VERSION,
  HippocampusControlledLivePilotError,
  createHippocampusControlledLivePilot
};
