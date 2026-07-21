"use strict";

const { createHash } = require("node:crypto");
const {
  DEFAULT_BOUNDED_CLUSTERING_POLICY,
  DISCOVERY_COMPLETENESS,
  validateGlobalIdentitySnapshot
} = require("./HippocampusBoundedClusteringPlan");

const THRESHOLD_DISCOVERY_CERTIFICATE_VERSION =
  "hippocampus-threshold-discovery-certificate-v1";
const THRESHOLD_DISCOVERY_MODE = "EXACT_ABOVE_THRESHOLD_ENUMERATION_V1";

const CERTIFICATE_STATUSES = deepFreeze({
  VALID: "VALID",
  ABSENT: "ABSENT",
  INVALID: "INVALID"
});

const COMPONENT_CLOSURE_STATUSES = deepFreeze({
  AUTHORIZED_FOR_REFINEMENT: "AUTHORIZED_FOR_REFINEMENT",
  DEFERRED: "DEFERRED"
});

const CERTIFICATE_REASON_CODES = deepFreeze({
  CERTIFICATE_ABSENT: "CERTIFICATE_ABSENT",
  MALFORMED_DISCOVERY_CERTIFICATE: "MALFORMED_DISCOVERY_CERTIFICATE",
  UNKNOWN_CERTIFICATE_VERSION: "UNKNOWN_CERTIFICATE_VERSION",
  UNKNOWN_CERTIFICATE_MODE: "UNKNOWN_CERTIFICATE_MODE",
  CERTIFICATE_SNAPSHOT_MISMATCH: "CERTIFICATE_SNAPSHOT_MISMATCH",
  CERTIFICATE_QUERY_NOT_CURRENT: "CERTIFICATE_QUERY_NOT_CURRENT",
  CERTIFICATE_QUERY_MISMATCH: "CERTIFICATE_QUERY_MISMATCH",
  CERTIFICATE_PROVENANCE_MISMATCH: "CERTIFICATE_PROVENANCE_MISMATCH",
  CERTIFICATE_THRESHOLD_MISMATCH: "CERTIFICATE_THRESHOLD_MISMATCH",
  CERTIFICATE_COUNTERS_INVALID: "CERTIFICATE_COUNTERS_INVALID",
  CERTIFICATE_ENUMERATION_COUNT_MISMATCH: "CERTIFICATE_ENUMERATION_COUNT_MISMATCH",
  CERTIFICATE_NOT_EXHAUSTED: "CERTIFICATE_NOT_EXHAUSTED",
  CERTIFICATE_TRUNCATED: "CERTIFICATE_TRUNCATED",
  CERTIFICATE_CONTINUATION_PRESENT: "CERTIFICATE_CONTINUATION_PRESENT",
  PROVIDER_DISCOVERY_NOT_CERTIFIABLE: "PROVIDER_DISCOVERY_NOT_CERTIFIABLE",
  QUERY_NOT_COMPLETED: "QUERY_NOT_COMPLETED"
});

const EVALUATION_INPUT_KEYS = Object.freeze([
  "identitySnapshot", "queryPointId", "providerCompleteness", "certificate",
  "observedAboveThresholdCount"
]);
const PREPARED_EVALUATION_INPUT_KEYS = Object.freeze([
  "queryPointId", "providerCompleteness", "certificate", "observedAboveThresholdCount"
]);
const CERTIFICATE_KEYS = Object.freeze([
  "certificateVersion", "mode", "identityIndexFingerprint", "queryPointId",
  "clusterThreshold", "embeddingModel", "embeddingRevision",
  "eligibleIdentityCount", "enumeratedAboveThresholdCount", "exhausted",
  "truncated", "continuation"
]);
const COMPLETENESS_VALUES = new Set(Object.values(DISCOVERY_COMPLETENESS));

class HippocampusDiscoveryCompletenessError extends Error {
  constructor(code, phase = "discovery_certificate") {
    super("Hippocampus discovery completeness validation failed");
    this.name = "HippocampusDiscoveryCompletenessError";
    this.code = code;
    this.phase = phase;
    this.retryable = false;
  }
}

