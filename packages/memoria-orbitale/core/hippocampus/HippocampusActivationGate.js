"use strict";

const HIPPOCAMPUS_ACTIVATION_MODES = deepFreeze({
  OFF: "OFF",
  SHADOW: "SHADOW",
  LIVE: "LIVE"
});
const HIPPOCAMPUS_ACTIVATION_REASON_CODES = deepFreeze({
  ACTIVATION_OFF: "ACTIVATION_OFF",
  SHADOW_AUTHORIZED: "SHADOW_AUTHORIZED",
  LIVE_CONFIRMATION_REQUIRED: "LIVE_CONFIRMATION_REQUIRED",
  LIVE_COMMIT_CAPABILITY_REQUIRED: "LIVE_COMMIT_CAPABILITY_REQUIRED",
  LIVE_STORAGE_CAPABILITY_REQUIRED: "LIVE_STORAGE_CAPABILITY_REQUIRED",
  LIVE_AUTHORIZED: "LIVE_AUTHORIZED",
  INVALID_ACTIVATION_MODE: "INVALID_ACTIVATION_MODE",
  INVALID_ACTIVATION_CONFIGURATION: "INVALID_ACTIVATION_CONFIGURATION"
});
const LIVE_CONFIRMATION_TOKEN = "ENABLE_HIPPOCAMPUS_LIVE_V1";
const COMMIT_CAPABILITY_ID = "hippocampus-authoritative-commit-v1";
const STORAGE_ATTESTATION_CONTRACT_VERSION =
  "hippocampus-live-storage-capability-attestation-v1";
const REQUIRED_LIVE_STORAGE_CAPABILITIES = Object.freeze([
  "commit.atomic",
  "lock.acquire",
  "lock.release",
  "memory.readAll",
  "memory.writeAll"
]);
const OPTION_KEYS = Object.freeze([
  "commitCapability", "liveConfirmation", "mode", "storageCapability"
]);
const COMMIT_CAPABILITY_KEYS = Object.freeze([
  "capabilityId", "commit", "schemaVersion"
]);
const STORAGE_CAPABILITY_KEYS = Object.freeze([
  "capabilities", "contractVersion", "schemaVersion"
]);
const STORAGE_ENTRY_KEYS = Object.freeze([
  "capability", "status", "verified"
]);

class HippocampusActivationGateError extends Error {
  constructor(code) {
    super("Hippocampus activation gate configuration failed");
    this.name = "HippocampusActivationGateError";
    this.code = code;
    this.phase = "activation_gate";
    this.retryable = false;
  }
}

