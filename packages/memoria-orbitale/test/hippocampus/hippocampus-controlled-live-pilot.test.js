"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createHash } = require("node:crypto");
const { fingerprintEmbedding } = require("../../core/clustering/ClusterMath");
const { createClusterRecord } = require("../../core/clustering/ClusterRecord");
const {
  buildSynthesisRequest,
  buildSynthesisResult
} = require("../../core/synthesis/SynthesisContract");
const { DEFAULT_SYNTHESIS_LIMITS } = require("../../core/synthesis/SynthesisEngine");
const { createSuperMemoryRecord } = require("../../core/consolidation/SuperMemoryRecord");
const {
  EXPECTED_BGE_MODEL,
  EXPECTED_BGE_REVISION,
  EXPECTED_BGE_DIMENSION,
  EXPECTED_QWEN_MODEL
} = require("../../core/hippocampus/HippocampusActivationPreflight");
const {
  LIVE_PILOT_CONFIRMATION,
  createHippocampusControlledLivePilot
} = require("../../core/hippocampus/HippocampusControlledLivePilot");
const {
  parseLivePilotArguments,
  createVerifiedBackupManager,
  createLivePilotComposition,
  createReadOnlyDiagnosticComposition
} = require("../../scripts/hippocampus-live-pilot");

const REAL_USER = "francesco";
const REAL_IDS = ["source-a", "source-b", "source-c"];
const REAL_TIME = 1800000000000;

function hash(text) {
  return createHash("sha256").update(text).digest("hex");
}

function pilotText(id) {
  return `Synthetic HACT-9 source ${id}`;
}

function realArtifact(processingAttemptId) {
  const artifactTime = Date.now();
  const centroid = [1, 0.5];
  const cluster = createClusterRecord({
    userId: REAL_USER,
    planId: "a".repeat(64),
    createdAt: REAL_TIME - 1000,
    embedding: { providerId: "fake-cache", model: "bge-m3", version: "bge-m3-v1" },
    clusterCandidate: {
      schemaVersion: 1,
      algorithmVersion: "complete-link-greedy-v1",
      clusterId: "b".repeat(64),
      memberIds: REAL_IDS,
      embeddingDimension: 2,
      centroid,
      centroidFingerprint: fingerprintEmbedding(centroid),
      density: { averageSimilarity: 0.9, minimumSimilarity: 0.8,
        maximumSimilarity: 1, memberCount: REAL_IDS.length },
      policy: { similarityThreshold: 0.7, minClusterSize: 3, maxClusterSize: null },
      reasonCodes: ["CLUSTERED"],
      persisted: false
    }
  });
  const provider = { providerId: "fake-qwen", model: "fake-model", version: "v1" };
  const synthesisRequest = buildSynthesisRequest({
    clusterRecord: cluster,
    sources: REAL_IDS.map((id, index) => ({
      id, text: pilotText(id), timestamp: REAL_TIME - index,
      type: "episodic", content_hash: hash(pilotText(id))
    })),
    provider,
    constraints: { language: "it", preserveUncertainty: true,
      preserveContradictions: true },
    limits: { ...DEFAULT_SYNTHESIS_LIMITS }
  });
  const synthesisResult = buildSynthesisResult(synthesisRequest, {
    schema_version: 1,
    title: "Synthetic title",
    synthesis: "Synthetic validated synthesis",
    facts: [{ text: "Synthetic fact", source_memory_ids: REAL_IDS }],
    uncertainties: [], contradictions: [], source_memory_ids: REAL_IDS,
    confidence: 0.9, rejected_source_ids: []
  }, provider);
  const temporalProvenance = {
    schemaVersion: 1,
    temporalPolicyVersion: 1,
    clusterId: cluster.candidate_cluster_id,
    sourceIds: [...REAL_IDS],
    chronologicalSourceIds: [...REAL_IDS].reverse(),
    undatedSourceIds: [],
    temporalStart: REAL_TIME - 2,
    temporalEnd: REAL_TIME,
    timestampQuality: "COMPLETE",
    sourceTimeDescriptors: synthesisResult.sourceContentHashes.map((entry, index) => ({
      memoryId: entry.id, contentHash: entry.content_hash,
      recordedAt: REAL_TIME - index, recordedAtStatus: "VALID",
      eventTime: null, eventTimeStatus: "UNKNOWN"
    }))
  };
  const candidateSuperMemory = createSuperMemoryRecord({
    userId: REAL_USER, clusterRecord: cluster, synthesisResult,
    committedAt: artifactTime, processingAttemptId
  });
  return { createdAt: artifactTime, identityIndexFingerprint: "f".repeat(64),
    cluster, temporalProvenance, synthesisResult, candidateSuperMemory };
}

