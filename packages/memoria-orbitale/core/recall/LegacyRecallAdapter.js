"use strict";

const { classifyMemoryTier } = require("./MemoryTierClassifier.js");

const LEGACY_RECALL_ADAPTER_SCHEMA_VERSION = 1;

class LegacyRecallAdapterError extends Error {
  constructor(code, message, tier = null) {
    super(message);
    this.name = "LegacyRecallAdapterError";
    this.code = code;
    this.tier = tier;
  }
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === "object") {
    const output = {};
    for (const [key, child] of Object.entries(value)) output[key] = clone(child);
    return output;
  }
  return value;
}

function createLegacyRecallAdapter(options = {}) {
  const { kebloMemory, userId } = options;
  if (!kebloMemory || typeof kebloMemory.recallReadOnly !== "function") {
    throw new LegacyRecallAdapterError("INVALID_KEBLO_MEMORY", "kebloMemory must expose recallReadOnly");
  }
  if (userId !== undefined && (typeof userId !== "string" || userId.trim().length === 0)) {
    throw new LegacyRecallAdapterError("INVALID_USER_ID", "userId must be non-empty when provided");
  }

  function retriever(tier) {
    return Object.freeze({
      schemaVersion: LEGACY_RECALL_ADAPTER_SCHEMA_VERSION,
      id: `legacy-keblo-${tier}-v1`,
      async search({ query, tier: requestedTier, limit, mutate }) {
        if (requestedTier !== tier || mutate !== false) {
          throw new LegacyRecallAdapterError("INVALID_RETRIEVAL_REQUEST", "Adapter requires matching tier and mutate false", tier);
        }
        const memories = await kebloMemory.recallReadOnly(userId, query, { limit, tier, includeLinks: true });
        return memories.map((memory) => {
          const classification = classifyMemoryTier(memory);
          if (classification.tier !== tier || typeof memory._score !== "number") {
            throw new LegacyRecallAdapterError("TIER_VIOLATION", "Legacy result violated requested tier", tier);
          }
          const adapted = clone(memory);
          if (classification.legacyDerived) adapted.storageTier = tier;
          if (!adapted.memoryKind) {
            adapted.memoryKind = ["episodic", "semantic", "structural"].includes(adapted.type)
              ? adapted.type
              : "raw";
          }
          return { id: adapted.id, score: adapted._score, retrievalTier: tier, memory: adapted };
        });
      }
    });
  }

  return Object.freeze({
    coreRetriever: retriever("core"),
    warmRetriever: retriever("warm"),
    deepRetriever: retriever("deep")
  });
}

module.exports = {
  LEGACY_RECALL_ADAPTER_SCHEMA_VERSION,
  LegacyRecallAdapterError,
  createLegacyRecallAdapter
};
