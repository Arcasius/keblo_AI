"use strict";

function deepFreeze(value) {
  Object.freeze(value);
  for (const child of Object.values(value)) {
    if (child && typeof child === "object" && !Object.isFrozen(child)) {
      deepFreeze(child);
    }
  }
  return value;
}

const CAPABILITY_STATUS = deepFreeze({
  SUPPORTED: "supported",
  PARTIAL: "partial",
  UNSUPPORTED: "unsupported",
  UNKNOWN: "unknown"
});

const STORAGE_CAPABILITIES = deepFreeze({
  MEMORY_READ_ALL: "memory.readAll",
  MEMORY_READ_ONE: "memory.readOne",
  MEMORY_WRITE_ONE: "memory.writeOne",
  MEMORY_WRITE_ALL: "memory.writeAll",
  MEMORY_DELETE_ONE: "memory.deleteOne",
  LINK_READ_ALL: "link.readAll",
  LINK_WRITE_ALL: "link.writeAll",
  LINK_WRITE_ONE: "link.writeOne",
  LINK_DELETE_ONE: "link.deleteOne",
  CLUSTER_READ_ALL: "cluster.readAll",
  CLUSTER_READ_ONE: "cluster.readOne",
  CLUSTER_WRITE_ONE: "cluster.writeOne",
  CLUSTER_DELETE_ONE: "cluster.deleteOne",
  SNAPSHOT_CREATE: "snapshot.create",
  SNAPSHOT_VERIFY: "snapshot.verify",
  SNAPSHOT_RESTORE: "snapshot.restore",
  COMMIT_ATOMIC: "commit.atomic",
  LOCK_ACQUIRE: "lock.acquire",
  LOCK_RELEASE: "lock.release",
  ROLLBACK: "rollback"
});

const CAPABILITY_METHODS = deepFreeze({
  [STORAGE_CAPABILITIES.MEMORY_READ_ALL]: ["loadMemories"],
  [STORAGE_CAPABILITIES.MEMORY_READ_ONE]: ["getMemory"],
  [STORAGE_CAPABILITIES.MEMORY_WRITE_ONE]: ["saveMemory"],
  [STORAGE_CAPABILITIES.MEMORY_WRITE_ALL]: ["saveMemories"],
  [STORAGE_CAPABILITIES.MEMORY_DELETE_ONE]: ["deleteMemory"],
  [STORAGE_CAPABILITIES.LINK_READ_ALL]: ["loadLinks"],
  [STORAGE_CAPABILITIES.LINK_WRITE_ALL]: ["saveLinks"],
  [STORAGE_CAPABILITIES.LINK_WRITE_ONE]: ["saveLink"],
  [STORAGE_CAPABILITIES.LINK_DELETE_ONE]: ["deleteLink"],
  [STORAGE_CAPABILITIES.CLUSTER_READ_ALL]: ["loadClusters"],
  [STORAGE_CAPABILITIES.CLUSTER_READ_ONE]: ["getCluster"],
  [STORAGE_CAPABILITIES.CLUSTER_WRITE_ONE]: ["saveCluster"],
  [STORAGE_CAPABILITIES.CLUSTER_DELETE_ONE]: ["deleteCluster"],
  [STORAGE_CAPABILITIES.SNAPSHOT_CREATE]: ["createSnapshot"],
  [STORAGE_CAPABILITIES.SNAPSHOT_VERIFY]: ["verifySnapshot"],
  [STORAGE_CAPABILITIES.SNAPSHOT_RESTORE]: ["restoreSnapshot"],
  [STORAGE_CAPABILITIES.COMMIT_ATOMIC]: [
    "saveMemory",
    "saveMemories",
    "deleteMemory",
    "saveLink",
    "saveLinks",
    "saveCluster",
    "deleteCluster"
  ],
  [STORAGE_CAPABILITIES.LOCK_ACQUIRE]: ["acquireLock"],
  [STORAGE_CAPABILITIES.LOCK_RELEASE]: ["releaseLock"],
  [STORAGE_CAPABILITIES.ROLLBACK]: ["rollback"]
});

const KNOWN_CAPABILITIES = Object.freeze(Object.values(STORAGE_CAPABILITIES));
const KNOWN_STATUSES = new Set(Object.values(CAPABILITY_STATUS));

function assertStorage(storage) {
  if (storage === null || typeof storage !== "object" || Array.isArray(storage)) {
    throw new TypeError("Storage must be a non-null object");
  }
}

function assertCapability(capability) {
  if (!KNOWN_CAPABILITIES.includes(capability)) {
    throw new TypeError(`Unknown storage capability: ${String(capability)}`);
  }
}

function findPropertyDescriptor(object, property) {
  let current = object;
  while (current !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(current, property);
    if (descriptor) return descriptor;
    current = Object.getPrototypeOf(current);
  }
  return null;
}

function inspectMethod(storage, methodName) {
  const descriptor = findPropertyDescriptor(storage, methodName);
  if (!descriptor) return { presence: "missing", callable: false };
  if (!Object.prototype.hasOwnProperty.call(descriptor, "value")) {
    return { presence: "not-callable", callable: false };
  }
  return {
    presence: typeof descriptor.value === "function" ? "callable" : "not-callable",
    callable: typeof descriptor.value === "function"
  };
}

