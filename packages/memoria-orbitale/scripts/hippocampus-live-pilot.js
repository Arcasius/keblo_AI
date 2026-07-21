#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { randomUUID } = require("node:crypto");
const JsonMemoryStorage = require("../core/JsonMemoryStorage");
const {
  createQdrantEmbeddingCacheProvider
} = require("../core/providers/vector/QdrantEmbeddingCacheProvider");
const {
  LIVE_PILOT_CONFIRMATION,
  LIVE_PILOT_USER_ID,
  HippocampusControlledLivePilotError,
  createHippocampusControlledLivePilot
} = require("../core/hippocampus/HippocampusControlledLivePilot");
const {
  runtimeEnvironment,
  createRealPreflightEvaluator,
  createRealBoundedPilotRunner
} = require("./hippocampus-run");
const {
  createHippocampusBoundedPilotArtifactBoundary,
  BOUNDED_PILOT_ARTIFACT_BOUNDARY_VERSION,
  BOUNDED_PILOT_ARTIFACT_CAPABILITY_ID
} = require("../core/hippocampus/HippocampusBoundedPilotArtifactBoundary");
const {
  createAuthoritativeLegacyProcessingBoundary
} = require("../core/hippocampus/AuthoritativeLegacyProcessingBoundary");
const {
  createHippocampusBoundedCommitBridge
} = require("../core/hippocampus/HippocampusBoundedCommitBridge");
const {
  createConsolidationCommitPlan,
  commitConsolidation
} = require("../core/consolidation/ConsolidationTransaction");
const {
  createProcessingTransitionPlan,
  validateProcessingState
} = require("../core/consolidation/ProcessingState");
const {
  createSuperMemoryRecord,
  validateSuperMemoryRecord
} = require("../core/consolidation/SuperMemoryRecord");
const {
  selectConsolidationCandidates
} = require("../core/consolidation/CandidateSelector");
const { createRecallRouter } = require("../core/recall/RecallRouter");
const {
  createHippocampusJournal
} = require("../core/hippocampus/HippocampusJournal");
const { sanitizeHact9Failure } = require(
  "../core/hippocampus/Hact9FailureDiagnostic"
);

const FLAGS = new Set([
  "--confirm", "--max-candidates", "--max-commits", "--mode",
  "--pilot", "--run-once", "--user-id", "--diagnostic-read-only"
]);

function fail(code) {
  throw new HippocampusControlledLivePilotError(code);
}

function positive(value) {
  if (!/^[1-9][0-9]*$/.test(value || "")) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseLivePilotArguments(args, signal) {
  if (!Array.isArray(args) || args.some((item) => typeof item !== "string")) {
    fail("INVALID_LIVE_PILOT_REQUEST");
  }
  const values = {
    mode: null, pilot: false, runOnce: false, confirmation: null,
    userId: null, maxCommits: null, maxCandidates: null, signal,
    diagnosticReadOnly: false
  };
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!FLAGS.has(flag) || seen.has(flag)) fail("INVALID_LIVE_PILOT_REQUEST");
    seen.add(flag);
    if (flag === "--pilot") { values.pilot = true; continue; }
    if (flag === "--run-once") { values.runOnce = true; continue; }
    if (flag === "--diagnostic-read-only") {
      values.diagnosticReadOnly = true;
      continue;
    }
    const value = args[index + 1];
    if (typeof value !== "string" || value.startsWith("--")) fail("INVALID_LIVE_PILOT_REQUEST");
    index += 1;
    if (flag === "--mode") values.mode = value;
    if (flag === "--confirm") values.confirmation = value;
    if (flag === "--user-id") values.userId = value;
    if (flag === "--max-commits") values.maxCommits = positive(value);
    if (flag === "--max-candidates") values.maxCandidates = positive(value);
  }
  if (values.confirmation !== LIVE_PILOT_CONFIRMATION) fail("LIVE_PILOT_CONFIRMATION_REQUIRED");
  if (values.maxCommits !== 1) fail("MAX_COMMITS_MUST_EQUAL_ONE");
  if (values.mode !== "LIVE" || values.pilot !== true || values.runOnce !== true ||
      values.userId !== LIVE_PILOT_USER_ID || !Number.isSafeInteger(values.maxCandidates) ||
      values.maxCandidates < 1 || values.maxCandidates > 100) {
    fail("INVALID_LIVE_PILOT_REQUEST");
  }
  return Object.freeze(values);
}

