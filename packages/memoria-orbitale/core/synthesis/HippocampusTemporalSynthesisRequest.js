"use strict";

const { createHash } = require("node:crypto");
const {
  EVENT_TIME_STATUSES,
  TEMPORAL_POLICY_VERSION,
  validateTemporalClusterProvenance
} = require("../clustering/HippocampusTemporalProvenance");

const TEMPORAL_SYNTHESIS_REQUEST_SCHEMA_VERSION = 1;
const TEMPORAL_SYNTHESIS_REQUEST_CONTRACT_VERSION =
  "hippocampus-temporal-synthesis-request-v1";
const CURRENT_STATE_EVIDENCE_CONTRACT_VERSION = 1;
const INPUT_KEYS = Object.freeze(["temporalProvenance"]);

class HippocampusTemporalSynthesisRequestError extends Error {
  constructor(code, phase = "temporal_synthesis_request") {
    super("Hippocampus temporal synthesis request validation failed");
    this.name = "HippocampusTemporalSynthesisRequestError";
    this.code = code;
    this.phase = phase;
    this.retryable = false;
  }
}

function fail(code, phase) {
  throw new HippocampusTemporalSynthesisRequestError(code, phase);
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

function sourceReference(descriptor) {
  return {
    memoryId: descriptor.memoryId,
    contentHash: descriptor.contentHash,
    recordedAt: descriptor.recordedAt,
    recordedAtStatus: descriptor.recordedAtStatus,
    eventTime: descriptor.eventTime,
    eventTimeStatus: descriptor.eventTimeStatus
  };
}

function requestIdentity(request) {
  const { requestId, ...identity } = request;
  return identity;
}

function createTemporalSynthesisRequest(input) {
  if (!hasExactKeys(input, INPUT_KEYS)) fail("INVALID_TEMPORAL_SYNTHESIS_INPUT", "input");
  const validation = validateTemporalClusterProvenance(input.temporalProvenance);
  if (!validation.valid) fail(validation.errors[0], "temporal_provenance");
  const provenance = input.temporalProvenance;
  const byMemoryId = new Map(provenance.sourceTimeDescriptors.map((descriptor) =>
    [descriptor.memoryId, descriptor]));
  const request = {
    schemaVersion: TEMPORAL_SYNTHESIS_REQUEST_SCHEMA_VERSION,
    requestContractVersion: TEMPORAL_SYNTHESIS_REQUEST_CONTRACT_VERSION,
    requestId: "",
    clusterId: provenance.clusterId,
    semanticSourceIds: [...provenance.sourceIds],
    temporalPolicyVersion: TEMPORAL_POLICY_VERSION,
    timestampQuality: provenance.timestampQuality,
    sections: [
      {
        sectionType: "RECORDED_AT_CHRONOLOGY",
        sourceReferences: provenance.chronologicalSourceIds.map((memoryId) =>
          sourceReference(byMemoryId.get(memoryId)))
      },
      {
        sectionType: "UNDATED_SOURCES",
        sourceReferences: provenance.undatedSourceIds.map((memoryId) =>
          sourceReference(byMemoryId.get(memoryId)))
      }
    ],
    authoritativeRereadRequirement: {
      required: true,
      requireMemoryIdMatch: true,
      requireContentHashMatch: true,
      mismatchDisposition: "FAIL_CLOSED"
    },
    interpretationPolicy: {
      recordedAtIsEventTime: false,
      lastAccessExcluded: true,
      mostRecentDoesNotImplyCurrent: true,
      preserveChanges: true,
      preserveContradictions: true,
      preserveSupersessions: true
    },
    currentStateEvidence: {
      evidenceContractVersion: CURRENT_STATE_EVIDENCE_CONTRACT_VERSION,
      evidenceStatus: "NOT_PROVIDED",
      currentStateSupported: false,
      evidenceReferences: []
    },
    execution: {
      requestOnly: true,
      providerInvocationAuthorized: false
    }
  };
  request.requestId = createHash("sha256").update(stableStringify({
    domain: TEMPORAL_SYNTHESIS_REQUEST_CONTRACT_VERSION,
    request: requestIdentity(request)
  }), "utf8").digest("hex");
  return deepFreeze(request);
}

function validateTemporalSynthesisRequest(request, temporalProvenance) {
  try {
    const recreated = createTemporalSynthesisRequest({ temporalProvenance });
    if (stableStringify(recreated) !== stableStringify(request) ||
        request.currentStateEvidence.currentStateSupported !== false ||
        request.sections.length !== 2 ||
        request.sections.flatMap((section) => section.sourceReferences)
          .some((reference) => !Object.values(EVENT_TIME_STATUSES)
            .includes(reference.eventTimeStatus))) {
      fail("TEMPORAL_SYNTHESIS_REQUEST_MISMATCH", "validation");
    }
    return deepFreeze({ valid: true, errors: [] });
  } catch (error) {
    const code = error instanceof HippocampusTemporalSynthesisRequestError
      ? error.code
      : "INVALID_TEMPORAL_SYNTHESIS_REQUEST";
    return deepFreeze({ valid: false, errors: [code] });
  }
}

module.exports = {
  TEMPORAL_SYNTHESIS_REQUEST_SCHEMA_VERSION,
  TEMPORAL_SYNTHESIS_REQUEST_CONTRACT_VERSION,
  CURRENT_STATE_EVIDENCE_CONTRACT_VERSION,
  HippocampusTemporalSynthesisRequestError,
  createTemporalSynthesisRequest,
  validateTemporalSynthesisRequest
};
