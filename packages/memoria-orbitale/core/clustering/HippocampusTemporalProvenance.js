"use strict";

const {
  TIMESTAMP_QUALITY,
  validateBoundedClusteringPlan,
  validateGlobalIdentitySnapshot
} = require("./HippocampusBoundedClusteringPlan");

const TEMPORAL_PROVENANCE_SCHEMA_VERSION = 1;
const TEMPORAL_POLICY_VERSION = 1;
const EVENT_TIME_EVIDENCE_CONTRACT_VERSION = 1;
const EVENT_TIME_AUTHORITY = "EXPLICIT_STRUCTURED_EVENT_TIME";

const RECORDED_AT_STATUSES = deepFreeze({
  VALID: "VALID",
  MISSING: "MISSING",
  INVALID: "INVALID",
  UNSUPPORTED_SOURCE_CONTRACT: "UNSUPPORTED_SOURCE_CONTRACT"
});

const EVENT_TIME_STATUSES = deepFreeze({
  AVAILABLE_EXPLICIT_STRUCTURED: "AVAILABLE_EXPLICIT_STRUCTURED",
  UNKNOWN: "UNKNOWN"
});

const SOURCE_CONTRACTS = new Set(["flat", "nested", "hybrid", "unknown"]);
const RECORDED_STATUS_VALUES = new Set(Object.values(RECORDED_AT_STATUSES));
const EVENT_STATUS_VALUES = new Set(Object.values(EVENT_TIME_STATUSES));
const HEX_64 = /^[a-f0-9]{64}$/;

const INPUT_KEYS = Object.freeze([
  "boundedClusteringPlan", "clusterId", "identitySnapshot", "sources"
]);
const SOURCE_KEYS = Object.freeze([
  "contentHash", "eventTimeEvidence", "lastAccess", "memoryId",
  "sourceContract", "timestamp"
]);
const EVENT_EVIDENCE_KEYS = Object.freeze([
  "authority", "eventTime", "evidenceContractVersion"
]);
const OUTPUT_KEYS = Object.freeze([
  "chronologicalSourceIds", "clusterId", "schemaVersion", "sourceIds",
  "sourceTimeDescriptors", "temporalEnd", "temporalPolicyVersion",
  "temporalStart", "timestampQuality", "undatedSourceIds"
]);
const DESCRIPTOR_KEYS = Object.freeze([
  "contentHash", "eventTime", "eventTimeStatus", "memoryId", "recordedAt",
  "recordedAtStatus"
]);

class HippocampusTemporalProvenanceError extends Error {
  constructor(code, phase = "temporal_provenance") {
    super("Hippocampus temporal provenance validation failed");
    this.name = "HippocampusTemporalProvenanceError";
    this.code = code;
    this.phase = phase;
    this.retryable = false;
  }
}