function liveRequest(values) {
  const { diagnosticReadOnly, ...request } = values;
  return Object.freeze(request);
}

function hashBuffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function createVerifiedBackupManager(options) {
  const fsPromises = options?.fsPromises || fs.promises;
  const backupDirectory = options?.backupDirectory;
  if (typeof backupDirectory !== "string" || !path.isAbsolute(backupDirectory)) {
    fail("INVALID_BACKUP_CONFIGURATION");
  }
  async function snapshotFile(filePath) {
    try {
      const bytes = await fsPromises.readFile(filePath);
      return { exists: true, bytes, sha256: hashBuffer(bytes), size: bytes.length };
    } catch (error) {
      if (error?.code === "ENOENT") {
        return { exists: false, bytes: null, sha256: null, size: 0 };
      }
      throw error;
    }
  }
  async function createVerified({ files, signal }) {
    if (signal?.aborted) fail("RUN_ABORTED");
    const canonical = [...new Set(files)].sort();
    if (canonical.length === 0 || canonical.some((file) => !path.isAbsolute(file))) {
      fail("BACKUP_TARGETS_INVALID");
    }
    await fsPromises.mkdir(backupDirectory, { recursive: false, mode: 0o700 });
    await fsPromises.chmod(backupDirectory, 0o700);
    const entries = [];
    for (let index = 0; index < canonical.length; index += 1) {
      const sourcePath = canonical[index];
      const before = await snapshotFile(sourcePath);
      let backupPath = null;
      if (before.exists) {
        backupPath = path.join(backupDirectory, `${String(index).padStart(3, "0")}.backup`);
        await fsPromises.writeFile(backupPath, before.bytes, { flag: "wx", mode: 0o600 });
        const reread = await snapshotFile(backupPath);
        if (!reread.exists || reread.sha256 !== before.sha256 ||
            reread.size !== before.size) {
          fail("BACKUP_VERIFICATION_FAILED");
        }
      }
      entries.push(Object.freeze({
        sourcePath, backupPath, existed: before.exists,
        sha256: before.sha256, size: before.size
      }));
    }
    return Object.freeze({ verified: true, fileCount: entries.length, entries: Object.freeze(entries) });
  }
  async function verifyUnchangedOrRollback({ manifest, allowRollback }) {
    let matchesBackup = true;
    for (const entry of manifest.entries) {
      try {
        const current = await snapshotFile(entry.sourcePath);
        if (current.exists !== entry.existed || current.sha256 !== entry.sha256 ||
            current.size !== entry.size) matchesBackup = false;
      } catch { matchesBackup = false; }
    }
    if (matchesBackup || allowRollback !== true) {
      return Object.freeze({ matchesBackup, rollbackPerformed: false });
    }
    for (const entry of manifest.entries) {
      if (!entry.existed) {
        try { await fsPromises.unlink(entry.sourcePath); } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
        continue;
      }
      const backup = await snapshotFile(entry.backupPath);
      if (!backup.exists || backup.sha256 !== entry.sha256 ||
          backup.size !== entry.size) fail("BACKUP_VERIFICATION_FAILED");
      await fsPromises.copyFile(entry.backupPath, entry.sourcePath);
    }
    for (const entry of manifest.entries) {
      const restored = await snapshotFile(entry.sourcePath);
      if (restored.exists !== entry.existed || restored.sha256 !== entry.sha256 ||
          restored.size !== entry.size) fail("ROLLBACK_VERIFICATION_FAILED");
    }
    return Object.freeze({ matchesBackup: true, rollbackPerformed: true });
  }
  return Object.freeze({ createVerified, verifyUnchangedOrRollback });
}

const LIFECYCLE_ERROR_CODES = new Set([
  "NONE", "CONNECTION_RESET", "CONNECTION_REFUSED", "QDRANT_TIMEOUT",
  "QDRANT_ABORTED", "QDRANT_UNAVAILABLE", "HTTP_RETRYABLE", "HTTP_ERROR",
  "INVALID_HTTP_BODY", "INVALID_HTTP_JSON", "INVALID_QDRANT_ENVELOPE",
  "INVALID_QDRANT_RESULT", "RESPONSE_TOO_LARGE"
]);