function liveEnvironment(dataDir) {
  return {
    HIPPOCAMPUS_EMBEDDING_URL: "http://127.0.0.1:8001/api/v1/embed",
    HIPPOCAMPUS_EMBEDDING_API_KEY: "synthetic-key",
    HIPPOCAMPUS_QDRANT_URL: "http://127.0.0.1:6333",
    HIPPOCAMPUS_MEMORY_DATA_DIR: dataDir,
    HIPPOCAMPUS_QWEN_TIMEOUT_MS: "120000",
    PRIMARY_OLLAMA_URL: "http://127.0.0.1:11434/api/chat",
    PRIMARY_MODEL: EXPECTED_QWEN_MODEL
  };
}

function jsonResponse(body) {
  return { ok: true, headers: { get() { return "application/json"; } },
    async text() { return JSON.stringify(body); } };
}

function liveInjections() {
  return {
    qdrantProviderFactory() { return { async health() { return { ready: true }; } }; },
    cacheAdapterFactory() {
      return { async ensureCollection() { return { ready: true }; } };
    },
    synthesisProviderFactory() {
      return { async generate() {
        return { ok: true, status: 200, text: "{\"ready\":true}" };
      } };
    },
    fetchImpl(url) {
      const pathname = new URL(url).pathname;
      if (pathname === "/health") return Promise.resolve(jsonResponse({
        status: "healthy", model: EXPECTED_BGE_MODEL,
        revision: EXPECTED_BGE_REVISION, model_loaded: true,
        device: "cuda", dimension: EXPECTED_BGE_DIMENSION
      }));
      return Promise.resolve(jsonResponse({ models: [{ name: EXPECTED_QWEN_MODEL }] }));
    },
    createRealBoundedPilotRunner(config, ignored, pilotContext) {
      return async ({ signal }) => pilotContext.artifactContext.boundary.accept({
        capability: pilotContext.artifactContext.capability,
        userId: REAL_USER,
        runId: pilotContext.artifactContext.runId,
        signal,
        artifact: realArtifact(pilotContext.processingAttemptId)
      });
    }
  };
}

function request(overrides = {}) {
  return {
    mode: "LIVE", pilot: true, runOnce: true,
    confirmation: LIVE_PILOT_CONFIRMATION, userId: "francesco",
    maxCommits: 1, maxCandidates: 100,
    signal: new AbortController().signal, ...overrides
  };
}

function capability() {
  return Object.freeze({
    schemaVersion: 1,
    capabilityId: "hippocampus-authoritative-commit-v1",
    async commit() { return { committed: true }; }
  });
}

