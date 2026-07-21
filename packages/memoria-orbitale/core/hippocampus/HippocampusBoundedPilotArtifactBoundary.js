"use strict";

const { validateClusterRecord } = require("../clustering/ClusterRecord");
const {
  validateTemporalClusterProvenance
} = require("../clustering/HippocampusTemporalProvenance");
const { validateSynthesisResult } = require("../synthesis/SynthesisContract");
const {
  validateSuperMemoryRecord
} = require("../consolidation/SuperMemoryRecord");

const BOUNDED_PILOT_ARTIFACT_BOUNDARY_VERSION =
  "hippocampus-bounded-pilot-artifact-boundary-v1";
const BOUNDED_PILOT_ARTIFACT_CAPABILITY_ID =
  "hippocampus-bounded-pilot-artifact-v1";
const HEX_64 = /^[a-f0-9]{64}$/;
const AUTHORIZED_USER_ID = "francesco";

class HippocampusBoundedPilotArtifactBoundaryError extends Error {
  constructor(code) {
    super("Hippocampus bounded pilot artifact boundary failed");
    this.name = "HippocampusBoundedPilotArtifactBoundaryError";
    this.code = code;
    this.phase = "bounded_pilot_artifact_boundary";
    this.retryable = false;
  }
}

function fail(code) {
  throw new HippocampusBoundedPilotArtifactBoundaryError(code);
}

function plain(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exact(value, keys) {
  return plain(value) && Object.keys(value).sort().join(",") ===
    [...keys].sort().join(",");
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function createHippocampusBoundedPilotArtifactBoundary(options) {
  if (!exact(options, ["capability", "maxAgeMs", "now", "runId", "userId"]) ||
      !plain(options.capability) ||
      options.capability.capabilityId !== BOUNDED_PILOT_ARTIFACT_CAPABILITY_ID ||
      options.capability.schemaVersion !== 1 ||
      options.capability.userId !== options.userId ||
      options.capability.runId !== options.runId || options.userId !== AUTHORIZED_USER_ID ||
      typeof options.now !== "function" || !Number.isSafeInteger(options.maxAgeMs) ||
      options.maxAgeMs <= 0) {
    fail("INVALID_BOUNDED_PILOT_ARTIFACT_BOUNDARY");
  }
  let accepted = false;

  function accept(request) {
    if (!exact(request, ["artifact", "capability", "runId", "signal", "userId"]) ||
        request.capability !== options.capability || request.userId !== options.userId ||
        request.runId !== options.runId || request.signal?.aborted === true) {
      fail("BOUNDED_PILOT_ARTIFACT_CAPABILITY_REQUIRED");
    }
    if (accepted) fail("MULTIPLE_BOUNDED_PILOT_ARTIFACTS");
    const artifact = request.artifact;
    if (!exact(artifact, [
      "candidateSuperMemory", "cluster", "createdAt", "identityIndexFingerprint",
      "synthesisResult", "temporalProvenance"
    ]) || !Number.isSafeInteger(artifact.createdAt) ||
        artifact.createdAt > options.now() ||
        options.now() - artifact.createdAt > options.maxAgeMs ||
        !HEX_64.test(artifact.identityIndexFingerprint || "")) {
      fail("STALE_BOUNDED_PILOT_ARTIFACT");
    }
    let cluster;
    let synthesis;
    let temporal;
    let candidate;
    try {
      cluster = validateClusterRecord(artifact.cluster);
      synthesis = validateSynthesisResult(artifact.synthesisResult);
      temporal = validateTemporalClusterProvenance(artifact.temporalProvenance);
      candidate = validateSuperMemoryRecord(artifact.candidateSuperMemory);
    } catch {
      fail("INCOMPLETE_BOUNDED_PILOT_ARTIFACT");
    }
    if (!temporal.valid || cluster.user_id !== options.userId ||
        candidate.userId !== options.userId || synthesis.clusterId !== cluster.id ||
        synthesis.clusterRecordFingerprint !== cluster.record_fingerprint ||
        artifact.temporalProvenance.clusterId !== cluster.candidate_cluster_id ||
        !same(cluster.source_memory_ids, artifact.temporalProvenance.sourceIds) ||
        !same(cluster.source_memory_ids,
          synthesis.sourceContentHashes.map((item) => item.id).sort()) ||
        candidate.cluster_id !== cluster.id ||
        !same(candidate.provenance.source_content_hashes,
          synthesis.sourceContentHashes)) {
      fail("BOUNDED_PILOT_ARTIFACT_PROVENANCE_MISMATCH");
    }
    accepted = true;
    return Object.freeze({
      schemaVersion: 1,
      boundaryVersion: BOUNDED_PILOT_ARTIFACT_BOUNDARY_VERSION,
      status: "FINALIZABLE",
      sourceCount: cluster.source_memory_ids.length,
      identityIndexFingerprint: artifact.identityIndexFingerprint,
      idempotencyKey: candidate.idempotency_key,
      candidateSuperMemory: candidate,
      commitInput: Object.freeze({
        userId: options.userId,
        gateSnapshot: Object.freeze({
          mode: "LIVE", liveAuthorized: true, commitAuthorized: true
        }),
        identityIndexFingerprint: artifact.identityIndexFingerprint,
        cluster,
        temporalProvenance: artifact.temporalProvenance,
        synthesisResult: synthesis,
        signal: request.signal
      })
    });
  }

  return Object.freeze({ accept });
}

module.exports = {
  BOUNDED_PILOT_ARTIFACT_BOUNDARY_VERSION,
  BOUNDED_PILOT_ARTIFACT_CAPABILITY_ID,
  HippocampusBoundedPilotArtifactBoundaryError,
  createHippocampusBoundedPilotArtifactBoundary
};
