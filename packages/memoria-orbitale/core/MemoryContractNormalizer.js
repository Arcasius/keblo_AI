"use strict";

const hasOwn = (object, property) =>
  Object.prototype.hasOwnProperty.call(object, property);

const FLAT_FIELDS = [
  "activation",
  "orbitalState",
  "orbitalLevel",
  "memoryDepth",
  "dualState",
  "decay_rate",
  "timestamp",
  "lastAccess",
  "accessCount",
  "tags"
];

const NESTED_ORBITAL_FIELDS = [
  "level",
  "activation_score",
  "decay_rate",
  "last_access",
  "access_count",
  "birth"
];

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertMemory(memory) {
  if (!isPlainObject(memory)) {
    throw new TypeError("Memory must be a plain object");
  }

  assertJsonLike(memory, new Set());
}

function assertJsonLike(value, ancestors) {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" && Number.isFinite(value) ||
    typeof value === "boolean"
  ) {
    return;
  }

  if (!Array.isArray(value) && !isPlainObject(value)) {
    throw new TypeError("Memory must contain only JSON-like plain data");
  }

  if (ancestors.has(value)) {
    throw new TypeError("Memory must not contain circular references");
  }

  ancestors.add(value);
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    assertJsonLike(child, ancestors);
  }
  ancestors.delete(value);
}

function cloneValue(value) {
  if (Array.isArray(value)) {
    return value.map(cloneValue);
  }

  if (isPlainObject(value)) {
    const clone = {};
    for (const key of Object.keys(value)) {
      clone[key] = cloneValue(value[key]);
    }
    return clone;
  }

  return value;
}

function hasFlatContract(memory) {
  return FLAT_FIELDS.some((field) => hasOwn(memory, field));
}

function hasNestedContract(memory) {
  if (!hasOwn(memory, "orbital") || !isPlainObject(memory.orbital)) {
    return false;
  }

  return NESTED_ORBITAL_FIELDS.some((field) => hasOwn(memory.orbital, field));
}

function detectMemoryContractValidated(memory) {
  const flat = hasFlatContract(memory);
  const nested = hasNestedContract(memory);

  if (flat && nested) return "hybrid";
  if (flat) return "flat";
  if (nested) return "nested";
  return "unknown";
}

function detectMemoryContract(memory) {
  assertMemory(memory);

  return detectMemoryContractValidated(memory);
}

function readOwn(object, property) {
  return isPlainObject(object) && hasOwn(object, property)
    ? object[property]
    : null;
}

function preferOwn(flatObject, flatProperty, nestedObject, nestedProperty) {
  if (hasOwn(flatObject, flatProperty)) return flatObject[flatProperty];
  return readOwn(nestedObject, nestedProperty);
}

function normalizeContent(memory) {
  const content = hasOwn(memory, "content") ? memory.content : null;

  if (typeof content === "string") {
    return { text: content, entities: null, contextTags: null };
  }

  if (isPlainObject(content)) {
    let contextTags = null;
    if (hasOwn(content, "contextTags")) {
      contextTags = content.contextTags;
    } else if (hasOwn(content, "context_tags")) {
      contextTags = content.context_tags;
    }

    return {
      text: hasOwn(content, "text") ? cloneValue(content.text) : null,
      entities: hasOwn(content, "entities") ? cloneValue(content.entities) : null,
      contextTags: cloneValue(contextTags)
    };
  }

  return {
    text: !hasOwn(memory, "content") && hasOwn(memory, "text")
      ? cloneValue(memory.text)
      : null,
    entities: null,
    contextTags: null
  };
}

function normalizeMemory(memory) {
  assertMemory(memory);

  const orbital = isPlainObject(memory.orbital) ? memory.orbital : null;
  const meta = isPlainObject(memory.meta) ? memory.meta : null;
  const createdAt = preferOwn(memory, "timestamp", meta, "timestamp");

  return {
    schemaVersion: 1,
    sourceContract: detectMemoryContract(memory),
    id: readOwn(memory, "id"),
    type: readOwn(memory, "type"),
    content: normalizeContent(memory),
    orbital: {
      level: cloneValue(preferOwn(memory, "orbitalLevel", orbital, "level")),
      activation: cloneValue(
        preferOwn(memory, "activation", orbital, "activation_score")
      ),
      lastAccess: cloneValue(
        preferOwn(memory, "lastAccess", orbital, "last_access")
      ),
      accessCount: cloneValue(
        preferOwn(memory, "accessCount", orbital, "access_count")
      )
    },
    memoryDepth: cloneValue(readOwn(memory, "memoryDepth")),
    storageTier: cloneValue(readOwn(memory, "storageTier")),
    memoryKind: cloneValue(readOwn(memory, "memoryKind")),
    processingState: cloneValue(
      hasOwn(memory, "processingState")
        ? memory.processingState
        : readOwn(memory.processing, "state")
    ),
    timestamps: {
      createdAt: cloneValue(createdAt),
      updatedAt: cloneValue(readOwn(memory, "updatedAt"))
    },
    tags: cloneValue(readOwn(memory, "tags")),
    dualState: cloneValue(readOwn(memory, "dualState")),
    meta: cloneValue(readOwn(memory, "meta")),
    cluster: cloneValue(readOwn(memory, "cluster")),
    embeddingRef: cloneValue(readOwn(memory, "embedding_ref")),
    linksSummary: cloneValue(readOwn(memory, "links_summary")),
    provenance: cloneValue(readOwn(memory, "provenance")),
    sourceSnapshot: cloneValue(memory)
  };
}

function projectMemoryForCandidateSelection(memory) {
  assertMemory(memory);
  const meta = isPlainObject(memory.meta) ? memory.meta : null;
  const content = hasOwn(memory, "content") ? memory.content : null;
  let text = null;
  if (typeof content === "string") text = content;
  else if (isPlainObject(content) && hasOwn(content, "text")) text = content.text;
  else if (!hasOwn(memory, "content") && hasOwn(memory, "text")) text = memory.text;

  return {
    sourceContract: detectMemoryContractValidated(memory),
    id: cloneValue(readOwn(memory, "id")),
    text: cloneValue(text),
    timestamp: cloneValue(preferOwn(memory, "timestamp", meta, "timestamp")),
    memoryKind: cloneValue(readOwn(memory, "memoryKind")),
    storageTier: cloneValue(readOwn(memory, "storageTier")),
    processingState: cloneValue(
      hasOwn(memory, "processingState")
        ? memory.processingState
        : readOwn(memory.processing, "state")
    )
  };
}

module.exports = {
  detectMemoryContract,
  normalizeMemory,
  projectMemoryForCandidateSelection
};