function fixture(overrides = {}) {
  const calls = { pipeline: 0, backup: 0, prepare: 0, commit: 0, verify: 0, recovery: 0, release: 0 };
  const commitReceipt = overrides.commitReceipt || {
    status: "COMMITTED", reasonCode: "COMMITTED", authoritativeReadCount: 2,
    authoritativeWriteCount: 1, commitCalls: 1
  };
  const options = {
    commitCapability: Object.hasOwn(overrides, "commitCapability")
      ? overrides.commitCapability : capability(),
    exclusiveRun: {
      async acquire() { return overrides.lock === false ? null : { fake: true }; },
      async release() { calls.release += 1; }
    },
    preflight: {
      async run() {
        return overrides.preflight || {
          passed: true, storageAttestationValid: true,
          reasonCode: "PREFLIGHT_READY", authoritativeMemoryReads: 1
        };
      }
    },
    boundedRuntime: {
      async runFirstFinalizable() {
        calls.pipeline += 1;
        if (overrides.pipelineError) {
          throw Object.assign(new Error("private"),
            typeof overrides.pipelineError === "string"
              ? { code: overrides.pipelineError } : overrides.pipelineError);
        }
        return overrides.bounded || {
          status: "FINALIZABLE", sourceCount: 3, authoritativeMemoryReads: 2,
          transactionFiles: ["/fake/francesco_memories.json"],
          commitInput: { privateArtifact: true }
        };
      }
    },
    backup: {
      async createVerified() {
        calls.backup += 1;
        if (overrides.backupFailure) return { verified: false };
        return { verified: true, fileCount: 1, entries: [] };
      },
      async verifyUnchangedOrRollback() {
        return overrides.rollback || { matchesBackup: true, rollbackPerformed: true };
      }
    },
    bridge: {
      prepare() {
        calls.prepare += 1;
        return overrides.prepared || {
          preparedCommit: { privatePrepared: true }, receipt: { status: "PREPARED" }
        };
      },
      async commit() {
        calls.commit += 1;
        return { receipt: commitReceipt };
      }
    },
    postCommitVerifier: {
      async verify() {
        calls.verify += 1;
        return overrides.verification || {
          valid: true, superMemoryCreatedCount: 1,
          recallSuperMemoryVerified: true, recallRawVerified: true
        };
      }
    },
    recovery: {
      async verify() { calls.recovery += 1; return { verified: true }; }
    }
  };
  return { pilot: createHippocampusControlledLivePilot(options), calls };
}

test("wrong token and max commits greater than one fail before side effects", async () => {
  for (const changed of [
    { confirmation: "wrong" }, { maxCommits: 2 }
  ]) {
    const state = fixture();
    const result = await state.pilot.run(request(changed));
    assert.equal(result.status, "BLOCKED");
    assert.equal(result.authoritativeMemoryWrites, 0);
    assert.equal(state.calls.pipeline, 0);
  }
  assert.throws(() => parseLivePilotArguments([
    "--mode", "LIVE", "--pilot", "--run-once", "--confirm", "wrong",
    "--user-id", "francesco", "--max-commits", "1", "--max-candidates", "100"
  ], new AbortController().signal), { code: "LIVE_PILOT_CONFIRMATION_REQUIRED" });
});

test("missing server capability fails closed after preflight", async () => {
  const state = fixture({ commitCapability: undefined });
  const result = await state.pilot.run(request());
  assert.equal(result.reasonCode, "COMMIT_CAPABILITY_REQUIRED");
  assert.equal(result.commitCalls, 0);
  assert.equal(state.calls.pipeline, 0);
});

test("failed backup prevents prepare and commit", async () => {
  const state = fixture({ backupFailure: true });
  const result = await state.pilot.run(request());
  assert.equal(result.reasonCode, "BACKUP_VERIFICATION_FAILED");
  assert.equal(state.calls.prepare, 0);
  assert.equal(state.calls.commit, 0);
});

test("stale authoritative hash rejection is surfaced with zero successful write", async () => {
  const state = fixture({ commitReceipt: {
    status: "REJECTED", reasonCode: "STALE_SOURCE_REJECTED",
    authoritativeReadCount: 1, authoritativeWriteCount: 0, commitCalls: 0
  } });
  const result = await state.pilot.run(request());
  assert.equal(result.reasonCode, "STALE_SOURCE_REJECTED");
  assert.equal(result.authoritativeMemoryWrites, 0);
  assert.equal(state.calls.recovery, 0);
});

test("partial transaction failure requires recovery and verified rollback", async () => {
  const state = fixture({ commitReceipt: {
    status: "REJECTED", reasonCode: "TRANSACTION_COMMIT_FAILED",
    authoritativeReadCount: 1, authoritativeWriteCount: 0, commitCalls: 1
  } });
  const result = await state.pilot.run(request());
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.recoveryVerified, true);
  assert.equal(result.rollbackPerformed, true);
  assert.equal(result.realDataModified, false);
  assert.equal(state.calls.recovery, 1);
});

