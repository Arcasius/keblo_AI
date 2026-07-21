"use strict";

const { createHash } = require("node:crypto");
const {
  createProcessingState,
  validateProcessingState
} = require("../consolidation/ProcessingState");
const {
  createSourceClaimPlan
} = require("./SourceClaimTransaction");
const {
  projectLegacyFlatMemoriesForShadow
} = require("./LegacyFlatMemoryShadowProjection");
const { normalizeMemory } = require("../MemoryContractNormalizer");
const {
  validateSuperMemoryRecord
} = require("../consolidation/SuperMemoryRecord");

const LEGACY_PROCESSING_BOUNDARY_VERSION =
  "authoritative-legacy-processing-boundary-v1";
const LEGACY_PROCESSING_POLICY_VERSION =
  "legacy-absence-initial-raw-v1";
const AUTHORIZED_USER_ID = "francesco";
const HEX_64 = /^[a-f0-9]{64}$/;

class AuthoritativeLegacyProcessingBoundaryError extends Error {
  constructor(code) {
    super("Authoritative legacy processing boundary failed");
    this.name = "AuthoritativeLegacyProcessingBoundaryError";
    this.code = code;
    this.phase = "authoritative_legacy_processing_boundary";
    this.retryable = false;
  }
}

function fail(code) {
  throw new AuthoritativeLegacyProcessingBoundaryError(code);
}

function plain(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (plain(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) =>
      [key, clone(child)]));
  }
  return value;
}

function stable(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
}

