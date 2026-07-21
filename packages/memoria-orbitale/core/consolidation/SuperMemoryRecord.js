"use strict";

const { createHash } = require("node:crypto");
const { validateClusterRecord } = require("../clustering/ClusterRecord");
const { validateSynthesisResult } = require("../synthesis/SynthesisContract");
const { validateProcessingState } = require("./ProcessingState");

const SUPER_MEMORY_SCHEMA_VERSION = 1;
const HEX_64 = /^[a-f0-9]{64}$/;
const RECORD_KEYS = Object.freeze([
  "schemaVersion", "id", "userId", "type", "content", "memoryKind",
  "storageTier", "processing", "source_memory_ids", "rejected_source_ids",
  "cluster_id", "synthesis", "provenance", "idempotency_key",
  "record_fingerprint", "timestamp"
]);

class SuperMemoryRecordError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SuperMemoryRecordError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new SuperMemoryRecordError(code, message);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (isPlainObject(value)) return Object.fromEntries(Object.keys(value).map((key) => [key, clone(value[key])]));
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
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function sha256(value) {
  return createHash("sha256").update(stableStringify(value), "utf8").digest("hex");
}

function assertExactKeys(value, expected, label) {
  if (!isPlainObject(value)) fail("INVALID_PLAIN_OBJECT", `${label} must be a plain object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail("INVALID_PROPERTIES", `${label} has missing or unknown properties`);
  }
}

function assertString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) fail("INVALID_STRING", `${label} must be non-empty`);
}

function assertTimestamp(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail("INVALID_TIMESTAMP", "timestamp must be epoch milliseconds >= 0");
}

function identityPayload(input) {
  return {
    schemaVersion: SUPER_MEMORY_SCHEMA_VERSION,
    userId: input.userId,
    clusterRecordFingerprint: input.clusterRecordFingerprint,
    synthesisRequestId: input.synthesisRequestId,
    sourceMemoryIds: input.sourceMemoryIds,
    rejectedSourceIds: input.rejectedSourceIds,
    provider: input.provider,
    promptVersion: input.promptVersion,
    outputFingerprint: input.outputFingerprint
  };
}

function computeSuperMemoryIdempotencyKey(input) {
  if (!isPlainObject(input)) fail("INVALID_IDEMPOTENCY_INPUT", "Idempotency input must be plain");
  const normalized = {
    userId: input.userId,
    clusterRecordFingerprint: input.clusterRecordFingerprint ?? input.cluster_record_fingerprint,
    synthesisRequestId: input.synthesisRequestId ?? input.synthesis_request_id,
    sourceMemoryIds: input.sourceMemoryIds ?? input.source_memory_ids,
    rejectedSourceIds: input.rejectedSourceIds ?? input.rejected_source_ids,
    provider: input.provider,
    promptVersion: input.promptVersion ?? input.prompt_version,
    outputFingerprint: input.outputFingerprint ?? input.output_fingerprint
  };
  assertString(normalized.userId, "userId");
  for (const value of [normalized.clusterRecordFingerprint, normalized.synthesisRequestId, normalized.outputFingerprint]) {
    if (!HEX_64.test(value || "")) fail("INVALID_IDEMPOTENCY_INPUT", "Idempotency fingerprints must be SHA-256");
  }
  if (!Array.isArray(normalized.sourceMemoryIds) || !Array.isArray(normalized.rejectedSourceIds)) {
    fail("INVALID_IDEMPOTENCY_INPUT", "Idempotency source lists are required");
  }
  assertExactKeys(normalized.provider, ["providerId", "model", "version"], "provider");
  for (const key of ["providerId", "model", "version"]) assertString(normalized.provider[key], `provider.${key}`);
  assertString(normalized.promptVersion, "promptVersion");
  return sha256(identityPayload(normalized));
}

function fingerprintPayload(record) {
  return {
    schemaVersion: record.schemaVersion,
    id: record.id,
    userId: record.userId,
    type: record.type,
    content: record.content,
    memoryKind: record.memoryKind,
    storageTier: record.storageTier,
    processing: {
      schema_version: record.processing.schema_version,
      state: record.processing.state,
      revision: record.processing.revision,
      attempt_id: record.processing.attempt_id,
      error: record.processing.error
    },
    source_memory_ids: record.source_memory_ids,
    rejected_source_ids: record.rejected_source_ids,
    cluster_id: record.cluster_id,
    synthesis: record.synthesis,
    provenance: record.provenance,
    idempotency_key: record.idempotency_key
  };
}

function computeSuperMemoryFingerprint(record) {
  if (!isPlainObject(record)) fail("INVALID_RECORD", "Super-memory record must be plain");
  return sha256(fingerprintPayload(record));
}

function validateRelationships(userId, clusterRecord, synthesisResult) {
  if (clusterRecord.user_id !== userId) fail("USER_MISMATCH", "Cluster user does not match super-memory user");
  if (synthesisResult.clusterId !== clusterRecord.id ||
      synthesisResult.clusterRecordFingerprint !== clusterRecord.record_fingerprint) {
    fail("CLUSTER_SYNTHESIS_MISMATCH", "Synthesis result does not match cluster record");
  }
  const covered = [...synthesisResult.output.source_memory_ids, ...synthesisResult.output.rejected_source_ids].sort();
  if (stableStringify(covered) !== stableStringify(clusterRecord.source_memory_ids)) {
    fail("SOURCE_COVERAGE_MISMATCH", "Synthesis source coverage does not match cluster record");
  }
}

function createSuperMemoryRecord(input) {
  assertExactKeys(input, ["userId", "clusterRecord", "synthesisResult", "committedAt", "processingAttemptId"], "input");
  assertString(input.userId, "userId");
  assertString(input.processingAttemptId, "processingAttemptId");
  assertTimestamp(input.committedAt);
  let clusterRecord;
  let synthesisResult;
  try { clusterRecord = validateClusterRecord(input.clusterRecord); } catch { fail("INVALID_CLUSTER_RECORD", "Cluster record is invalid"); }
  try { synthesisResult = validateSynthesisResult(input.synthesisResult); } catch { fail("INVALID_SYNTHESIS_RESULT", "Synthesis result is invalid"); }
  validateRelationships(input.userId, clusterRecord, synthesisResult);
  const output = synthesisResult.output;
  const identity = {
    userId: input.userId,
    clusterRecordFingerprint: clusterRecord.record_fingerprint,
    synthesisRequestId: synthesisResult.requestId,
    sourceMemoryIds: output.source_memory_ids,
    rejectedSourceIds: output.rejected_source_ids,
    provider: synthesisResult.provider,
    promptVersion: synthesisResult.promptVersion,
    outputFingerprint: sha256(output)
  };
  const idempotencyKey = computeSuperMemoryIdempotencyKey(identity);
  const record = {
    schemaVersion: SUPER_MEMORY_SCHEMA_VERSION,
    id: `sm_${idempotencyKey}`,
    userId: input.userId,
    type: "super_memory",
    content: {
      text: output.synthesis,
      title: output.title,
      facts: clone(output.facts),
      uncertainties: clone(output.uncertainties),
      contradictions: clone(output.contradictions)
    },
    memoryKind: "super_memory",
    storageTier: "core",
    processing: {
      schema_version: 1,
      state: "consolidated",
      revision: 0,
      attempt_id: input.processingAttemptId,
      updated_at: input.committedAt,
      error: null
    },
    source_memory_ids: [...output.source_memory_ids],
    rejected_source_ids: [...output.rejected_source_ids],
    cluster_id: clusterRecord.id,
    synthesis: {
      request_id: synthesisResult.requestId,
      provider_id: synthesisResult.provider.providerId,
      model: synthesisResult.provider.model,
      version: synthesisResult.provider.version,
      prompt_version: synthesisResult.promptVersion,
      confidence: output.confidence
    },
    provenance: {
      cluster_record_fingerprint: clusterRecord.record_fingerprint,
      source_content_hashes: clone(synthesisResult.sourceContentHashes)
    },
    idempotency_key: idempotencyKey,
    record_fingerprint: "",
    timestamp: input.committedAt
  };
  record.record_fingerprint = computeSuperMemoryFingerprint(record);
  return validateSuperMemoryRecord(record);
}

function validateSuperMemoryRecord(record) {
  assertExactKeys(record, RECORD_KEYS, "super-memory record");
  const copy = clone(record);
  if (copy.schemaVersion !== SUPER_MEMORY_SCHEMA_VERSION || copy.type !== "super_memory" ||
      copy.memoryKind !== "super_memory" || copy.storageTier !== "core") {
    fail("INVALID_SUPER_MEMORY_KIND", "Super-memory identity fields are invalid");
  }
  assertString(copy.userId, "userId");
  assertExactKeys(copy.content, ["text", "title", "facts", "uncertainties", "contradictions"], "content");
  assertString(copy.content.text, "content.text");
  assertString(copy.content.title, "content.title");
  if (![copy.content.facts, copy.content.uncertainties, copy.content.contradictions].every(Array.isArray)) {
    fail("INVALID_CONTENT", "Super-memory content arrays are invalid");
  }
  const processing = validateProcessingState(copy.processing);
  if (!processing.valid || copy.processing.state !== "consolidated" || copy.processing.revision !== 0) {
    fail("INVALID_PROCESSING", "Super-memory processing must be consolidated revision zero");
  }
  assertTimestamp(copy.timestamp);
  if (copy.processing.updated_at !== copy.timestamp) fail("INVALID_TIMESTAMP", "Processing timestamp must match record timestamp");
  for (const list of [copy.source_memory_ids, copy.rejected_source_ids]) {
    if (!Array.isArray(list) || new Set(list).size !== list.length || list.some((id) => typeof id !== "string" || id.length === 0)) {
      fail("INVALID_SOURCE_IDS", "Super-memory source IDs are invalid");
    }
  }
  if (copy.source_memory_ids.length === 0 || copy.rejected_source_ids.some((id) => copy.source_memory_ids.includes(id))) {
    fail("INVALID_SOURCE_IDS", "Used and rejected sources must be non-empty/disjoint as required");
  }
  assertString(copy.cluster_id, "cluster_id");
  assertExactKeys(copy.synthesis, ["request_id", "provider_id", "model", "version", "prompt_version", "confidence"], "synthesis");
  if (!HEX_64.test(copy.synthesis.request_id)) fail("INVALID_SYNTHESIS", "Synthesis request ID is invalid");
  for (const key of ["provider_id", "model", "version", "prompt_version"]) assertString(copy.synthesis[key], `synthesis.${key}`);
  if (typeof copy.synthesis.confidence !== "number" || !Number.isFinite(copy.synthesis.confidence) ||
      copy.synthesis.confidence < 0 || copy.synthesis.confidence > 1) fail("INVALID_SYNTHESIS", "Confidence is invalid");
  assertExactKeys(copy.provenance, ["cluster_record_fingerprint", "source_content_hashes"], "provenance");
  if (!HEX_64.test(copy.provenance.cluster_record_fingerprint) || !Array.isArray(copy.provenance.source_content_hashes)) {
    fail("INVALID_PROVENANCE", "Super-memory provenance is invalid");
  }
  const identity = {
    userId: copy.userId,
    clusterRecordFingerprint: copy.provenance.cluster_record_fingerprint,
    synthesisRequestId: copy.synthesis.request_id,
    sourceMemoryIds: copy.source_memory_ids,
    rejectedSourceIds: copy.rejected_source_ids,
    provider: { providerId: copy.synthesis.provider_id, model: copy.synthesis.model, version: copy.synthesis.version },
    promptVersion: copy.synthesis.prompt_version,
    outputFingerprint: sha256({
      schema_version: 1,
      title: copy.content.title,
      synthesis: copy.content.text,
      facts: copy.content.facts,
      uncertainties: copy.content.uncertainties,
      contradictions: copy.content.contradictions,
      source_memory_ids: copy.source_memory_ids,
      confidence: copy.synthesis.confidence,
      rejected_source_ids: copy.rejected_source_ids
    })
  };
  const expectedKey = computeSuperMemoryIdempotencyKey(identity);
  if (copy.idempotency_key !== expectedKey || copy.id !== `sm_${expectedKey}`) fail("INVALID_IDEMPOTENCY", "Super-memory identity is inconsistent");
  if (copy.record_fingerprint !== computeSuperMemoryFingerprint(copy)) fail("INVALID_FINGERPRINT", "Super-memory fingerprint is inconsistent");
  return deepFreeze(copy);
}

module.exports = {
  SUPER_MEMORY_SCHEMA_VERSION,
  SuperMemoryRecordError,
  createSuperMemoryRecord,
  validateSuperMemoryRecord,
  computeSuperMemoryIdempotencyKey,
  computeSuperMemoryFingerprint
};