test("identical replay creates no duplicate and reports zero write", async () => {
  const state = fixture({ commitReceipt: {
    status: "IDEMPOTENT_REPLAY", reasonCode: "IDEMPOTENT_COMMIT_REPLAY",
    authoritativeReadCount: 1, authoritativeWriteCount: 0, commitCalls: 0
  } });
  const result = await state.pilot.run(request());
  assert.equal(result.status, "IDEMPOTENT_REPLAY");
  assert.equal(result.superMemoryCreatedCount, 0);
  assert.equal(result.authoritativeMemoryWrites, 0);
  assert.equal(state.calls.verify, 0);
});

test("successful fake pilot commits exactly one and requires direct recall verification", async () => {
  const state = fixture();
  const result = await state.pilot.run(request());
  assert.equal(result.status, "PASSED", JSON.stringify(result));
  assert.equal(result.clusterSelectedCount, 1);
  assert.equal(result.superMemoryCreatedCount, 1);
  assert.equal(result.commitCalls, 1);
  assert.equal(result.recallSuperMemoryVerified, true);
  assert.equal(result.recallRawVerified, true);
  assert.equal(state.calls.commit, 1);
});

test("backup is byte-identical, restrictive and rollback-verifiable", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hact9-fake-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = path.join(directory, "fake.json");
  const initiallyAbsent = path.join(directory, "journal.jsonl");
  fs.writeFileSync(source, "{\"fake\":true}\n", { mode: 0o600 });
  const backupDirectory = path.join(directory, "backup");
  const manager = createVerifiedBackupManager({ backupDirectory });
  const manifest = await manager.createVerified({
    files: [source, initiallyAbsent], signal: new AbortController().signal
  });
  assert.equal(manifest.verified, true);
  assert.equal(manifest.fileCount, 2);
  assert.equal(fs.statSync(backupDirectory).mode & 0o777, 0o700);
  const existingEntry = manifest.entries.find((entry) => entry.existed);
  assert.equal(fs.statSync(existingEntry.backupPath).mode & 0o777, 0o600);
  fs.writeFileSync(source, "changed");
  fs.writeFileSync(initiallyAbsent, "new journal");
  const restored = await manager.verifyUnchangedOrRollback({ manifest, allowRollback: true });
  assert.equal(restored.matchesBackup, true);
  assert.equal(restored.rollbackPerformed, true);
  assert.equal(fs.readFileSync(source, "utf8"), "{\"fake\":true}\n");
  assert.equal(fs.existsSync(initiallyAbsent), false);
});

test("receipts are closed and do not expose content, paths, user or hashes", async () => {
  const state = fixture();
  const result = await state.pilot.run(request());
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /privateArtifact|francesco|\/fake|contentHash|source_memory|SuperMemory text/i);
  assert.deepEqual(Object.keys(result).sort(), [
    "authoritativeMemoryReads", "authoritativeMemoryWrites", "backupFileCount",
    "cacheHitCount", "cacheLookupCount", "cacheMissCount",
    "candidateCountVerified", "clusterCount",
    "clusterSelectedCount", "commitCalls", "preflight", "processingStateWrites",
    "elapsedMsAtFailure", "exactCertificateCount", "failureOperation",
    "failurePhase", "failureProvider", "lastCompletedPhase", "neighborQueryCount",
    "realDataModified", "reasonCode", "recallRawVerified",
    "recallSuperMemoryVerified", "recoveryVerified", "rollbackPerformed",
    "schemaVersion", "sourceCount", "status", "superMemoryCreatedCount"
  ].sort());
});