function hashText(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function recordUserId(record) {
  return record?.meta?.user_id ?? record?.user_id ?? record?.userId ?? null;
}

function exact(value, keys) {
  return plain(value) && Object.keys(value).sort().join(",") ===
    [...keys].sort().join(",");
}

function assertOptions(options) {
  if (!exact(options, [
    "authoritativeStorage", "claimedAt", "loadAuthoritativeMap",
    "processingAttemptId", "userId"
  ]) || options.userId !== AUTHORIZED_USER_ID ||
      !options.authoritativeStorage ||
      typeof options.authoritativeStorage.loadMemories !== "function" ||
      typeof options.authoritativeStorage.saveMemories !== "function" ||
      typeof options.loadAuthoritativeMap !== "function" ||
      typeof options.processingAttemptId !== "string" ||
      options.processingAttemptId.length === 0 ||
      !Number.isSafeInteger(options.claimedAt) || options.claimedAt < 0) {
    fail("INVALID_LEGACY_PROCESSING_BOUNDARY_CONFIGURATION");
  }
}

function sourceIdentityMap(value) {
  if (!Array.isArray(value) || value.length === 0) {
    fail("INVALID_LEGACY_PROCESSING_SOURCE_SCOPE");
  }
  const sorted = value.map((item) => {
    if (!exact(item, ["contentHash", "memoryId"]) ||
        typeof item.memoryId !== "string" || item.memoryId.length === 0 ||
        !HEX_64.test(item.contentHash || "")) {
      fail("INVALID_LEGACY_PROCESSING_SOURCE_SCOPE");
    }
    return { ...item };
  }).sort((left, right) => left.memoryId.localeCompare(right.memoryId));
  if (new Set(sorted.map((item) => item.memoryId)).size !== sorted.length) {
    fail("INVALID_LEGACY_PROCESSING_SOURCE_SCOPE");
  }
  return new Map(sorted.map((item) => [item.memoryId, item.contentHash]));
}

function createAuthoritativeLegacyProcessingBoundary(options) {
  assertOptions(options);
  let authorization = null;
  const derivedIds = new Set();

  async function authoritativeMap() {
    const value = await options.loadAuthoritativeMap(options.userId);
    if (!plain(value)) fail("AUTHORITATIVE_LEGACY_MAP_INVALID");
    return value;
  }

  async function authorizeSources({ sourceIdentities }) {
    if (authorization !== null) fail("LEGACY_PROCESSING_SCOPE_ALREADY_AUTHORIZED");
    const identities = sourceIdentityMap(sourceIdentities);
    const map = await authoritativeMap();
    const projection = projectLegacyFlatMemoriesForShadow(map, {
      requestedUserId: options.userId,
      sourceUserId: options.userId,
      maxCandidates: identities.size,
      onlyMemoryIds: [...identities.keys()]
    });
    if (projection.records.length !== identities.size) {
      fail("AUTHORITATIVE_LEGACY_RECORD_INCOMPATIBLE");
    }
    const rawProcessing = createProcessingState({
      state: "raw", revision: 0, attempt_id: null, updated_at: 0, error: null
    });
    const adaptedSources = projection.records.map((record) => {
      const authoritative = map[record.id];
      const scopedUser = recordUserId(authoritative);
      if (scopedUser !== null && scopedUser !== options.userId) {
        fail("AUTHORITATIVE_LEGACY_USER_SCOPE_MISMATCH");
      }
      if (record.contentHash !== identities.get(record.id) ||
          hashText(record.content.text) !== identities.get(record.id)) {
        fail("STALE_SOURCE_REJECTED");
      }
      derivedIds.add(record.id);
      return { ...clone(authoritative), processing: clone(rawProcessing) };
    });
    const claimPlan = createSourceClaimPlan({
      userId: options.userId,
      sourceMemories: adaptedSources,
      sourceIds: [...identities.keys()],
      attemptId: options.processingAttemptId,
      claimedAt: options.claimedAt,
      sourceContentHashes: Object.fromEntries(identities)
    });
    authorization = Object.freeze({ identities, claimPlan });
    return Object.freeze({
      boundaryVersion: LEGACY_PROCESSING_BOUNDARY_VERSION,
      policyVersion: LEGACY_PROCESSING_POLICY_VERSION,
      sourceCount: identities.size,
      processingOrigin: "legacy_absence_derived",
      claimPlan
    });
  }

  async function loadMemories(userId, loadOptions) {
    if (userId !== options.userId || authorization === null) {
      fail("LEGACY_PROCESSING_SCOPE_NOT_AUTHORIZED");
    }
    const [memories, map] = await Promise.all([
      options.authoritativeStorage.loadMemories(userId, loadOptions),
      authoritativeMap()
    ]);
    if (!Array.isArray(memories)) fail("AUTHORITATIVE_LEGACY_MAP_INVALID");
    const byId = new Map(memories.map((memory) => [memory?.id, memory]));
    const claimedById = new Map(authorization.claimPlan.sources.map((source) =>
      [source.memoryId, source.claimedProcessing]));
    for (const [memoryId, contentHash] of authorization.identities) {
      const record = byId.get(memoryId);
      if (!record || !Object.hasOwn(map, memoryId) || map[memoryId]?.id !== memoryId) {
        fail("AUTHORITATIVE_LEGACY_IDENTITY_MISMATCH");
      }
      const scopedUser = recordUserId(record);
      if (scopedUser !== null && scopedUser !== userId) {
        fail("AUTHORITATIVE_LEGACY_USER_SCOPE_MISMATCH");
      }
      delete record.processing_provenance;
      let text;
      try { text = normalizeMemory(record).content.text; } catch { text = null; }
      if (typeof text !== "string" || hashText(text) !== contentHash) {
        fail("STALE_SOURCE_REJECTED");
      }
      if (Object.hasOwn(record, "processing")) {
        if (!validateProcessingState(record.processing).valid) {
          fail("SOURCE_PROCESSING_STATE_CONFLICT");
        }
        continue;
      }
      if (!derivedIds.has(memoryId)) fail("AUTHORITATIVE_LEGACY_RECORD_INCOMPATIBLE");
      record.processing = clone(claimedById.get(memoryId));
    }
    return memories;
  }

  function stripVirtualProcessing(memory) {
    const source = authorization.claimPlan.sources.find((item) =>
      item.memoryId === memory.id);
    if (source && derivedIds.has(memory.id) &&
        stable(memory.processing) === stable(source.claimedProcessing)) {
      const copy = clone(memory);
      delete copy.processing;
      delete copy.processing_provenance;
      return copy;
    }
    if (source && derivedIds.has(memory.id)) {
      memory.processing_provenance = {
        schema_version: 1,
        boundary_version: LEGACY_PROCESSING_BOUNDARY_VERSION,
        policy_version: LEGACY_PROCESSING_POLICY_VERSION,
        origin: "legacy_absence_derived",
        persisted_by: "authoritative_commit"
      };
    }
    return memory;
  }

  async function saveMemories(userId, memories, saveOptions) {
    if (userId !== options.userId || authorization === null || !Array.isArray(memories)) {
      fail("LEGACY_PROCESSING_SCOPE_NOT_AUTHORIZED");
    }
    const current = await authoritativeMap();
    const next = memories.map((memory) => stripVirtualProcessing(clone(memory)));
    const nextById = new Map(next.map((memory) => [memory?.id, memory]));
    for (const [key, record] of Object.entries(current)) {
      const incoming = nextById.get(key);
      if (!incoming || incoming.id !== key) fail("AUTHORITATIVE_LEGACY_IDENTITY_MISMATCH");
      if (!authorization.identities.has(key) && stable(incoming) !== stable(record)) {
        fail("UNAUTHORIZED_LEGACY_MEMORY_MUTATION");
      }
      if (authorization.identities.has(key)) {
        const preservedIncoming = clone(incoming);
        const preservedRecord = clone(record);
        for (const value of [preservedIncoming, preservedRecord]) {
          delete value.processing;
          delete value.processing_provenance;
          delete value.consolidation;
        }
        if (stable(preservedIncoming) !== stable(preservedRecord)) {
          fail("UNAUTHORIZED_LEGACY_SOURCE_MUTATION");
        }
      }
    }
    const added = next.filter((memory) => !Object.hasOwn(current, memory.id));
    if (added.length > 1) fail("MULTIPLE_SUPER_MEMORY_WRITE_ATTEMPTED");
    if (added.length === 1) {
      try { validateSuperMemoryRecord(added[0]); } catch {
        fail("INVALID_SUPER_MEMORY_WRITE_ATTEMPTED");
      }
    }
    return options.authoritativeStorage.saveMemories(userId, next, saveOptions);
  }

  const storage = Object.create(options.authoritativeStorage);
  Object.defineProperties(storage, {
    capabilities: { value: options.authoritativeStorage.capabilities, enumerable: true },
    loadMemories: { value: loadMemories },
    saveMemories: { value: saveMemories }
  });

  return Object.freeze({
    storage,
    authorizeSources,
    getAuthorization() { return authorization; }
  });
}

module.exports = {
  LEGACY_PROCESSING_BOUNDARY_VERSION,
  LEGACY_PROCESSING_POLICY_VERSION,
  AUTHORIZED_USER_ID,
  AuthoritativeLegacyProcessingBoundaryError,
  createAuthoritativeLegacyProcessingBoundary
};