function validateCapabilityDeclaration(declaration) {
  const errors = [];
  if (!declaration || typeof declaration !== "object" || Array.isArray(declaration)) {
    return { valid: false, errors: ["capabilities must be a plain declaration object"] };
  }
  if (declaration.schemaVersion !== 1) {
    errors.push("capabilities.schemaVersion must be 1");
  }
  if (
    !declaration.statuses ||
    typeof declaration.statuses !== "object" ||
    Array.isArray(declaration.statuses)
  ) {
    errors.push("capabilities.statuses must be an object");
    return { valid: false, errors };
  }

  for (const capability of Object.keys(declaration.statuses).sort()) {
    if (!KNOWN_CAPABILITIES.includes(capability)) {
      errors.push(`unknown capability declaration: ${capability}`);
      continue;
    }
    const entry = declaration.statuses[capability];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`${capability} declaration must be an object`);
      continue;
    }
    if (!KNOWN_STATUSES.has(entry.status)) {
      errors.push(`${capability} has invalid status`);
    }
    if (typeof entry.verified !== "boolean") {
      errors.push(`${capability}.verified must be boolean`);
    }
  }

  return { valid: errors.length === 0, errors };
}

function readDeclaration(storage) {
  const descriptor = Object.getOwnPropertyDescriptor(storage, "capabilities");
  if (!descriptor) {
    return { present: false, valid: false, errors: [], statuses: {} };
  }
  if (!Object.prototype.hasOwnProperty.call(descriptor, "value")) {
    return {
      present: true,
      valid: false,
      errors: ["capabilities must be a data property"],
      statuses: {}
    };
  }

  const validation = validateCapabilityDeclaration(descriptor.value);
  return {
    present: true,
    valid: validation.valid,
    errors: [...validation.errors],
    statuses: validation.valid ? descriptor.value.statuses : {}
  };
}

function overallStatus(structural, declared, verified) {
  if (structural === CAPABILITY_STATUS.UNSUPPORTED) {
    return CAPABILITY_STATUS.UNSUPPORTED;
  }
  if (declared === CAPABILITY_STATUS.UNSUPPORTED) {
    return CAPABILITY_STATUS.UNSUPPORTED;
  }
  if (declared === CAPABILITY_STATUS.PARTIAL) {
    return CAPABILITY_STATUS.PARTIAL;
  }
  if (
    structural === CAPABILITY_STATUS.SUPPORTED &&
    declared === CAPABILITY_STATUS.SUPPORTED &&
    verified
  ) {
    return CAPABILITY_STATUS.SUPPORTED;
  }
  if (declared === CAPABILITY_STATUS.SUPPORTED) {
    return CAPABILITY_STATUS.PARTIAL;
  }
  return CAPABILITY_STATUS.UNKNOWN;
}

function inspectStorageCapabilities(storage) {
  assertStorage(storage);
  const declaration = readDeclaration(storage);
  const capabilities = {};

  for (const capability of KNOWN_CAPABILITIES) {
    const requiredMethods = CAPABILITY_METHODS[capability];
    const methods = {};
    for (const methodName of requiredMethods) {
      methods[methodName] = inspectMethod(storage, methodName);
    }
    const structural = requiredMethods.every((method) => methods[method].callable)
      ? CAPABILITY_STATUS.SUPPORTED
      : CAPABILITY_STATUS.UNSUPPORTED;
    const declaredEntry = declaration.statuses[capability];
    const declared = declaredEntry
      ? declaredEntry.status
      : CAPABILITY_STATUS.UNKNOWN;
    const behaviorallyVerified = declaredEntry
      ? declaredEntry.verified
      : false;

    capabilities[capability] = {
      requiredMethods: [...requiredMethods],
      methods,
      structural,
      declared,
      behaviorallyVerified,
      status: overallStatus(structural, declared, behaviorallyVerified)
    };
  }

  return {
    schemaVersion: 1,
    declaration: {
      present: declaration.present,
      valid: declaration.valid,
      errors: [...declaration.errors]
    },
    capabilities
  };
}

function hasStorageCapability(storage, capability) {
  assertCapability(capability);
  return inspectStorageCapabilities(storage).capabilities[capability].status ===
    CAPABILITY_STATUS.SUPPORTED;
}

function getMissingStorageCapabilities(storage, requiredCapabilities) {
  const required = Array.isArray(requiredCapabilities)
    ? requiredCapabilities
    : [requiredCapabilities];
  if (required.length === 0) {
    throw new TypeError("At least one storage capability is required");
  }
  for (const capability of required) assertCapability(capability);

  const report = inspectStorageCapabilities(storage);
  return required
    .filter((capability) =>
      report.capabilities[capability].status !== CAPABILITY_STATUS.SUPPORTED
    )
    .map((capability) => ({
      capability,
      status: report.capabilities[capability].status
    }));
}

class StorageCapabilityError extends Error {
  constructor(missingCapabilities) {
    const detail = missingCapabilities
      .map(({ capability, status }) => `${capability} (${status})`)
      .join(", ");
    super(`Storage capabilities required but unavailable: ${detail}`);
    this.name = "StorageCapabilityError";
    this.missingCapabilities = missingCapabilities.map((entry) => ({ ...entry }));
  }
}

function assertStorageCapabilities(storage, requiredCapabilities) {
  const missing = getMissingStorageCapabilities(storage, requiredCapabilities);
  if (missing.length > 0) throw new StorageCapabilityError(missing);
  return inspectStorageCapabilities(storage);
}

module.exports = {
  STORAGE_CAPABILITIES,
  CAPABILITY_STATUS,
  StorageCapabilityError,
  inspectStorageCapabilities,
  hasStorageCapability,
  assertStorageCapabilities,
  getMissingStorageCapabilities,
  validateCapabilityDeclaration
};
