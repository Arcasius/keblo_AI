const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)]));
  }
  return value;
}

function rejected(reasonCode) {
  return Object.freeze({ status: "rejected", reasonCode, memory: null });
}

export function projectKebloLegacyFlatMemoryToWarm(memory, {
  detectMemoryContract,
  normalizeMemory
} = {}) {
  if (typeof detectMemoryContract !== "function" || typeof normalizeMemory !== "function") {
    throw new TypeError("memory contract functions are required");
  }
  if (!memory || typeof memory !== "object" || Array.isArray(memory)) {
    return rejected("MALFORMED_RECORD");
  }

  let contract;
  let normalized;
  try {
    contract = detectMemoryContract(memory);
    normalized = normalizeMemory(memory);
  } catch {
    return rejected("NORMALIZATION_FAILED");
  }
  if (contract !== "flat") return rejected("NOT_LEGACY_FLAT");
  if (typeof normalized.id !== "string" || normalized.id.trim().length === 0 ||
      typeof normalized.content?.text !== "string" || normalized.content.text.length === 0) {
    return rejected("INVALID_ID_OR_CONTENT");
  }
  const activation = normalized.orbital?.activation;
  if (typeof activation !== "number" || !Number.isFinite(activation) || activation < 0 || activation > 1) {
    return rejected("INVALID_ACTIVATION");
  }
  if (hasOwn(memory, "memoryKind") || hasOwn(memory, "storageTier")) {
    return rejected("EXPLICIT_CANONICAL_FIELDS");
  }
  if (normalized.memoryKind !== null || normalized.storageTier !== null) {
    return rejected("CANONICAL_FIELDS_PRESENT");
  }
  if (normalized.type === "super_memory" || hasOwn(memory, "source_memory_ids")) {
    return rejected("SUPERMEMORY_NOT_PROJECTABLE");
  }

  const projected = clone(memory);
  projected.memoryKind = "raw";
  projected.storageTier = "warm";
  return Object.freeze({ status: "projected", reasonCode: "PROJECTED_FLAT_WARM",
    memory: projected });
}