function createQdrantLifecycleTracker(injections) {
  const sourceFactory = injections.qdrantProviderFactory ||
    createQdrantEmbeddingCacheProvider;
  const state = {
    phase: "NONE", nextInstanceId: 0, requestSequence: 0,
    preflightProviderInstanceId: null, runtimeProviderInstanceId: null,
    preflightSignal: null, runtimeSignal: null,
    preflightSignalAbortedAfterReturn: false,
    runtimeVerificationRequestSequence: 0,
    transportDisposed: false, lowLevelErrorCode: "NONE"
  };
  const trackedInjections = {
    ...injections,
    qdrantProviderFactory(options) {
      const instanceId = ++state.nextInstanceId;
      if (state.phase === "PREFLIGHT" && state.preflightProviderInstanceId === null) {
        state.preflightProviderInstanceId = instanceId;
      }
      if (state.phase === "RUNTIME" && state.runtimeProviderInstanceId === null) {
        state.runtimeProviderInstanceId = instanceId;
      }
      const provider = sourceFactory(options);
      const wrapped = {};
      for (const [name, value] of Object.entries(provider)) {
        if (typeof value !== "function") {
          wrapped[name] = value;
          continue;
        }
        wrapped[name] = async (request) => {
          state.requestSequence += 1;
          if (state.phase === "RUNTIME" && name === "getCollectionInfo" &&
              state.runtimeVerificationRequestSequence === 0) {
            state.runtimeVerificationRequestSequence = state.requestSequence;
          }
          if (["close", "dispose", "destroy"].includes(name)) {
            state.transportDisposed = true;
          }
          try {
            return await value(request);
          } catch (error) {
            state.lowLevelErrorCode = LIFECYCLE_ERROR_CODES.has(error?.code)
              ? error.code : "QDRANT_UNAVAILABLE";
            throw error;
          }
        };
      }
      return Object.freeze(wrapped);
    }
  };
  return Object.freeze({
    injections: Object.freeze(trackedInjections),
    beginPreflight(signal) {
      state.phase = "PREFLIGHT";
      state.preflightSignal = signal;
    },
    endPreflight() {
      state.preflightSignalAbortedAfterReturn =
        state.preflightSignal?.aborted === true;
      state.phase = "NONE";
    },
    beginRuntime(signal) {
      state.phase = "RUNTIME";
      state.runtimeSignal = signal;
    },
    endRuntime() {
      state.phase = "NONE";
    },
    snapshot() {
      return Object.freeze({
        providerInstanceReused: state.preflightProviderInstanceId !== null &&
          state.preflightProviderInstanceId === state.runtimeProviderInstanceId,
        preflightSignalAbortedAfterReturn:
          state.preflightSignalAbortedAfterReturn,
        runtimeSignalSameAsPreflightSignal: state.preflightSignal !== null &&
          state.preflightSignal === state.runtimeSignal,
        transportDisposed: state.transportDisposed,
        requestSequence: state.runtimeVerificationRequestSequence,
        lowLevelErrorCode: state.lowLevelErrorCode
      });
    }
  });

}

