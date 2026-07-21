"use strict";

const HIPPOCAMPUS_ACTIVATION_PREFLIGHT_SCHEMA_VERSION = 1;
const HIPPOCAMPUS_ACTIVATION_PREFLIGHT_CONTRACT_VERSION =
  "hippocampus-activation-preflight-v1";
const EXPECTED_BGE_MODEL = "BAAI/bge-m3";
const EXPECTED_BGE_REVISION = "5617a9f61b028005a4858fdac845db406aefb181";
const EXPECTED_BGE_DIMENSION = 1024;
const EXPECTED_QWEN_MODEL = "qwen3.5:27b";
const INPUT_KEYS = Object.freeze([
  "bgeM3", "commit", "embeddingCache", "ollama", "qdrant", "qwen", "storage"
]);
const BOOLEAN_READY_KEYS = Object.freeze(["ready"]);
const BGE_KEYS = Object.freeze([
  "dimension", "model", "normalized", "ready", "revision"
]);
const OLLAMA_KEYS = Object.freeze(["reachable"]);
const QWEN_KEYS = Object.freeze([
  "doneReason", "jsonValid", "miniInferenceCompleted", "model", "modelListed"
]);
const STORAGE_KEYS = Object.freeze([
  "available", "capabilityAttestationValid"
]);
const COMMIT_KEYS = Object.freeze(["present"]);
const REPORT_KEYS = Object.freeze([
  "bgeM3", "commit", "contractVersion", "embeddingCache", "liveReady",
  "ollama", "qdrant", "qwen", "reasonCodes", "schemaVersion", "shadowReady",
  "storage"
]);

class HippocampusActivationPreflightError extends Error {
  constructor(code) {
    super("Hippocampus activation preflight validation failed");
    this.name = "HippocampusActivationPreflightError";
    this.code = code;
    this.phase = "activation_preflight";
    this.retryable = false;
  }
}

function fail(code = "INVALID_ACTIVATION_PREFLIGHT") {
  throw new HippocampusActivationPreflightError(code);
}

function deepFreeze(value) {
  Object.freeze(value);
  for (const child of Object.values(value)) {
    if (child && typeof child === "object" && !Object.isFrozen(child)) {
      deepFreeze(child);
    }
  }
  return value;
}

function isPlainDataObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.keys(value).every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, "value");
  });
}

function hasExactKeys(value, expected) {
  if (!isPlainDataObject(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index]);
}

function booleanFields(value, keys) {
  return keys.every((key) => typeof value[key] === "boolean");
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (isPlainDataObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) =>
      [key, clone(child)]));
  }
  return value;
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function assertInput(input) {
  if (!hasExactKeys(input, INPUT_KEYS) ||
      !hasExactKeys(input.qdrant, BOOLEAN_READY_KEYS) ||
      !hasExactKeys(input.embeddingCache, BOOLEAN_READY_KEYS) ||
      !hasExactKeys(input.bgeM3, BGE_KEYS) ||
      !hasExactKeys(input.ollama, OLLAMA_KEYS) ||
      !hasExactKeys(input.qwen, QWEN_KEYS) ||
      !hasExactKeys(input.storage, STORAGE_KEYS) ||
      !hasExactKeys(input.commit, COMMIT_KEYS) ||
      !booleanFields(input.qdrant, BOOLEAN_READY_KEYS) ||
      !booleanFields(input.embeddingCache, BOOLEAN_READY_KEYS) ||
      !booleanFields(input.bgeM3, ["ready", "normalized"]) ||
      !booleanFields(input.ollama, ["reachable"]) ||
      !booleanFields(input.qwen, [
        "modelListed", "miniInferenceCompleted", "jsonValid"
      ]) ||
      !booleanFields(input.storage, [
        "available", "capabilityAttestationValid"
      ]) ||
      !booleanFields(input.commit, ["present"]) ||
      typeof input.bgeM3.model !== "string" ||
      typeof input.bgeM3.revision !== "string" ||
      !Number.isSafeInteger(input.bgeM3.dimension) ||
      typeof input.qwen.model !== "string" ||
      ![null, "stop"].includes(input.qwen.doneReason)) {
    fail();
  }
}