function fail(code, phase) {
  throw new HippocampusDiscoveryCompletenessError(code, phase);
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
    `${JSON.stringify(key)}:${stableStringify(value[key])}`
  ).join(",")}}`;
}

function fingerprint(value) {
  return createHash("sha256").update(stableStringify(value), "utf8").digest("hex");
}

function incompleteFromProvider(providerCompleteness) {
  return providerCompleteness === DISCOVERY_COMPLETENESS.FAILED ||
    providerCompleteness === DISCOVERY_COMPLETENESS.INCOMPLETE_TRUNCATED
    ? providerCompleteness
    : DISCOVERY_COMPLETENESS.INCOMPLETE_UNCERTIFIED;
}

function evaluation(certificateStatus, reasonCode, discoveryCompleteness,
  certificateFingerprint = null) {
  return deepFreeze({
    certificateStatus,
    reasonCode,
    discoveryCompleteness,
    certificateFingerprint
  });
}

function invalid(reasonCode, providerCompleteness) {
  return evaluation(
    CERTIFICATE_STATUSES.INVALID,
    reasonCode,
    incompleteFromProvider(providerCompleteness)
  );
}

function assertPreparedEvaluationInput(input) {
  if (!hasExactKeys(input, PREPARED_EVALUATION_INPUT_KEYS) ||
      typeof input.queryPointId !== "string" ||
      !COMPLETENESS_VALUES.has(input.providerCompleteness) ||
      !Number.isSafeInteger(input.observedAboveThresholdCount) ||
      input.observedAboveThresholdCount < 0) {
    fail("INVALID_DISCOVERY_CERTIFICATE_INPUT", "validation");
  }
}

function evaluatePreparedThresholdDiscoveryCertificate(input, context) {
  assertPreparedEvaluationInput(input);
  context.counters.certificateEvaluationCount += 1;
  context.counters.certificateQueryLookupCount += 1;
  const queryIdentity = context.byPointId.get(input.queryPointId);
  if (!queryIdentity) {
    return invalid(
      CERTIFICATE_REASON_CODES.CERTIFICATE_QUERY_NOT_CURRENT,
      input.providerCompleteness
    );
  }
  const eligibleIdentityCount = Math.max(0, context.identityCount - 1);
  if (input.observedAboveThresholdCount > eligibleIdentityCount) {
    return invalid(
      CERTIFICATE_REASON_CODES.CERTIFICATE_COUNTERS_INVALID,
      input.providerCompleteness
    );
  }
  if (input.certificate === null) {
    return evaluation(
      CERTIFICATE_STATUSES.ABSENT,
      CERTIFICATE_REASON_CODES.CERTIFICATE_ABSENT,
      incompleteFromProvider(input.providerCompleteness)
    );
  }
  if (!hasExactKeys(input.certificate, CERTIFICATE_KEYS)) {
    return invalid(
      CERTIFICATE_REASON_CODES.MALFORMED_DISCOVERY_CERTIFICATE,
      input.providerCompleteness
    );
  }
  const certificate = input.certificate;
  if (certificate.certificateVersion !== THRESHOLD_DISCOVERY_CERTIFICATE_VERSION) {
    return invalid(
      CERTIFICATE_REASON_CODES.UNKNOWN_CERTIFICATE_VERSION,
      input.providerCompleteness
    );
  }
  if (certificate.mode !== THRESHOLD_DISCOVERY_MODE) {
    return invalid(CERTIFICATE_REASON_CODES.UNKNOWN_CERTIFICATE_MODE, input.providerCompleteness);
  }
  if (certificate.identityIndexFingerprint !== context.identitySnapshotFingerprint) {
    return invalid(
      CERTIFICATE_REASON_CODES.CERTIFICATE_SNAPSHOT_MISMATCH,
      input.providerCompleteness
    );
  }
  if (certificate.queryPointId !== input.queryPointId) {
    return invalid(
      CERTIFICATE_REASON_CODES.CERTIFICATE_QUERY_MISMATCH,
      input.providerCompleteness
    );
  }
  if (certificate.embeddingModel !== queryIdentity.model ||
      certificate.embeddingRevision !== queryIdentity.revision) {
    return invalid(
      CERTIFICATE_REASON_CODES.CERTIFICATE_PROVENANCE_MISMATCH,
      input.providerCompleteness
    );
  }
  if (certificate.clusterThreshold !== context.clusterThreshold) {
    return invalid(
      CERTIFICATE_REASON_CODES.CERTIFICATE_THRESHOLD_MISMATCH,
      input.providerCompleteness
    );
  }
  if (!Number.isSafeInteger(certificate.eligibleIdentityCount) ||
      !Number.isSafeInteger(certificate.enumeratedAboveThresholdCount) ||
      certificate.eligibleIdentityCount < 0 ||
      certificate.enumeratedAboveThresholdCount < 0 ||
      certificate.eligibleIdentityCount !== eligibleIdentityCount ||
      certificate.enumeratedAboveThresholdCount > certificate.eligibleIdentityCount) {
    return invalid(
      CERTIFICATE_REASON_CODES.CERTIFICATE_COUNTERS_INVALID,
      input.providerCompleteness
    );
  }
  if (certificate.enumeratedAboveThresholdCount !== input.observedAboveThresholdCount) {
    return invalid(
      CERTIFICATE_REASON_CODES.CERTIFICATE_ENUMERATION_COUNT_MISMATCH,
      input.providerCompleteness
    );
  }
  if (certificate.exhausted !== true) {
    return invalid(
      CERTIFICATE_REASON_CODES.CERTIFICATE_NOT_EXHAUSTED,
      input.providerCompleteness
    );
  }
  if (certificate.truncated !== false) {
    return invalid(CERTIFICATE_REASON_CODES.CERTIFICATE_TRUNCATED, input.providerCompleteness);
  }
  if (certificate.continuation !== null) {
    return invalid(
      CERTIFICATE_REASON_CODES.CERTIFICATE_CONTINUATION_PRESENT,
      input.providerCompleteness
    );
  }
  if (input.providerCompleteness !== DISCOVERY_COMPLETENESS.COMPLETE_ABOVE_THRESHOLD) {
    return invalid(
      CERTIFICATE_REASON_CODES.PROVIDER_DISCOVERY_NOT_CERTIFIABLE,
      input.providerCompleteness
    );
  }
  return evaluation(
    CERTIFICATE_STATUSES.VALID,
    null,
    DISCOVERY_COMPLETENESS.COMPLETE_ABOVE_THRESHOLD,
    fingerprint({
      domain: "hippocampus-threshold-discovery-certificate-fingerprint-v1",
      certificate
    })
  );
}

function prepareThresholdDiscoveryContext(identitySnapshot) {
  const snapshotValidation = validateGlobalIdentitySnapshot(identitySnapshot);
  if (!snapshotValidation.valid) fail(snapshotValidation.errors[0], "snapshot");
  const identities = identitySnapshot.identities.map((identity) => deepFreeze({ ...identity }));
  const byPointId = new Map(identities.map((identity) => [identity.pointId, identity]));
  const byMemoryId = new Map(identities.map((identity) => [identity.memoryId, identity]));
  const counters = {
    preparationCount: 1,
    snapshotValidationCount: 1,
    globalOrderingCount: 1,
    globalFingerprintCalculationCount: 1,
    certificateEvaluationCount: 0,
    certificateQueryLookupCount: 0,
    pointLookupCount: 0,
    memoryLookupCount: 0
  };
  const context = {
    identityCount: identitySnapshot.identityCount,
    identitySnapshotFingerprint: identitySnapshot.snapshotFingerprint,
    clusterThreshold: DEFAULT_BOUNDED_CLUSTERING_POLICY.clusterThreshold,
    byPointId,
    byMemoryId,
    counters
  };
  return deepFreeze({
    identityCount: context.identityCount,
    identitySnapshotFingerprint: context.identitySnapshotFingerprint,
    findIdentityByPointId(pointId) {
      counters.pointLookupCount += 1;
      return byPointId.get(pointId) || null;
    },
    hasMemoryId(memoryId) {
      counters.memoryLookupCount += 1;
      return byMemoryId.has(memoryId);
    },
    evaluate(input) {
      return evaluatePreparedThresholdDiscoveryCertificate(input, context);
    },
    diagnostics() {
      return deepFreeze({ ...counters });
    }
  });
}

function evaluateThresholdDiscoveryCertificate(input) {
  if (!hasExactKeys(input, EVALUATION_INPUT_KEYS)) {
    fail("INVALID_DISCOVERY_CERTIFICATE_INPUT", "validation");
  }
  const context = prepareThresholdDiscoveryContext(input.identitySnapshot);
  return context.evaluate({
    queryPointId: input.queryPointId,
    providerCompleteness: input.providerCompleteness,
    certificate: input.certificate,
    observedAboveThresholdCount: input.observedAboveThresholdCount
  });
}

function createUnqueriedDiscoveryEvaluation() {
  return evaluation(
    CERTIFICATE_STATUSES.ABSENT,
    CERTIFICATE_REASON_CODES.QUERY_NOT_COMPLETED,
    DISCOVERY_COMPLETENESS.INCOMPLETE_UNCERTIFIED
  );
}

module.exports = {
  THRESHOLD_DISCOVERY_CERTIFICATE_VERSION,
  THRESHOLD_DISCOVERY_MODE,
  CERTIFICATE_STATUSES,
  CERTIFICATE_REASON_CODES,
  COMPONENT_CLOSURE_STATUSES,
  HippocampusDiscoveryCompletenessError,
  prepareThresholdDiscoveryContext,
  evaluateThresholdDiscoveryCertificate,
  createUnqueriedDiscoveryEvaluation
};