function fail(code) {
  throw new HippocampusActivationGateError(code);
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

function hasOnlyKeys(value, allowed) {
  return isPlainDataObject(value) &&
    Object.keys(value).every((key) => allowed.includes(key));
}

function hasExactKeys(value, expected) {
  if (!isPlainDataObject(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index]);
}

function validateCommitCapability(value) {
  return hasExactKeys(value, COMMIT_CAPABILITY_KEYS) &&
    value.schemaVersion === 1 &&
    value.capabilityId === COMMIT_CAPABILITY_ID &&
    typeof value.commit === "function";
}

function validateStorageCapabilityConfiguration(value) {
  if (!hasExactKeys(value, STORAGE_CAPABILITY_KEYS) ||
      value.schemaVersion !== 1 ||
      value.contractVersion !== STORAGE_ATTESTATION_CONTRACT_VERSION ||
      !Array.isArray(value.capabilities)) {
    return false;
  }
  const capabilities = [];
  for (const entry of value.capabilities) {
    if (!hasExactKeys(entry, STORAGE_ENTRY_KEYS) ||
        typeof entry.capability !== "string" ||
        !["supported", "partial", "unsupported", "unknown"].includes(entry.status) ||
        typeof entry.verified !== "boolean") {
      return false;
    }
    capabilities.push(entry.capability);
  }
  return new Set(capabilities).size === capabilities.length &&
    capabilities.every((capability, index) =>
      index === 0 || capabilities[index - 1] < capability);
}

function validateStorageCapability(value) {
  if (!validateStorageCapabilityConfiguration(value) ||
      value.capabilities.length !== REQUIRED_LIVE_STORAGE_CAPABILITIES.length) {
    return false;
  }
  return value.capabilities.every((entry, index) =>
    entry.capability === REQUIRED_LIVE_STORAGE_CAPABILITIES[index] &&
    entry.status === "supported" &&
    entry.verified === true);
}

function decision(mode, reasonCode, authorized = {}) {
  return deepFreeze({
    mode,
    activationAuthorized: authorized.activation === true,
    shadowAuthorized: authorized.shadow === true,
    liveAuthorized: authorized.live === true,
    commitAuthorized: authorized.commit === true,
    reasonCode
  });
}

function createHippocampusActivationGate(options = {}) {
  if (!hasOnlyKeys(options, OPTION_KEYS)) {
    fail(HIPPOCAMPUS_ACTIVATION_REASON_CODES.INVALID_ACTIVATION_CONFIGURATION);
  }
  const mode = options.mode === undefined
    ? HIPPOCAMPUS_ACTIVATION_MODES.OFF
    : options.mode;
  if (!Object.values(HIPPOCAMPUS_ACTIVATION_MODES).includes(mode)) {
    fail(HIPPOCAMPUS_ACTIVATION_REASON_CODES.INVALID_ACTIVATION_MODE);
  }
  if (options.commitCapability !== undefined &&
      options.commitCapability !== null &&
      !validateCommitCapability(options.commitCapability)) {
    fail(HIPPOCAMPUS_ACTIVATION_REASON_CODES.INVALID_ACTIVATION_CONFIGURATION);
  }
  if (options.storageCapability !== undefined &&
      options.storageCapability !== null &&
      !validateStorageCapabilityConfiguration(options.storageCapability)) {
    fail(HIPPOCAMPUS_ACTIVATION_REASON_CODES.INVALID_ACTIVATION_CONFIGURATION);
  }

  if (mode === HIPPOCAMPUS_ACTIVATION_MODES.OFF) {
    return decision(mode, HIPPOCAMPUS_ACTIVATION_REASON_CODES.ACTIVATION_OFF);
  }
  if (mode === HIPPOCAMPUS_ACTIVATION_MODES.SHADOW) {
    return decision(
      mode,
      HIPPOCAMPUS_ACTIVATION_REASON_CODES.SHADOW_AUTHORIZED,
      { activation: true, shadow: true }
    );
  }
  if (options.liveConfirmation !== LIVE_CONFIRMATION_TOKEN) {
    return decision(
      mode,
      HIPPOCAMPUS_ACTIVATION_REASON_CODES.LIVE_CONFIRMATION_REQUIRED
    );
  }
  if (!validateCommitCapability(options.commitCapability)) {
    return decision(
      mode,
      HIPPOCAMPUS_ACTIVATION_REASON_CODES.LIVE_COMMIT_CAPABILITY_REQUIRED
    );
  }
  if (!validateStorageCapability(options.storageCapability)) {
    return decision(
      mode,
      HIPPOCAMPUS_ACTIVATION_REASON_CODES.LIVE_STORAGE_CAPABILITY_REQUIRED
    );
  }
  return decision(
    mode,
    HIPPOCAMPUS_ACTIVATION_REASON_CODES.LIVE_AUTHORIZED,
    { activation: true, live: true, commit: true }
  );
}

module.exports = {
  HIPPOCAMPUS_ACTIVATION_MODES,
  HIPPOCAMPUS_ACTIVATION_REASON_CODES,
  LIVE_CONFIRMATION_TOKEN,
  COMMIT_CAPABILITY_ID,
  STORAGE_ATTESTATION_CONTRACT_VERSION,
  REQUIRED_LIVE_STORAGE_CAPABILITIES,
  HippocampusActivationGateError,
  createHippocampusActivationGate
};