test("HACT-9 preserves closed failure provenance and partial metrics without secrets", async () => {
  const privateText = "PRIVATE_URL_KEY_PAYLOAD_USER_TEXT";
  const state = fixture({ pipelineError: {
    code: "CONNECTION_RESET",
    privateText,
    hact9Failure: {
      failurePhase: "CACHE_LOOKUP",
      failureProvider: "QDRANT",
      failureOperation: "GET_VALID_EMBEDDING",
      lastCompletedPhase: "PROJECTION",
      elapsedMsAtFailure: 6700,
      candidateCountVerified: 99,
      cacheLookupCount: 17,
      cacheHitCount: 16,
      cacheMissCount: 0,
      neighborQueryCount: 0,
      exactCertificateCount: 0,
      clusterCount: 0,
      endpoint: privateText,
      userId: "francesco"
    }
  } });
  const result = await state.pilot.run(request());
  assert.equal(result.reasonCode, "CONNECTION_RESET");
  assert.equal(result.failurePhase, "CACHE_LOOKUP");
  assert.equal(result.failureProvider, "QDRANT");
  assert.equal(result.failureOperation, "GET_VALID_EMBEDDING");
  assert.equal(result.lastCompletedPhase, "PROJECTION");
  assert.equal(result.candidateCountVerified, 99);
  assert.equal(result.cacheLookupCount, 17);
  assert.equal(result.cacheHitCount, 16);
  assert.equal(result.authoritativeMemoryWrites, 0);
  assert.equal(result.commitCalls, 0);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(privateText));
  assert.doesNotMatch(JSON.stringify(result), /francesco|endpoint|userId/i);
});

test("read-only diagnostic has no commit capability and stops at one finalizable artifact", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hact9-read-only-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, `${REAL_USER}_memories.json`), "{}");
  let runnerCalls = 0;
  const injections = {
    ...liveInjections(),
    createRealBoundedPilotRunner(_config, _injections, pilotContext) {
      assert.equal(pilotContext.readOnly, true);
      assert.equal(Object.hasOwn(pilotContext, "commitCapability"), false);
      return async ({ signal }) => {
        runnerCalls += 1;
        const accepted = pilotContext.artifactContext.boundary.accept({
          capability: pilotContext.artifactContext.capability,
          userId: REAL_USER,
          runId: pilotContext.artifactContext.runId,
          signal,
          artifact: realArtifact(pilotContext.processingAttemptId)
        });
        return { ...accepted, authoritativeMemoryReads: 1,
          candidateCountVerified: 99, cacheLookupCount: 99,
          cacheHitCount: 99, cacheMissCount: 0, neighborQueryCount: 1,
          exactCertificateCount: 1, clusterCount: 1 };
      };
    }
  };
  const diagnostic = createReadOnlyDiagnosticComposition(
    liveEnvironment(directory), injections
  );
  const result = await diagnostic.run({
    ...request(), diagnosticReadOnly: true
  });
  assert.equal(result.status, "READ_ONLY_ARTIFACT_FINALIZABLE", JSON.stringify(result));
  assert.equal(result.commitCalls, 0);
  assert.equal(result.authoritativeMemoryWrites, 0);
  assert.equal(result.processingStateWrites, 0);
  assert.equal(result.backupFileCount, 0);
  assert.equal(result.cacheMissCount, 0);
  assert.equal(runnerCalls, 1);
});

