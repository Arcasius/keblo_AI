"use strict";

const { createHash } = require("node:crypto");
const { normalizeMemory } = require("../MemoryContractNormalizer");
const { validateClusterRecord } = require("../clustering/ClusterRecord");
const {
  validateTemporalClusterProvenance
} = require("../clustering/HippocampusTemporalProvenance");
const { validateSynthesisResult } = require("../synthesis/SynthesisContract");

const BRIDGE_SCHEMA_VERSION = 1;
const BRIDGE_VERSION = "hippocampus-bounded-commit-bridge-v1";
const COMMIT_CONFIRMATION = "COMMIT_HIPPOCAMPUS_BOUNDED_V1";
const COMMIT_CAPABILITY_ID = "hippocampus-authoritative-commit-v1";
const HEX_64 = /^[a-f0-9]{64}$/;
const INPUT_KEYS = Object.freeze([
  "cluster", "gateSnapshot", "identityIndexFingerprint", "signal",
  "synthesisResult", "temporalProvenance", "userId"
]);
const RECEIPT_KEYS = Object.freeze([
  "status", "reasonCode", "clusterIdHash", "sourceCount",
  "superMemoryIdHash", "processingStateTransitionCount",
  "authoritativeReadCount", "authoritativeWriteCount", "commitCalls"
]);
const PREPARED_KEYS = Object.freeze([
  "schemaVersion", "bridgeVersion", "userScope", "clusterId", "superMemory",
  "sourceIdentities", "temporalProvenance", "synthesisProvenance",
  "processingStateTransitions", "idempotencyKey",
  "expectedAuthoritativeSnapshot", "transactionPlan", "preparedFingerprint"
]);

class HippocampusBoundedCommitBridgeError extends Error {
  constructor(code) {
    super("Hippocampus bounded commit bridge operation failed");
    this.name = "HippocampusBoundedCommitBridgeError";
    this.code = code;
    this.phase = "bounded_commit_bridge";
    this.retryable = false;
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, keys) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.keys(value).map((key) => [key, clone(value[key])]));
  }
  return value;
}