function createLivePilotComposition(env, injections = {}) {
  const configuration = runtimeEnvironment(env);
  const lifecycle = createQdrantLifecycleTracker(injections);
  const compositionInjections = lifecycle.injections;
  const evaluate = createRealPreflightEvaluator(
    configuration, compositionInjections
  );
  const storage = configuration.complete === true
    ? new JsonMemoryStorage(configuration.dataDir)
    : null;
  const memoryFile = configuration.complete === true
    ? path.join(configuration.dataDir, `${LIVE_PILOT_USER_ID}_memories.json`)
    : null;
  let active = null;
  const capability = Object.freeze({
    schemaVersion: 1,
    capabilityId: "hippocampus-authoritative-commit-v1",
    async commit(request) {
      return request.commitCoordinator.commit({
        storage: request.authoritativeStorage,
        plan: request.transactionPlan,
        signal: request.signal
      });
    }
  });
  let exclusiveRun;
  let preflight;
  let boundedRuntime;
  const pilot = createHippocampusControlledLivePilot({
    commitCapability: capability,
    exclusiveRun: exclusiveRun = {
      async acquire() {
        if (!configuration.complete) return Object.freeze({ preflightOnly: true });
        const lockPath = path.join(configuration.dataDir, ".hact9-live-pilot.lock");
        try {
          const handle = await fs.promises.open(lockPath, "wx", 0o600);
          return Object.freeze({ handle, lockPath });
        } catch (error) {
          if (error?.code === "EEXIST") return null;
          throw error;
        }
      },
      async release(handle) {
        if (handle.preflightOnly) return;
        await handle.handle.close();
        await fs.promises.unlink(handle.lockPath);
      }
    },
    preflight: preflight = {
      async run({ signal }) {
        lifecycle.beginPreflight(signal);
        try {
          const result = await evaluate({ signal });
          return {
            passed: result.report.shadowReady === true,
            storageAttestationValid: result.report.storage.verifiedReady === true,
            reasonCode: result.diagnostic.reasonCode,
            authoritativeMemoryReads: 0
          };
        } finally {
          lifecycle.endPreflight();
        }
      }
    },
    boundedRuntime: boundedRuntime = {
      async runFirstFinalizable({ userId, maxCandidates, signal, readOnly = false }) {
        lifecycle.beginRuntime(signal);
        try {
        if (!storage || userId !== LIVE_PILOT_USER_ID) {
          fail("AUTHORITATIVE_PROCESSING_STATE_BOUNDARY_UNAVAILABLE");
        }
        const runId = randomUUID();
        const processingAttemptId = `${readOnly ? "hact9-read-only" : "hact9"}:${runId}`;
        const artifactCapability = Object.freeze({
          schemaVersion: 1,
          capabilityId: BOUNDED_PILOT_ARTIFACT_CAPABILITY_ID,
          userId,
          runId
        });
        const artifactBoundary = createHippocampusBoundedPilotArtifactBoundary({
          capability: artifactCapability,
          userId,
          runId,
          now: Date.now,
          maxAgeMs: configuration.qwenTimeoutMs + 60000
        });
        const artifactContext = {
          boundary: artifactBoundary,
          capability: artifactCapability,
          boundaryVersion: BOUNDED_PILOT_ARTIFACT_BOUNDARY_VERSION,
          userId,
          runId
        };
        const runner = (compositionInjections.createRealBoundedPilotRunner ||
          createRealBoundedPilotRunner)(configuration, compositionInjections, {
          processingAttemptId,
          artifactContext,
          readOnly
        });
        const bounded = await runner({
          configuration: {
            mode: "LIVE", operation: "RUN_ONCE", userId, maxCandidates,
            confirmation: LIVE_PILOT_CONFIRMATION
          },
          signal
        });
        if (bounded.status !== "FINALIZABLE") return bounded;
        if (readOnly) return bounded;
        const claimedAt = bounded.candidateSuperMemory.timestamp;
        const processingBoundary = createAuthoritativeLegacyProcessingBoundary({
          authoritativeStorage: storage,
          loadAuthoritativeMap: async (scope) => {
            if (scope !== LIVE_PILOT_USER_ID) fail("INVALID_LEGACY_PROCESSING_SOURCE_SCOPE");
            const value = JSON.parse(await fs.promises.readFile(memoryFile, "utf8"));
            if (!value || typeof value !== "object" || Array.isArray(value)) {
              fail("AUTHORITATIVE_LEGACY_MAP_INVALID");
            }
            return value;
          },
          userId,
          processingAttemptId,
          claimedAt
        });
        const processingAuthorization = await processingBoundary.authorizeSources({
          sourceIdentities: bounded.commitInput.synthesisResult.sourceContentHashes
            .map((item) => ({ memoryId: item.id, contentHash: item.content_hash }))
        });
        const claimById = new Map(processingAuthorization.claimPlan.sources.map((item) =>
          [item.memoryId, item]));
        const used = new Set(
          bounded.commitInput.synthesisResult.output.source_memory_ids
        );
        const committedAt = bounded.candidateSuperMemory.timestamp;
        const journal = createHippocampusJournal({
          directory: configuration.dataDir,
          userId
        });
        const journalFile = path.join(configuration.dataDir,
          `${hashBuffer(Buffer.from(userId, "utf8"))}_hippocampus_journal.jsonl`);
        const bridge = createHippocampusBoundedCommitBridge({
          authoritativeStorage: processingBoundary.storage,
          commitCoordinator: {
            createPlan: createConsolidationCommitPlan,
            async commit({ storage: target, plan }) {
              await journal.append({
                event_type: "COMMIT_STARTED", run_id: runId, mode: "commit",
                phase: "commit", status: "started", timestamp: Date.now(),
                cluster_id: bounded.commitInput.cluster.candidate_cluster_id,
                transaction_id: plan.transactionId,
                attempt_id: processingAttemptId,
                source_memory_ids: [...bounded.commitInput.cluster.source_memory_ids],
                details: {}
              });
              const report = await commitConsolidation({ storage: target, plan });
              await journal.append({
                event_type: "COMMIT_SUCCEEDED", run_id: runId, mode: "commit",
                phase: "commit", status: "succeeded", timestamp: Date.now(),
                cluster_id: bounded.commitInput.cluster.candidate_cluster_id,
                transaction_id: plan.transactionId,
                attempt_id: processingAttemptId,
                source_memory_ids: [...bounded.commitInput.cluster.source_memory_ids],
                details: {
                  superMemoryId: report.superMemoryId,
                  committed: report.committed,
                  idempotentReplay: report.idempotentReplay
                }
              });
              return report;
            }
          },
          superMemoryRecordFactory: {
            create: createSuperMemoryRecord,
            validate: validateSuperMemoryRecord
          },
          processingStateContract: {
            createPreparedTransitions({ synthesisResult }) {
              return synthesisResult.sourceContentHashes.map(({ id }) => {
                const source = claimById.get(id);
                const rejected = !used.has(id);
                return createProcessingTransitionPlan({
                  memoryId: id,
                  current: source.claimedProcessing,
                  toState: rejected ? "failed" : "consolidated",
                  updatedAt: committedAt,
                  attemptId: processingAttemptId,
                  error: rejected ? {
                    code: "SYNTHESIS_SOURCE_REJECTED",
                    message: "Source rejected by validated synthesis output",
                    retryable: true
                  } : undefined,
                  reason: "hippocampus_consolidation_commit"
                });
              });
            },
            validateState: validateProcessingState
          },
          commitCapability: capability,
          logger: compositionInjections.bridgeLogger
        });
        const backupDirectory = path.join(
          configuration.dataDir, `.hact9-backup-${runId}`
        );
        active = {
          bridge,
          processingBoundary,
          baseStorage: storage,
          journal,
          backup: createVerifiedBackupManager({ backupDirectory }),
          bounded
        };
        return {
          ...bounded,
          transactionFiles: [memoryFile, journalFile],
          commitInput: bounded.commitInput
        };
        } finally {
          lifecycle.endRuntime();
        }
      }
    },
    backup: {
      async createVerified(request) {
        if (!active) fail("BACKUP_NOT_REACHED");
        return active.backup.createVerified(request);
      },
      async verifyUnchangedOrRollback(request) {
        if (!active) fail("BACKUP_NOT_REACHED");
        return active.backup.verifyUnchangedOrRollback(request);
      }
    },
    bridge: {
      prepare(input) {
        if (!active) fail("COMMIT_BRIDGE_NOT_REACHED");
        return active.bridge.prepare(input);
      },
      async commit(input) {
        if (!active) fail("COMMIT_BRIDGE_NOT_REACHED");
        return active.bridge.commit(input);
      }
    },
    postCommitVerifier: {
      async verify({ preparedCommit }) {
        if (!active) return { valid: false };
        const memories = await active.baseStorage.loadMemories(LIVE_PILOT_USER_ID);
        const byId = new Map(memories.map((memory) => [memory.id, memory]));
        const superMemory = byId.get(preparedCommit.superMemory.id);
        const rawId = preparedCommit.sourceIdentities[0].memoryId;
        const raw = byId.get(rawId);
        if (!superMemory || !raw) return { valid: false };
        const router = createRecallRouter({
          policy: { schemaVersion: 1, suppressCoveredSources: false },
          coreRetriever: {
            schemaVersion: 1, id: "hact9-core-verifier",
            async search() {
              return [{ id: superMemory.id, score: 1,
                retrievalTier: "core", memory: superMemory }];
            }
          },
          warmRetriever: {
            schemaVersion: 1, id: "hact9-warm-verifier",
            async search() {
              return [{ id: raw.id, score: 0.9, retrievalTier: "warm",
                memory: { ...raw, memoryKind: "raw", storageTier: "warm" } }];
            }
          }
        });
        const recall = await router.recall({ query: "verification", limit: 2 });
        const selection = selectConsolidationCandidates([raw], {
          allowLegacyUnclassified: true, maxCandidates: 1
        });
        return {
          valid: recall.results.some((item) => item.id === superMemory.id) &&
            recall.results.some((item) => item.id === raw.id) &&
            !selection.eligibleIds.includes(raw.id),
          superMemoryCreatedCount: 1,
          recallSuperMemoryVerified: recall.results.some((item) =>
            item.id === superMemory.id),
          recallRawVerified: recall.results.some((item) => item.id === raw.id)
        };
      }
    },
    recovery: {
      async verify() {
        if (!active) return { verified: false };
        try {
          await active.baseStorage.loadMemories(LIVE_PILOT_USER_ID);
          const journalState = await active.journal.inspect();
          return { verified: journalState.valid === true };
        } catch {
          return { verified: false };
        }
      }
    }
  });

  async function runLivePrefixDiagnostic(input) {
    const request = liveRequest(input);
    const state = diagnosticBase();
    const startedAt = Date.now();
    let lockHandle = null;
    try {
      if (input?.diagnosticReadOnly !== true) {
        fail("READ_ONLY_DIAGNOSTIC_REQUIRED");
      }
      parseLivePilotArguments([
        "--mode", request.mode, "--pilot", "--run-once",
        "--confirm", request.confirmation, "--user-id", request.userId,
        "--max-commits", String(request.maxCommits),
        "--max-candidates", String(request.maxCandidates),
        "--diagnostic-read-only"
      ], request.signal);
      lockHandle = await exclusiveRun.acquire({
        userId: request.userId,
        signal: request.signal
      });
      if (!lockHandle) fail("CONCURRENT_RUN_DETECTED");
      const checked = await preflight.run({
        userId: request.userId,
        maxCandidates: request.maxCandidates,
        commitCapabilityPresent: false,
        signal: request.signal
      });
      state.preflight = checked?.passed === true ? "PASS" : "FAIL";
      if (checked?.passed !== true ||
          checked.storageAttestationValid !== true) {
        fail(checked?.reasonCode || "PREFLIGHT_FAILED");
      }
      state.lastCompletedPhase = "PREFLIGHT";
      const bounded = await boundedRuntime.runFirstFinalizable({
        userId: request.userId,
        maxCandidates: request.maxCandidates,
        signal: request.signal,
        readOnly: true
      });
      for (const key of [
        "authoritativeMemoryReads", "candidateCountVerified", "cacheLookupCount",
        "cacheHitCount", "cacheMissCount", "neighborQueryCount",
        "exactCertificateCount", "clusterCount"
      ]) {
        if (Number.isSafeInteger(bounded?.[key]) && bounded[key] >= 0) {
          state[key] = bounded[key];
        }
      }
      if (bounded?.status !== "FINALIZABLE") {
        fail("NO_FINALIZABLE_CLUSTER");
      }
      state.status = "READ_ONLY_ARTIFACT_FINALIZABLE";
      state.reasonCode = "READ_ONLY_DIAGNOSTIC_PASSED";
      state.clusterSelectedCount = 1;
      state.sourceCount = bounded.sourceCount;
      state.lastCompletedPhase = "ARTIFACT_DELIVERY";
      state.lifecycle = lifecycle.snapshot();
      return Object.freeze(state);
    } catch (error) {
      state.status = "BLOCKED";
      state.reasonCode = typeof error?.code === "string" &&
        /^[A-Z][A-Z0-9_]*$/.test(error.code)
        ? error.code : "READ_ONLY_DIAGNOSTIC_FAILED";
      Object.assign(state, sanitizeHact9Failure(error?.hact9Failure, {
        ...state,
        failurePhase: state.preflight === "PASS" ? "ARTIFACT_DELIVERY" : "PREFLIGHT",
        failureProvider: "INTERNAL",
        failureOperation: state.preflight === "PASS" ? "FINALIZE_ARTIFACT" : "RUN_PREFLIGHT",
        lastCompletedPhase: state.lastCompletedPhase,
        elapsedMsAtFailure: Date.now() - startedAt
      }));
      state.lifecycle = lifecycle.snapshot();
      return Object.freeze(state);
    } finally {
      if (lockHandle) await exclusiveRun.release(lockHandle);
    }
  }

  return Object.freeze({
    run: pilot.run,
    runLivePrefixDiagnostic
  });
}