function readiness(input) {
  const bgeReady = input.bgeM3.ready &&
    input.bgeM3.model === EXPECTED_BGE_MODEL &&
    input.bgeM3.revision === EXPECTED_BGE_REVISION &&
    input.bgeM3.dimension === EXPECTED_BGE_DIMENSION &&
    input.bgeM3.normalized === true;
  const qwenReady = input.ollama.reachable &&
    input.qwen.model === EXPECTED_QWEN_MODEL &&
    input.qwen.modelListed &&
    input.qwen.miniInferenceCompleted &&
    input.qwen.jsonValid &&
    input.qwen.doneReason === "stop";
  const storageReady = input.storage.available &&
    input.storage.capabilityAttestationValid;
  const shadowReady = input.qdrant.ready &&
    input.embeddingCache.ready &&
    bgeReady &&
    qwenReady &&
    storageReady;
  return {
    bgeReady,
    qwenReady,
    storageReady,
    shadowReady,
    liveReady: shadowReady && input.commit.present
  };
}

function reasonCodes(input, state) {
  const reasons = [];
  if (!input.qdrant.ready) reasons.push("QDRANT_NOT_READY");
  if (!input.embeddingCache.ready) reasons.push("EMBEDDING_CACHE_NOT_READY");
  if (!state.bgeReady) reasons.push("BGE_M3_NOT_READY");
  if (!input.ollama.reachable) reasons.push("OLLAMA_NOT_REACHABLE");
  if (!state.qwenReady) reasons.push("QWEN_MINI_INFERENCE_NOT_READY");
  if (!state.storageReady) reasons.push("AUTHORITATIVE_STORAGE_NOT_READY");
  if (!input.commit.present) reasons.push("COMMIT_CAPABILITY_NOT_PRESENT");
  return reasons;
}

function createHippocampusActivationPreflight(input) {
  assertInput(input);
  const state = readiness(input);
  return deepFreeze({
    schemaVersion: HIPPOCAMPUS_ACTIVATION_PREFLIGHT_SCHEMA_VERSION,
    contractVersion: HIPPOCAMPUS_ACTIVATION_PREFLIGHT_CONTRACT_VERSION,
    qdrant: clone(input.qdrant),
    embeddingCache: clone(input.embeddingCache),
    bgeM3: { ...clone(input.bgeM3), verifiedReady: state.bgeReady },
    ollama: clone(input.ollama),
    qwen: { ...clone(input.qwen), verifiedReady: state.qwenReady },
    storage: { ...clone(input.storage), verifiedReady: state.storageReady },
    commit: clone(input.commit),
    shadowReady: state.shadowReady,
    liveReady: state.liveReady,
    reasonCodes: reasonCodes(input, state)
  });
}

function reportToInput(report) {
  return {
    qdrant: clone(report.qdrant),
    embeddingCache: clone(report.embeddingCache),
    bgeM3: {
      ready: report.bgeM3.ready,
      model: report.bgeM3.model,
      revision: report.bgeM3.revision,
      dimension: report.bgeM3.dimension,
      normalized: report.bgeM3.normalized
    },
    ollama: clone(report.ollama),
    qwen: {
      model: report.qwen.model,
      modelListed: report.qwen.modelListed,
      miniInferenceCompleted: report.qwen.miniInferenceCompleted,
      jsonValid: report.qwen.jsonValid,
      doneReason: report.qwen.doneReason
    },
    storage: {
      available: report.storage.available,
      capabilityAttestationValid: report.storage.capabilityAttestationValid
    },
    commit: clone(report.commit)
  };
}

function validateHippocampusActivationPreflight(report) {
  try {
    if (!hasExactKeys(report, REPORT_KEYS)) fail();
    const recreated = createHippocampusActivationPreflight(reportToInput(report));
    return deepFreeze({
      valid: stableStringify(recreated) === stableStringify(report),
      errors: stableStringify(recreated) === stableStringify(report)
        ? []
        : ["ACTIVATION_PREFLIGHT_MISMATCH"]
    });
  } catch (error) {
    return deepFreeze({
      valid: false,
      errors: [
        error instanceof HippocampusActivationPreflightError
          ? error.code
          : "INVALID_ACTIVATION_PREFLIGHT"
      ]
    });
  }
}

module.exports = {
  HIPPOCAMPUS_ACTIVATION_PREFLIGHT_SCHEMA_VERSION,
  HIPPOCAMPUS_ACTIVATION_PREFLIGHT_CONTRACT_VERSION,
  EXPECTED_BGE_MODEL,
  EXPECTED_BGE_REVISION,
  EXPECTED_BGE_DIMENSION,
  EXPECTED_QWEN_MODEL,
  HippocampusActivationPreflightError,
  createHippocampusActivationPreflight,
  validateHippocampusActivationPreflight
};
