"use strict";

const { normalizeMemory } = require("../MemoryContractNormalizer.js");

const MEMORY_TIER_CLASSIFIER_VERSION = 1;
const LEGACY_DEEP_MEMORY_DEPTHS = Object.freeze(["deep", "historical"]);

class MemoryTierClassificationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "MemoryTierClassificationError";
    this.code = code;
  }
}

function classifyMemoryTier(memory) {
  let normalized;
  try {
    normalized = normalizeMemory(memory);
  } catch {
    throw new MemoryTierClassificationError("INVALID_MEMORY", "Memory cannot be normalized");
  }

  const sourceContract = normalized.sourceContract;
  const storageTier = normalized.storageTier;
  const memoryKind = normalized.memoryKind;
  const memoryDepth = normalized.memoryDepth;

  if (memoryKind === "super_memory") {
    return Object.freeze(storageTier === "core"
      ? { tier: "core", reasonCode: "EXPLICIT_CORE_SUPER_MEMORY", legacyDerived: false, sourceContract }
      : { tier: null, reasonCode: "INCOMPATIBLE_SUPER_MEMORY", legacyDerived: false, sourceContract });
  }
  if (storageTier === "warm") {
    return Object.freeze({ tier: "warm", reasonCode: "EXPLICIT_WARM", legacyDerived: false, sourceContract });
  }
  if (storageTier === "deep") {
    return Object.freeze({ tier: "deep", reasonCode: "EXPLICIT_DEEP", legacyDerived: false, sourceContract });
  }
  if (storageTier !== null) {
    return Object.freeze({ tier: null, reasonCode: "UNCLASSIFIABLE", legacyDerived: false, sourceContract });
  }
  if (memoryDepth === "deep") {
    return Object.freeze({ tier: "deep", reasonCode: "LEGACY_DEEP_MEMORY_DEPTH", legacyDerived: true, sourceContract });
  }
  if (memoryDepth === "historical") {
    return Object.freeze({ tier: "deep", reasonCode: "LEGACY_HISTORICAL_MEMORY_DEPTH", legacyDerived: true, sourceContract });
  }
  return Object.freeze({ tier: "warm", reasonCode: "LEGACY_WARM", legacyDerived: true, sourceContract });
}

function matchesMemoryTier(memory, tier) {
  if (!["core", "warm", "deep"].includes(tier)) {
    throw new MemoryTierClassificationError("INVALID_TIER", "Tier is invalid");
  }
  return classifyMemoryTier(memory).tier === tier;
}

module.exports = {
  MEMORY_TIER_CLASSIFIER_VERSION,
  LEGACY_DEEP_MEMORY_DEPTHS,
  MemoryTierClassificationError,
  classifyMemoryTier,
  matchesMemoryTier
};