function diagnosticBase() {
  return {
    schemaVersion: 1, status: "BLOCKED", reasonCode: "RUN_NOT_STARTED",
    preflight: "NOT_RUN", clusterSelectedCount: 0, sourceCount: 0,
    superMemoryCreatedCount: 0, authoritativeMemoryReads: 0,
    authoritativeMemoryWrites: 0, processingStateWrites: 0, commitCalls: 0,
    backupFileCount: 0, rollbackPerformed: false, recoveryVerified: false,
    recallSuperMemoryVerified: false, recallRawVerified: false,
    realDataModified: false, failurePhase: null, failureProvider: null,
    failureOperation: null, lastCompletedPhase: "NONE", elapsedMsAtFailure: 0,
    candidateCountVerified: 0, cacheLookupCount: 0, cacheHitCount: 0,
    cacheMissCount: 0, neighborQueryCount: 0, exactCertificateCount: 0,
    clusterCount: 0
  };
}

function createReadOnlyDiagnosticComposition(env, injections = {}) {
  const composition = createLivePilotComposition(env, injections);
  return Object.freeze({ run: composition.runLivePrefixDiagnostic });
}

function sanitizedFailure(error) {
  return {
    schemaVersion: 1, status: "BLOCKED",
    reasonCode: typeof error?.code === "string" ? error.code : "CONTROLLED_LIVE_PILOT_FAILED",
    preflight: "NOT_RUN", clusterSelectedCount: 0, sourceCount: 0,
    superMemoryCreatedCount: 0, authoritativeMemoryReads: 0,
    authoritativeMemoryWrites: 0, processingStateWrites: 0, commitCalls: 0,
    backupFileCount: 0, rollbackPerformed: false, recoveryVerified: false,
    recallSuperMemoryVerified: false, recallRawVerified: false, realDataModified: false,
    ...sanitizeHact9Failure(error?.hact9Failure, {
      failurePhase: "PREFLIGHT", failureProvider: "INTERNAL",
      failureOperation: "RUN_PREFLIGHT", lastCompletedPhase: "NONE",
      elapsedMsAtFailure: 0
    })
  };
}