function lifecycleDiagnosticInjections(options = {}) {
  const calls = {
    providerInstances: 0, getCollectionInfo: 0, dispose: 0, signals: []
  };
  const base = liveInjections();
  return {
    calls,
    injections: {
      ...base,
      qdrantProviderFactory() {
        calls.providerInstances += 1;
        const instance = calls.providerInstances;
        return {
          schemaVersion: 1,
          providerId: `lifecycle-provider-${instance}`,
          timeoutMs: 30000,
          maxResponseBytes: 16 * 1024 * 1024,
          async health({ signal }) {
            calls.signals.push(signal);
            return { ok: true };
          },
          async getCollectionInfo({ signal }) {
            calls.getCollectionInfo += 1;
            calls.signals.push(signal);
            if (options.runtimeReset === true && instance === 2) {
              throw Object.assign(new Error("PRIVATE_ENDPOINT_KEY_PAYLOAD"), {
                code: "CONNECTION_RESET", retryable: true
              });
            }
            return { exists: true, collectionStatus: "green", config: {},
              payloadSchema: {} };
          },
          async dispose() { calls.dispose += 1; }
        };
      },
      cacheAdapterFactory({ provider }) {
        return {
          async ensureCollection({ signal }) {
            await provider.getCollectionInfo({ signal });
            return { ready: true };
          }
        };
      },
      createRealBoundedPilotRunner(_config, runtimeInjections, pilotContext) {
        assert.equal(pilotContext.readOnly, true);
        assert.equal(Object.hasOwn(pilotContext, "commitCapability"), false);
        return async ({ signal }) => {
          try {
            const provider = runtimeInjections.qdrantProviderFactory({});
            const cache = runtimeInjections.cacheAdapterFactory({ provider });
            await cache.ensureCollection({ allowCreate: false, signal });
            if (options.abortController) {
              options.abortController.abort();
              throw Object.assign(new Error("aborted"), { code: "RUN_ABORTED" });
            }
            return pilotContext.artifactContext.boundary.accept({
              capability: pilotContext.artifactContext.capability,
              userId: REAL_USER,
              runId: pilotContext.artifactContext.runId,
              signal,
              artifact: realArtifact(pilotContext.processingAttemptId)
            });
          } catch (error) {
            error.hact9Failure = {
              failurePhase: "CACHE_LOOKUP",
              failureProvider: "QDRANT",
              failureOperation: "VERIFY_CACHE_COLLECTION",
              lastCompletedPhase: "PREFLIGHT",
              elapsedMsAtFailure: 1,
              candidateCountVerified: 0,
              cacheLookupCount: 0,
              cacheHitCount: 0,
              cacheMissCount: 0,
              neighborQueryCount: 0,
              exactCertificateCount: 0,
              clusterCount: 0
            };
            throw error;
          }
        };
      }
    }
  };
}

test("live-prefix uses the LIVE factory across sequential preflight/runtime collection reads", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hact9-live-prefix-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, `${REAL_USER}_memories.json`), "{}");
  const setup = lifecycleDiagnosticInjections();
  const composition = createLivePilotComposition(
    liveEnvironment(directory), setup.injections
  );
  assert.equal(typeof composition.run, "function");
  assert.equal(typeof composition.runLivePrefixDiagnostic, "function");
  const runRequest = { ...request(), diagnosticReadOnly: true };
  const result = await composition.runLivePrefixDiagnostic(runRequest);
  assert.equal(result.status, "READ_ONLY_ARTIFACT_FINALIZABLE",
    JSON.stringify(result));
  assert.deepEqual(result.lifecycle, {
    providerInstanceReused: false,
    preflightSignalAbortedAfterReturn: false,
    runtimeSignalSameAsPreflightSignal: true,
    transportDisposed: false,
    requestSequence: 3,
    lowLevelErrorCode: "NONE"
  });
  assert.equal(setup.calls.providerInstances, 2);
  assert.equal(setup.calls.getCollectionInfo, 2);
  assert.equal(setup.calls.dispose, 0);
  assert.equal(setup.calls.signals.every((signal) =>
    signal === runRequest.signal), true);
  assert.equal(runRequest.signal.aborted, false);
  assert.equal(result.authoritativeMemoryWrites, 0);
  assert.equal(result.processingStateWrites, 0);
  assert.equal(result.commitCalls, 0);
});

test("global abort reaches preflight and runtime while preflight timeout cleanup does not abort it", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hact9-live-prefix-abort-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, `${REAL_USER}_memories.json`), "{}");
  const controller = new AbortController();
  const setup = lifecycleDiagnosticInjections({ abortController: controller });
  const composition = createLivePilotComposition(
    liveEnvironment(directory), setup.injections
  );
  const result = await composition.runLivePrefixDiagnostic({
    ...request({ signal: controller.signal }), diagnosticReadOnly: true
  });
  assert.equal(result.reasonCode, "RUN_ABORTED");
  assert.equal(result.lifecycle.preflightSignalAbortedAfterReturn, false);
  assert.equal(result.lifecycle.runtimeSignalSameAsPreflightSignal, true);
  assert.equal(setup.calls.signals.every((signal) =>
    signal === controller.signal), true);
  assert.equal(controller.signal.aborted, true);
  assert.equal(result.commitCalls, 0);
});