function fail(code, phase) {
  throw new HippocampusTemporalProvenanceError(code, phase);
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

function isDeepFrozen(value) {
  if (!value || typeof value !== "object" || !Object.isFrozen(value)) return false;
  return Object.values(value).every((child) =>
    !child || typeof child !== "object" || isDeepFrozen(child));
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isTimestamp(value) {
  return Number.isSafeInteger(value);
}

function isIgnoredLastAccessValue(value) {
  return value === null || typeof value === "string" ||
    typeof value === "number" && Number.isFinite(value);
}

function normalizeEventTime(evidence) {
  if (evidence === null) {
    return { eventTime: null, eventTimeStatus: EVENT_TIME_STATUSES.UNKNOWN };
  }
  if (!hasExactKeys(evidence, EVENT_EVIDENCE_KEYS) ||
      evidence.evidenceContractVersion !== EVENT_TIME_EVIDENCE_CONTRACT_VERSION ||
      evidence.authority !== EVENT_TIME_AUTHORITY || !isTimestamp(evidence.eventTime)) {
    fail("INVALID_EVENT_TIME_EVIDENCE", "event_time");
  }
  return {
    eventTime: evidence.eventTime,
    eventTimeStatus: EVENT_TIME_STATUSES.AVAILABLE_EXPLICIT_STRUCTURED
  };
}

function normalizeRecordedAt(source) {
  if (source.sourceContract !== "flat") {
    return {
      recordedAt: null,
      recordedAtStatus: RECORDED_AT_STATUSES.UNSUPPORTED_SOURCE_CONTRACT
    };
  }
  if (source.timestamp === null) {
    return { recordedAt: null, recordedAtStatus: RECORDED_AT_STATUSES.MISSING };
  }
  if (!isTimestamp(source.timestamp)) {
    return { recordedAt: null, recordedAtStatus: RECORDED_AT_STATUSES.INVALID };
  }
  return { recordedAt: source.timestamp, recordedAtStatus: RECORDED_AT_STATUSES.VALID };
}

function deriveTimestampQuality(descriptors) {
  const validCount = descriptors.filter((descriptor) =>
    descriptor.recordedAtStatus === RECORDED_AT_STATUSES.VALID).length;
  if (validCount === 0) return TIMESTAMP_QUALITY.UNKNOWN;
  if (descriptors.some((descriptor) =>
    descriptor.recordedAtStatus === RECORDED_AT_STATUSES.INVALID)) {
    return TIMESTAMP_QUALITY.PARTIAL_INVALID;
  }
  if (validCount !== descriptors.length) return TIMESTAMP_QUALITY.PARTIAL_MISSING;
  return TIMESTAMP_QUALITY.COMPLETE;
}

function assertCreationInput(input) {
  if (!hasExactKeys(input, INPUT_KEYS) || !Array.isArray(input.sources) ||
      typeof input.clusterId !== "string" || !isDeepFrozen(input.identitySnapshot) ||
      !isDeepFrozen(input.boundedClusteringPlan)) {
    fail("INVALID_TEMPORAL_PROVENANCE_INPUT", "validation");
  }
  const snapshotValidation = validateGlobalIdentitySnapshot(input.identitySnapshot);
  if (!snapshotValidation.valid) fail(snapshotValidation.errors[0], "snapshot");
  const planValidation = validateBoundedClusteringPlan(
    input.boundedClusteringPlan, input.identitySnapshot
  );
  if (!planValidation.valid) fail(planValidation.errors[0], "bounded_plan");
}

function createTemporalClusterProvenance(input) {
  assertCreationInput(input);
  const cluster = input.boundedClusteringPlan.clusters.find((item) =>
    item.clusterId === input.clusterId);
  if (!cluster) fail("UNKNOWN_VERIFIED_CLUSTER", "membership");
  const sourceIds = [...cluster.memberIds].sort(compareStrings);
  if (input.sources.length !== sourceIds.length) {
    fail("INCOMPLETE_TEMPORAL_SOURCE_COVERAGE", "coverage");
  }
  const identities = new Map(input.identitySnapshot.identities.map((identity) =>
    [identity.memoryId, identity]));
  const seen = new Set();
  const descriptors = [];
  for (const source of input.sources) {
    if (!hasExactKeys(source, SOURCE_KEYS) ||
        typeof source.memoryId !== "string" || !HEX_64.test(source.contentHash || "") ||
        !SOURCE_CONTRACTS.has(source.sourceContract) ||
        !isIgnoredLastAccessValue(source.lastAccess) || seen.has(source.memoryId) ||
        !sourceIds.includes(source.memoryId)) {
      fail("INVALID_SOURCE_TIME_INPUT", "source");
    }
    const identity = identities.get(source.memoryId);
    if (!identity || identity.contentHash !== source.contentHash) {
      fail("STALE_TEMPORAL_SOURCE", "content_hash");
    }
    seen.add(source.memoryId);
    descriptors.push({
      memoryId: source.memoryId,
      contentHash: source.contentHash,
      ...normalizeRecordedAt(source),
      ...normalizeEventTime(source.eventTimeEvidence)
    });
  }
  if (seen.size !== sourceIds.length) {
    fail("INCOMPLETE_TEMPORAL_SOURCE_COVERAGE", "coverage");
  }
  descriptors.sort((left, right) => compareStrings(left.memoryId, right.memoryId));
  const chronological = descriptors.filter((descriptor) =>
    descriptor.recordedAtStatus === RECORDED_AT_STATUSES.VALID).sort((left, right) =>
    left.recordedAt - right.recordedAt || compareStrings(left.memoryId, right.memoryId));
  const undatedSourceIds = descriptors.filter((descriptor) =>
    descriptor.recordedAtStatus !== RECORDED_AT_STATUSES.VALID)
    .map((descriptor) => descriptor.memoryId).sort(compareStrings);
  return deepFreeze({
    schemaVersion: TEMPORAL_PROVENANCE_SCHEMA_VERSION,
    temporalPolicyVersion: TEMPORAL_POLICY_VERSION,
    clusterId: cluster.clusterId,
    sourceIds,
    chronologicalSourceIds: chronological.map((descriptor) => descriptor.memoryId),
    undatedSourceIds,
    temporalStart: chronological.length === 0 ? null : chronological[0].recordedAt,
    temporalEnd: chronological.length === 0
      ? null
      : chronological[chronological.length - 1].recordedAt,
    timestampQuality: deriveTimestampQuality(descriptors),
    sourceTimeDescriptors: descriptors
  });
}

function assertTemporalClusterProvenance(value) {
  if (!hasExactKeys(value, OUTPUT_KEYS) ||
      value.schemaVersion !== TEMPORAL_PROVENANCE_SCHEMA_VERSION ||
      value.temporalPolicyVersion !== TEMPORAL_POLICY_VERSION ||
      !HEX_64.test(value.clusterId || "") || !Array.isArray(value.sourceIds) ||
      !Array.isArray(value.chronologicalSourceIds) ||
      !Array.isArray(value.undatedSourceIds) || !Array.isArray(value.sourceTimeDescriptors) ||
      !Object.values(TIMESTAMP_QUALITY).includes(value.timestampQuality)) {
    fail("INVALID_TEMPORAL_PROVENANCE", "validation");
  }
  const sourceIds = [...value.sourceIds];
  if (sourceIds.length < 3 || new Set(sourceIds).size !== sourceIds.length ||
      sourceIds.some((id) => typeof id !== "string" || id.length === 0) ||
      sourceIds.some((id, index) => id !== [...sourceIds].sort(compareStrings)[index]) ||
      value.sourceTimeDescriptors.length !== sourceIds.length) {
    fail("INVALID_TEMPORAL_MEMBERSHIP", "membership");
  }
  const descriptors = new Map();
  for (const descriptor of value.sourceTimeDescriptors) {
    if (!hasExactKeys(descriptor, DESCRIPTOR_KEYS) ||
        !sourceIds.includes(descriptor.memoryId) || descriptors.has(descriptor.memoryId) ||
        !HEX_64.test(descriptor.contentHash || "") ||
        !RECORDED_STATUS_VALUES.has(descriptor.recordedAtStatus) ||
        !EVENT_STATUS_VALUES.has(descriptor.eventTimeStatus) ||
        (descriptor.recordedAtStatus === RECORDED_AT_STATUSES.VALID) !==
          isTimestamp(descriptor.recordedAt) ||
        (descriptor.eventTimeStatus === EVENT_TIME_STATUSES.AVAILABLE_EXPLICIT_STRUCTURED) !==
          isTimestamp(descriptor.eventTime)) {
      fail("INVALID_SOURCE_TIME_DESCRIPTOR", "descriptor");
    }
    descriptors.set(descriptor.memoryId, descriptor);
  }
  const chronological = [...descriptors.values()].filter((descriptor) =>
    descriptor.recordedAtStatus === RECORDED_AT_STATUSES.VALID).sort((left, right) =>
    left.recordedAt - right.recordedAt || compareStrings(left.memoryId, right.memoryId));
  const chronologicalIds = chronological.map((descriptor) => descriptor.memoryId);
  const undatedIds = sourceIds.filter((id) => !chronologicalIds.includes(id)).sort(compareStrings);
  if (JSON.stringify(value.chronologicalSourceIds) !== JSON.stringify(chronologicalIds) ||
      JSON.stringify(value.undatedSourceIds) !== JSON.stringify(undatedIds) ||
      value.temporalStart !== (chronological.length === 0 ? null : chronological[0].recordedAt) ||
      value.temporalEnd !== (chronological.length === 0
        ? null
        : chronological[chronological.length - 1].recordedAt) ||
      value.timestampQuality !== deriveTimestampQuality([...descriptors.values()])) {
    fail("INCOHERENT_TEMPORAL_PROVENANCE", "coverage");
  }
  return value;
}

function validateTemporalClusterProvenance(value) {
  try {
    assertTemporalClusterProvenance(value);
    return deepFreeze({ valid: true, errors: [] });
  } catch (error) {
    const code = error instanceof HippocampusTemporalProvenanceError
      ? error.code
      : "INVALID_TEMPORAL_PROVENANCE";
    return deepFreeze({ valid: false, errors: [code] });
  }
}

module.exports = {
  TEMPORAL_PROVENANCE_SCHEMA_VERSION,
  TEMPORAL_POLICY_VERSION,
  EVENT_TIME_EVIDENCE_CONTRACT_VERSION,
  EVENT_TIME_AUTHORITY,
  RECORDED_AT_STATUSES,
  EVENT_TIME_STATUSES,
  HippocampusTemporalProvenanceError,
  createTemporalClusterProvenance,
  validateTemporalClusterProvenance
};