function deepFreeze(value) {
  Object.freeze(value);
  for (const child of Object.values(value)) {
    if (child && typeof child === "object" && !Object.isFrozen(child)) deepFreeze(child);
  }
  return value;
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function sha256Text(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256Value(value) {
  return sha256Text(stableStringify(value));
}

function isAbortSignal(signal) {
  return signal && typeof signal === "object" &&
    typeof signal.aborted === "boolean" &&
    typeof signal.addEventListener === "function" &&
    typeof signal.removeEventListener === "function";
}

function aborted(signal) {
  return !isAbortSignal(signal) || signal.aborted;
}

function gateValid(gate) {
  return isPlainObject(gate) && ["OFF", "SHADOW", "LIVE"].includes(gate.mode) &&
    typeof gate.liveAuthorized === "boolean" &&
    typeof gate.commitAuthorized === "boolean";
}

function receipt(details) {
  const value = {
    status: details.status,
    reasonCode: details.reasonCode,
    clusterIdHash: details.clusterId ? sha256Text(details.clusterId) : null,
    sourceCount: details.sourceCount || 0,
    superMemoryIdHash: details.superMemoryId ? sha256Text(details.superMemoryId) : null,
    processingStateTransitionCount: details.transitionCount || 0,
    authoritativeReadCount: details.readCount || 0,
    authoritativeWriteCount: details.writeCount || 0,
    commitCalls: details.commitCalls || 0
  };
  return deepFreeze(value);
}

function rejected(reasonCode, prepared, counts = {}) {
  return deepFreeze({
    preparedCommit: null,
    receipt: receipt({
      status: "REJECTED",
      reasonCode,
      clusterId: prepared?.clusterId,
      sourceCount: prepared?.sourceIdentities?.length,
      superMemoryId: prepared?.superMemory?.id,
      transitionCount: prepared?.processingStateTransitions?.length,
      ...counts
    })
  });
}

function validateCapability(value) {
  return hasExactKeys(value, ["capabilityId", "commit", "schemaVersion"]) &&
    value.schemaVersion === 1 && value.capabilityId === COMMIT_CAPABILITY_ID &&
    typeof value.commit === "function";
}

function publicLog(logger, event, publicReceipt) {
  if (!logger || typeof logger.info !== "function") return;
  logger.info(deepFreeze({ event, ...publicReceipt }));
}

function sourceUserId(memory) {
  return memory?.meta?.user_id ?? memory?.user_id ?? memory?.userId ?? null;
}

function createIdentityPayload(cluster, sourceIdentities, temporal, synthesis) {
  return {
    bridgeVersion: BRIDGE_VERSION,
    clusterAlgorithm: cluster.algorithm_version,
    clusterId: cluster.candidate_cluster_id,
    sources: sourceIdentities,
    embedding: {
      model: cluster.embedding.model,
      revision: cluster.embedding.version
    },
    synthesisContract: {
      schemaVersion: synthesis.schemaVersion,
      promptVersion: synthesis.promptVersion,
      outputFingerprint: sha256Value(synthesis.output)
    },
    temporalContract: {
      schemaVersion: temporal.schemaVersion,
      policyVersion: temporal.temporalPolicyVersion
    }
  };
}

function preparedSemanticValue(prepared) {
  const copy = clone(prepared);
  delete copy.preparedFingerprint;
  return copy;
}

function createHippocampusBoundedCommitBridge(options) {
  if (!isPlainObject(options) || Object.keys(options).some((key) => ![
    "authoritativeStorage", "clock", "commitCapability", "commitCoordinator",
    "logger", "processingStateContract", "superMemoryRecordFactory"
  ].includes(key)) || !options.authoritativeStorage || !options.commitCoordinator ||
      !options.superMemoryRecordFactory || !options.processingStateContract ||
      typeof options.authoritativeStorage.loadMemories !== "function" ||
      typeof options.commitCoordinator.createPlan !== "function" ||
      typeof options.commitCoordinator.commit !== "function" ||
      typeof options.superMemoryRecordFactory.create !== "function" ||
      typeof options.superMemoryRecordFactory.validate !== "function" ||
      typeof options.processingStateContract.createPreparedTransitions !== "function" ||
      typeof options.processingStateContract.validateState !== "function" ||
      options.clock !== undefined && typeof options.clock.now !== "function" ||
      options.logger !== undefined && options.logger !== null &&
        typeof options.logger.info !== "function") {
    throw new HippocampusBoundedCommitBridgeError("INVALID_PREPARED_COMMIT");
  }

  function prepare(input) {
    if (!hasExactKeys(input, INPUT_KEYS) || aborted(input.signal) ||
        typeof input.userId !== "string" || input.userId.trim().length === 0 ||
        !gateValid(input.gateSnapshot) || !HEX_64.test(input.identityIndexFingerprint || "")) {
      return rejected(aborted(input?.signal) ? "RUN_ABORTED" : "INVALID_PREPARED_COMMIT");
    }
    try {
      const cluster = validateClusterRecord(input.cluster);
      const synthesis = validateSynthesisResult(input.synthesisResult);
      const temporalValidation = validateTemporalClusterProvenance(input.temporalProvenance);
      if (!temporalValidation.valid || cluster.user_id !== input.userId ||
          synthesis.clusterId !== cluster.id ||
          synthesis.clusterRecordFingerprint !== cluster.record_fingerprint ||
          input.temporalProvenance.clusterId !== cluster.candidate_cluster_id) {
        return rejected("INVALID_PREPARED_COMMIT");
      }
      const sourceIdentities = synthesis.sourceContentHashes.map((item) => ({
        memoryId: item.id,
        contentHash: item.content_hash
      })).sort((left, right) => left.memoryId.localeCompare(right.memoryId));
      const temporalSources = input.temporalProvenance.sourceTimeDescriptors.map((item) => ({
        memoryId: item.memoryId,
        contentHash: item.contentHash
      })).sort((left, right) => left.memoryId.localeCompare(right.memoryId));
      if (stableStringify(sourceIdentities) !== stableStringify(temporalSources) ||
          stableStringify(sourceIdentities.map((item) => item.memoryId)) !==
            stableStringify(cluster.source_memory_ids)) {
        return rejected("INVALID_PREPARED_COMMIT");
      }
      const transitions = options.processingStateContract.createPreparedTransitions({
        cluster: clone(cluster),
        synthesisResult: clone(synthesis),
        temporalProvenance: clone(input.temporalProvenance)
      });
      if (!Array.isArray(transitions) || transitions.length !== sourceIdentities.length) {
        return rejected("INVALID_PREPARED_COMMIT");
      }
      const orderedTransitions = transitions.map(clone)
        .sort((left, right) => left.memoryId.localeCompare(right.memoryId));
      const transitionIds = orderedTransitions.map((item) => item.memoryId);
      if (stableStringify(transitionIds) !==
          stableStringify(sourceIdentities.map((item) => item.memoryId))) {
        return rejected("INVALID_PREPARED_COMMIT");
      }
      const committedAt = orderedTransitions[0]?.nextProcessing?.updated_at;
      const attemptId = orderedTransitions[0]?.nextProcessing?.attempt_id;
      if (!Number.isSafeInteger(committedAt) || typeof attemptId !== "string" ||
          orderedTransitions.some((item) => item.nextProcessing?.updated_at !== committedAt ||
            item.nextProcessing?.attempt_id !== attemptId)) {
        return rejected("INVALID_PREPARED_COMMIT");
      }
      const superMemory = options.superMemoryRecordFactory.create({
        userId: input.userId,
        clusterRecord: clone(cluster),
        synthesisResult: clone(synthesis),
        committedAt,
        processingAttemptId: attemptId
      });
      options.superMemoryRecordFactory.validate(superMemory);
      const transactionPlan = options.commitCoordinator.createPlan({
        userId: input.userId,
        clusterRecord: clone(cluster),
        synthesisResult: clone(synthesis),
        sourceTransitionPlans: orderedTransitions,
        committedAt,
        processingAttemptId: attemptId
      });
      if (!isPlainObject(transactionPlan) ||
          transactionPlan.superMemory?.record_fingerprint !== superMemory.record_fingerprint) {
        return rejected("INVALID_PREPARED_COMMIT");
      }
      const idempotencyKey = sha256Value(createIdentityPayload(
        cluster, sourceIdentities, input.temporalProvenance, synthesis
      ));
      const canonicalTemporalProvenance = clone(input.temporalProvenance);
      canonicalTemporalProvenance.sourceTimeDescriptors.sort((left, right) =>
        left.memoryId.localeCompare(right.memoryId));
      const prepared = {
        schemaVersion: BRIDGE_SCHEMA_VERSION,
        bridgeVersion: BRIDGE_VERSION,
        userScope: {
          contractVersion: "authoritative-user-scope-v1",
          userId: input.userId,
          gateMode: input.gateSnapshot.mode,
          liveAuthorized: input.gateSnapshot.liveAuthorized,
          commitAuthorized: input.gateSnapshot.commitAuthorized
        },
        clusterId: cluster.candidate_cluster_id,
        superMemory: clone(superMemory),
        sourceIdentities,
        temporalProvenance: canonicalTemporalProvenance,
        synthesisProvenance: {
          schemaVersion: synthesis.schemaVersion,
          requestId: synthesis.requestId,
          clusterRecordFingerprint: synthesis.clusterRecordFingerprint,
          promptVersion: synthesis.promptVersion,
          provider: clone(synthesis.provider),
          outputFingerprint: sha256Value(synthesis.output)
        },
        processingStateTransitions: orderedTransitions,
        idempotencyKey,
        expectedAuthoritativeSnapshot: {
          identityIndexFingerprint: input.identityIndexFingerprint,
          sourceSetFingerprint: sha256Value(sourceIdentities),
          processingStateFingerprint: sha256Value(orderedTransitions.map((item) => ({
            memoryId: item.memoryId,
            fromState: item.fromState,
            expectedRevision: item.expectedRevision,
            expectedUpdatedAt: item.expectedUpdatedAt,
            expectedAttemptId: item.expectedAttemptId
          })))
        },
        transactionPlan: clone(transactionPlan),
        preparedFingerprint: ""
      };
      prepared.preparedFingerprint = sha256Value(preparedSemanticValue(prepared));
      const frozen = deepFreeze(prepared);
      const preparedReceipt = receipt({
        status: "PREPARED",
        reasonCode: input.gateSnapshot.mode === "SHADOW"
          ? "COMMIT_NOT_AUTHORIZED_IN_SHADOW"
          : "PREPARED",
        clusterId: frozen.clusterId,
        sourceCount: frozen.sourceIdentities.length,
        superMemoryId: frozen.superMemory.id,
        transitionCount: frozen.processingStateTransitions.length
      });
      publicLog(options.logger, "BOUNDED_COMMIT_PREPARED", preparedReceipt);
      return deepFreeze({ preparedCommit: frozen, receipt: preparedReceipt });
    } catch {
      const failure = rejected("INVALID_PREPARED_COMMIT");
      publicLog(options.logger, "BOUNDED_COMMIT_REJECTED", failure.receipt);
      return failure;
    }
  }

  function validatePrepared(prepared) {
    if (!hasExactKeys(prepared, PREPARED_KEYS) ||
        prepared.schemaVersion !== BRIDGE_SCHEMA_VERSION ||
        prepared.bridgeVersion !== BRIDGE_VERSION ||
        !HEX_64.test(prepared.idempotencyKey || "") ||
        !HEX_64.test(prepared.preparedFingerprint || "") ||
        sha256Value(preparedSemanticValue(prepared)) !== prepared.preparedFingerprint ||
        !isPlainObject(prepared.userScope) ||
        typeof prepared.userScope.userId !== "string" ||
        !Array.isArray(prepared.sourceIdentities) ||
        !Array.isArray(prepared.processingStateTransitions) ||
        prepared.sourceIdentities.length !== prepared.processingStateTransitions.length) {
      return false;
    }
    try {
      options.superMemoryRecordFactory.validate(prepared.superMemory);
      return prepared.transactionPlan?.superMemory?.record_fingerprint ===
        prepared.superMemory.record_fingerprint;
    } catch {
      return false;
    }
  }

  async function reread(prepared, signal) {
    if (aborted(signal)) throw new HippocampusBoundedCommitBridgeError("RUN_ABORTED");
    const memories = await options.authoritativeStorage.loadMemories(
      prepared.userScope.userId, { signal }
    );
    if (!Array.isArray(memories)) {
      throw new HippocampusBoundedCommitBridgeError("STALE_SOURCE_REJECTED");
    }
    const map = new Map(memories.map((memory) => [memory?.id, memory]));
    return { memories, map };
  }

  function verifySources(prepared, map, allowCommitted) {
    for (const identity of prepared.sourceIdentities) {
      const memory = map.get(identity.memoryId);
      if (!memory) throw new HippocampusBoundedCommitBridgeError("STALE_SOURCE_REJECTED");
      const scopedUser = sourceUserId(memory);
      if (scopedUser !== null && scopedUser !== prepared.userScope.userId) {
        throw new HippocampusBoundedCommitBridgeError("STALE_SOURCE_REJECTED");
      }
      let text;
      try { text = normalizeMemory(memory).content.text; } catch {
        throw new HippocampusBoundedCommitBridgeError("STALE_SOURCE_REJECTED");
      }
      if (typeof text !== "string" || sha256Text(text) !== identity.contentHash) {
        throw new HippocampusBoundedCommitBridgeError("STALE_SOURCE_REJECTED");
      }
      const transition = prepared.processingStateTransitions.find((item) =>
        item.memoryId === identity.memoryId);
      const validation = options.processingStateContract.validateState(memory.processing);
      if (!validation || validation.valid !== true) {
        throw new HippocampusBoundedCommitBridgeError("SOURCE_PROCESSING_STATE_CONFLICT");
      }
      const committed = stableStringify(memory.processing) ===
        stableStringify(transition.nextProcessing);
      if (allowCommitted && committed) continue;
      if (memory.processing.state !== transition.fromState ||
          memory.processing.revision !== transition.expectedRevision ||
          memory.processing.updated_at !== transition.expectedUpdatedAt ||
          memory.processing.attempt_id !== transition.expectedAttemptId ||
          memory.consolidation &&
            memory.consolidation.super_memory_id !== prepared.superMemory.id) {
        throw new HippocampusBoundedCommitBridgeError("SOURCE_PROCESSING_STATE_CONFLICT");
      }
    }
  }

  function existingDisposition(prepared, map) {
    const existing = map.get(prepared.superMemory.id);
    if (!existing) return "ABSENT";
    try { options.superMemoryRecordFactory.validate(existing); } catch {
      throw new HippocampusBoundedCommitBridgeError("SUPERMEMORY_CONFLICT");
    }
    if (existing.record_fingerprint !== prepared.superMemory.record_fingerprint ||
        existing.idempotency_key !== prepared.superMemory.idempotency_key ||
        stableStringify(existing.provenance) !== stableStringify(prepared.superMemory.provenance) ||
        stableStringify(existing.content) !== stableStringify(prepared.superMemory.content)) {
      throw new HippocampusBoundedCommitBridgeError("SUPERMEMORY_CONFLICT");
    }
    verifySources(prepared, map, true);
    for (const transition of prepared.processingStateTransitions) {
      const memory = map.get(transition.memoryId);
      if (stableStringify(memory.processing) !== stableStringify(transition.nextProcessing)) {
        throw new HippocampusBoundedCommitBridgeError("SUPERMEMORY_CONFLICT");
      }
      if (prepared.superMemory.source_memory_ids.includes(transition.memoryId) &&
          memory.consolidation?.super_memory_id !== prepared.superMemory.id) {
        throw new HippocampusBoundedCommitBridgeError("SUPERMEMORY_CONFLICT");
      }
    }
    return "REPLAY";
  }

  function mapCommitError(error) {
    if (error instanceof HippocampusBoundedCommitBridgeError) return error.code;
    if (error?.code === "POST_COMMIT_VERIFICATION_FAILED") {
      return "POST_COMMIT_VERIFICATION_FAILED";
    }
    if (error?.code === "SUPER_MEMORY_CONFLICT" ||
        error?.code === "IDEMPOTENT_REPLAY_CONFLICT") return "SUPERMEMORY_CONFLICT";
    if (error?.code === "SOURCE_CONTENT_HASH_MISMATCH" || error?.code === "SOURCE_NOT_FOUND") {
      return "STALE_SOURCE_REJECTED";
    }
    if (error?.code === "OPTIMISTIC_PRECONDITION_FAILED") {
      return "SOURCE_PROCESSING_STATE_CONFLICT";
    }
    return "TRANSACTION_COMMIT_FAILED";
  }

  async function commit(input) {
    const prepared = input?.preparedCommit;
    if (!isPlainObject(input) || Object.keys(input).sort().join(",") !==
        ["confirmation", "preparedCommit", "signal"].sort().join(",") ||
        aborted(input.signal)) {
      return rejected(aborted(input?.signal) ? "RUN_ABORTED" : "INVALID_PREPARED_COMMIT", prepared);
    }
    if (!validatePrepared(prepared)) return rejected("INVALID_PREPARED_COMMIT", prepared);
    const preparedMode = prepared.userScope.gateMode;
    if (preparedMode === "SHADOW") return rejected("COMMIT_NOT_AUTHORIZED_IN_SHADOW", prepared);
    if (preparedMode !== "LIVE" || prepared.userScope.liveAuthorized !== true ||
        prepared.userScope.commitAuthorized !== true || input.confirmation !== COMMIT_CONFIRMATION) {
      return rejected("LIVE_GATE_NOT_AUTHORIZED", prepared);
    }
    if (!validateCapability(options.commitCapability)) {
      return rejected("COMMIT_CAPABILITY_REQUIRED", prepared);
    }
    let readCount = 0;
    let commitCalls = 0;
    try {
      const before = await reread(prepared, input.signal); readCount += 1;
      const disposition = existingDisposition(prepared, before.map);
      if (disposition === "REPLAY") {
        const replayReceipt = receipt({
          status: "IDEMPOTENT_REPLAY", reasonCode: "IDEMPOTENT_COMMIT_REPLAY",
          clusterId: prepared.clusterId, sourceCount: prepared.sourceIdentities.length,
          superMemoryId: prepared.superMemory.id,
          transitionCount: prepared.processingStateTransitions.length,
          readCount, writeCount: 0, commitCalls: 0
        });
        publicLog(options.logger, "BOUNDED_COMMIT_REPLAY", replayReceipt);
        return deepFreeze({ preparedCommit: null, receipt: replayReceipt });
      }
      verifySources(prepared, before.map, false);
      if (aborted(input.signal)) throw new HippocampusBoundedCommitBridgeError("RUN_ABORTED");
      commitCalls = 1;
      const report = await options.commitCapability.commit({
        authoritativeStorage: options.authoritativeStorage,
        commitCoordinator: options.commitCoordinator,
        transactionPlan: prepared.transactionPlan,
        signal: input.signal
      });
      if (!isPlainObject(report) || report.committed !== true &&
          report.idempotentReplay !== true) {
        throw new HippocampusBoundedCommitBridgeError("TRANSACTION_COMMIT_FAILED");
      }
      const after = await reread(prepared, input.signal); readCount += 1;
      if (existingDisposition(prepared, after.map) !== "REPLAY") {
        throw new HippocampusBoundedCommitBridgeError("POST_COMMIT_VERIFICATION_FAILED");
      }
      const wasReplay = report.idempotentReplay === true;
      const committedReceipt = receipt({
        status: wasReplay ? "IDEMPOTENT_REPLAY" : "COMMITTED",
        reasonCode: wasReplay ? "IDEMPOTENT_COMMIT_REPLAY" : "COMMITTED",
        clusterId: prepared.clusterId,
        sourceCount: prepared.sourceIdentities.length,
        superMemoryId: prepared.superMemory.id,
        transitionCount: prepared.processingStateTransitions.length,
        readCount,
        writeCount: wasReplay ? 0 : 1,
        commitCalls
      });
      publicLog(options.logger, "BOUNDED_COMMIT_COMPLETED", committedReceipt);
      return deepFreeze({ preparedCommit: null, receipt: committedReceipt });
    } catch (error) {
      const failure = rejected(mapCommitError(error), prepared, {
        readCount, writeCount: 0, commitCalls
      });
      publicLog(options.logger, "BOUNDED_COMMIT_REJECTED", failure.receipt);
      return failure;
    }
  }

  return Object.freeze({ prepare, commit });
}

module.exports = {
  BRIDGE_SCHEMA_VERSION,
  BRIDGE_VERSION,
  COMMIT_CONFIRMATION,
  COMMIT_CAPABILITY_ID,
  RECEIPT_KEYS,
  HippocampusBoundedCommitBridgeError,
  createHippocampusBoundedCommitBridge
};