test("runtime reset is preserved with one request and no cleanup, retry or secret", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hact9-live-prefix-reset-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, `${REAL_USER}_memories.json`), "{}");
  const setup = lifecycleDiagnosticInjections({ runtimeReset: true });
  const composition = createLivePilotComposition(
    liveEnvironment(directory), setup.injections
  );
  const result = await composition.runLivePrefixDiagnostic({
    ...request(), diagnosticReadOnly: true
  });
  assert.equal(result.reasonCode, "CONNECTION_RESET");
  assert.equal(result.failurePhase, "CACHE_LOOKUP");
  assert.equal(result.failureProvider, "QDRANT");
  assert.equal(result.failureOperation, "VERIFY_CACHE_COLLECTION");
  assert.equal(result.lifecycle.requestSequence, 3);
  assert.equal(result.lifecycle.lowLevelErrorCode, "CONNECTION_RESET");
  assert.equal(result.lifecycle.transportDisposed, false);
  assert.equal(setup.calls.getCollectionInfo, 2);
  assert.equal(setup.calls.dispose, 0);
  assert.equal(result.authoritativeMemoryWrites, 0);
  assert.equal(result.processingStateWrites, 0);
  assert.equal(result.commitCalls, 0);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|endpoint|key|payload/i);
});

test("legacy diagnostic entry point delegates to the LIVE composition factory", () => {
  const source = fs.readFileSync(path.join(
    __dirname, "../../scripts/hippocampus-live-pilot.js"
  ), "utf8");
  assert.match(source, /function createReadOnlyDiagnosticComposition[\s\S]*createLivePilotComposition\(env, injections\)/);
});

test("real HACT-9 composition commits one legacy cluster atomically and preserves unrelated records", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hact9-live-composition-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const memoryFile = path.join(directory, `${REAL_USER}_memories.json`);
  const originals = Object.fromEntries([
    ...REAL_IDS.map((id, index) => [id, {
      id, type: "episodic", content: { text: pilotText(id), preserved: true },
      timestamp: REAL_TIME - index, activation: 0.5,
      orbitalLevel: "medium", tags: ["preserve"]
    }]),
    ["unrelated", {
      id: "unrelated", type: "episodic", content: { text: "Unrelated synthetic" },
      timestamp: 1, activation: 0.1, tags: ["untouched"]
    }]
  ]);
  fs.writeFileSync(memoryFile, JSON.stringify(originals));
  const bridgeLogs = [];
  const pilot = createLivePilotComposition(liveEnvironment(directory), {
    ...liveInjections(), bridgeLogger: { info(value) { bridgeLogs.push(value); } }
  });
  const result = await pilot.run(request());
  assert.equal(result.status, "PASSED", JSON.stringify({ result, bridgeLogs }));
  assert.equal(result.commitCalls, 1);
  assert.equal(result.superMemoryCreatedCount, 1);
  assert.equal(result.processingStateWrites, REAL_IDS.length);
  assert.equal(result.recallSuperMemoryVerified, true);
  assert.equal(result.recallRawVerified, true);
  const after = JSON.parse(fs.readFileSync(memoryFile, "utf8"));
  const superMemories = Object.values(after).filter((item) =>
    item.memoryKind === "super_memory");
  assert.equal(superMemories.length, 1);
  assert.equal(Object.keys(after).length, Object.keys(originals).length + 1);
  assert.deepEqual(after.unrelated, originals.unrelated);
  for (const id of REAL_IDS) {
    assert.deepEqual(after[id].content, originals[id].content);
    assert.equal(after[id].timestamp, originals[id].timestamp);
    assert.equal(after[id].activation, originals[id].activation);
    assert.deepEqual(after[id].tags, originals[id].tags);
    assert.equal(after[id].processing.state, "consolidated");
  }
  assert.doesNotMatch(JSON.stringify(result), /Synthetic HACT-9|Synthetic validated|source-a/i);
});