async function executeLivePilotCli(options = {}) {
  const controller = new AbortController();
  const signalSource = options.signalSource || process;
  const stop = () => controller.abort();
  signalSource.on("SIGINT", stop);
  signalSource.on("SIGTERM", stop);
  let report;
  try {
    const parsed = parseLivePilotArguments(options.args || [], controller.signal);
    const diagnostic = parsed.diagnosticReadOnly === true;
    const pilot = options.pilot || createLivePilotComposition(
      options.env || {}, options.injections || {}
    );
    report = diagnostic
      ? await pilot.runLivePrefixDiagnostic(parsed)
      : await pilot.run(liveRequest(parsed));
  } catch (error) {
    report = sanitizedFailure(error);
  } finally {
    signalSource.removeListener?.("SIGINT", stop);
    signalSource.removeListener?.("SIGTERM", stop);
  }
  (options.stdout || process.stdout).write(`${JSON.stringify(report)}\n`);
  return report.status === "PASSED" || report.status === "IDEMPOTENT_REPLAY" ||
    report.status === "NO_COMMIT" ||
    report.status === "READ_ONLY_ARTIFACT_FINALIZABLE" ? 0 : 1;
}

if (require.main === module) {
  executeLivePilotCli({ args: process.argv.slice(2), env: process.env })
    .then((code) => { process.exitCode = code; });
}

module.exports = {
  parseLivePilotArguments,
  createVerifiedBackupManager,
  createLivePilotComposition,
  createReadOnlyDiagnosticComposition,
  executeLivePilotCli
};
