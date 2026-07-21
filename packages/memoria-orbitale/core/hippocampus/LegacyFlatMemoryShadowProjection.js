"use strict";

const { createHash } = require("node:crypto");
const { PROCESSING_STATES } = require("../consolidation/ProcessingState");

const LEGACY_FLAT_SHADOW_PROJECTION_VERSION =
  "hippocampus-legacy-flat-shadow-projection-v1";
const EXCLUSION_COUNT_KEYS = Object.freeze([
  "duplicateIdentityCount",
  "emptyContentCount",
  "keyIdentityMismatchCount",
  "missingIdentityCount",
  "structuralIncompatibilityCount",
  "userScopeMismatchCount"
]);

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
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

function contentText(record) {
  if (typeof record.content === "string") return record.content;
  if (isPlainObject(record.content) && typeof record.content.text === "string") {
    return record.content.text;
  }
  return null;
}

function contentHash(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function assertOptions(options) {
  if (!isPlainObject(options) ||
      Object.keys(options).some((key) => ![
        "maxCandidates", "onlyMemoryIds", "requestedUserId", "sourceUserId"
      ].includes(key)) ||
      typeof options.requestedUserId !== "string" ||
      options.requestedUserId.length === 0 ||
      typeof options.sourceUserId !== "string" ||
      options.sourceUserId.length === 0 ||
      !Number.isSafeInteger(options.maxCandidates) ||
      options.maxCandidates <= 0 ||
      options.onlyMemoryIds !== undefined &&
        (!Array.isArray(options.onlyMemoryIds) ||
          options.onlyMemoryIds.some((id) =>
            typeof id !== "string" || id.length === 0) ||
          new Set(options.onlyMemoryIds).size !== options.onlyMemoryIds.length)) {
    throw new TypeError("Invalid legacy SHADOW projection options");
  }
}

function sourceEntries(memories) {
  if (Array.isArray(memories)) {
    return memories.map((record, index) => ({ mapKey: null, index, record }));
  }
  if (!isPlainObject(memories)) {
    throw new TypeError("Legacy memories must be an array or plain object map");
  }
  return Object.keys(memories).map((mapKey, index) => ({
    mapKey,
    index,
    record: memories[mapKey]
  }));
}

function projectRecord(record, text) {
  const projected = {
    id: record.id,
    content: { text },
    contentHash: contentHash(text),
    timestamp: Object.hasOwn(record, "timestamp") ? record.timestamp : null,
    lastAccess: Object.hasOwn(record, "lastAccess") ? record.lastAccess : null,
    type: typeof record.type === "string" ? record.type : "unknown",
    memoryKind: "raw",
    storageTier: "warm",
    processingState: PROCESSING_STATES.RAW,
    shadowProjection: {
      version: LEGACY_FLAT_SHADOW_PROJECTION_VERSION,
      mode: "SHADOW",
      processingStateAuthority: "runtime_projection_only",
      processingStatePersisted: false,
      authoritativeIdentityField: "id"
    }
  };
  return deepFreeze(projected);
}

function projectLegacyFlatMemoriesForShadow(memories, options) {
  assertOptions(options);
  const entries = sourceEntries(memories);
  const identityCounts = new Map();
  for (const entry of entries) {
    const id = isPlainObject(entry.record) &&
      typeof entry.record.id === "string" && entry.record.id.length > 0
      ? entry.record.id
      : null;
    if (id !== null) identityCounts.set(id, (identityCounts.get(id) || 0) + 1);
  }

  const exclusionCounts = Object.fromEntries(
    EXCLUSION_COUNT_KEYS.map((key) => [key, 0])
  );
  const eligibleIds = [];
  const requestedIds = options.onlyMemoryIds === undefined
    ? null
    : new Set(options.onlyMemoryIds);
  for (const entry of entries) {
    const record = entry.record;
    if (!isPlainObject(record) ||
        Object.hasOwn(record, "processingState") ||
        Object.hasOwn(record, "processing") ||
        Object.hasOwn(record, "memoryKind") ||
        Object.hasOwn(record, "storageTier")) {
      exclusionCounts.structuralIncompatibilityCount += 1;
      continue;
    }
    if (typeof record.id !== "string" || record.id.length === 0) {
      exclusionCounts.missingIdentityCount += 1;
      continue;
    }
    if (entry.mapKey !== null && entry.mapKey !== record.id) {
      exclusionCounts.keyIdentityMismatchCount += 1;
      continue;
    }
    if (identityCounts.get(record.id) !== 1) {
      exclusionCounts.duplicateIdentityCount += 1;
      continue;
    }
    const text = contentText(record);
    if (text === null || text.length === 0) {
      exclusionCounts.emptyContentCount += 1;
      continue;
    }
    if (options.sourceUserId !== options.requestedUserId) {
      exclusionCounts.userScopeMismatchCount += 1;
      continue;
    }
    if (requestedIds === null || requestedIds.has(record.id)) {
      eligibleIds.push(record.id);
    }
  }

  eligibleIds.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  const selectedIds = eligibleIds.slice(0, options.maxCandidates);
  const selectedIdSet = new Set(selectedIds);
  const selectedById = new Map();
  for (const entry of entries) {
    if (!isPlainObject(entry.record) ||
        !selectedIdSet.has(entry.record.id)) continue;
    selectedById.set(entry.record.id, projectRecord(
      entry.record, contentText(entry.record)
    ));
  }
  return deepFreeze({
    projectionVersion: LEGACY_FLAT_SHADOW_PROJECTION_VERSION,
    records: selectedIds.map((id) => selectedById.get(id)),
    stats: {
      inputCount: entries.length,
      eligibleCount: eligibleIds.length,
      selectedCount: selectedIds.length,
      exclusionCounts
    }
  });
}

module.exports = Object.freeze({
  EXCLUSION_COUNT_KEYS,
  LEGACY_FLAT_SHADOW_PROJECTION_VERSION,
  projectLegacyFlatMemoriesForShadow
});
