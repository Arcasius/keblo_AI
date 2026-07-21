"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  detectMemoryContract,
  normalizeMemory
} = require("../../core/MemoryContractNormalizer");

const fixtureDirectory = path.join(__dirname, "..", "fixtures", "memory-contract");

function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(fixtureDirectory, name), "utf8"));
}

function deepFreeze(value) {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

test("detects flat, nested, hybrid and unknown contracts by property presence", () => {
  assert.equal(detectMemoryContract({ activation: 0 }), "flat");
  assert.equal(detectMemoryContract({ orbital: { activation_score: 0 } }), "nested");
  assert.equal(
    detectMemoryContract({ activation: null, orbital: { activation_score: 0 } }),
    "hybrid"
  );
  assert.equal(detectMemoryContract({ id: "shared-only", content: {} }), "unknown");
});

test("rejects non-plain top-level inputs", () => {
  class MemoryLike {}
  for (const input of [null, undefined, [], "memory", 1, true, new MemoryLike()]) {
    assert.throws(
      () => normalizeMemory(input),
      { name: "TypeError", message: "Memory must be a plain object" }
    );
    assert.throws(() => detectMemoryContract(input), TypeError);
  }
});

test("rejects non-JSON-like nested behavior", () => {
  assert.throws(
    () => normalizeMemory({ meta: new Date(0) }),
    /only JSON-like plain data/
  );
  assert.throws(
    () => normalizeMemory({ callback() {} }),
    /only JSON-like plain data/
  );
});

test("normalizes the flat fixture without inventing future fields", () => {
  const memory = loadFixture("flat-memory.json");
  const normalized = normalizeMemory(memory);

  assert.equal(normalized.sourceContract, "flat");
  assert.equal(normalized.schemaVersion, 1);
  assert.equal(normalized.id, memory.id);
  assert.equal(normalized.content.text, memory.content.text);
  assert.equal(normalized.orbital.level, memory.orbitalLevel);
  assert.equal(normalized.orbital.activation, memory.activation);
  assert.equal(normalized.timestamps.createdAt, memory.timestamp);
  assert.equal(normalized.timestamps.updatedAt, null);
  assert.equal(normalized.storageTier, null);
  assert.equal(normalized.memoryKind, null);
  assert.equal(normalized.processingState, null);
  assert.equal(normalized.provenance, null);
});

test("normalizes the nested fixture and preserves nested sections", () => {
  const memory = loadFixture("nested-memory.json");
  const normalized = normalizeMemory(memory);

  assert.equal(normalized.sourceContract, "nested");
  assert.equal(normalized.orbital.level, memory.orbital.level);
  assert.equal(normalized.orbital.activation, memory.orbital.activation_score);
  assert.equal(normalized.orbital.lastAccess, memory.orbital.last_access);
  assert.equal(normalized.orbital.accessCount, memory.orbital.access_count);
  assert.equal(normalized.timestamps.createdAt, memory.meta.timestamp);
  assert.deepEqual(normalized.content.entities, []);
  assert.deepEqual(normalized.content.contextTags, ["synthetic"]);
  assert.deepEqual(normalized.cluster, memory.cluster);
  assert.deepEqual(normalized.linksSummary, memory.links_summary);
});

test("applies flat precedence field by field for hybrid memories", () => {
  const hybrid = {
    id: "hybrid",
    activation: 0,
    orbitalLevel: "",
    lastAccess: null,
    timestamp: 0,
    orbital: {
      activation_score: 0.8,
      level: "long",
      last_access: "2020-01-02T00:00:00.000Z",
      access_count: 4
    },
    meta: { timestamp: "2020-01-01T00:00:00.000Z" }
  };
  const normalized = normalizeMemory(hybrid);

  assert.equal(normalized.sourceContract, "hybrid");
  assert.equal(normalized.orbital.activation, 0);
  assert.equal(normalized.orbital.level, "");
  assert.equal(normalized.orbital.lastAccess, null);
  assert.equal(normalized.orbital.accessCount, 4);
  assert.equal(normalized.timestamps.createdAt, 0);
});

test("preserves explicit null, zero, false, empty string and undefined", () => {
  const normalized = normalizeMemory({
    activation: null,
    orbitalLevel: false,
    lastAccess: "",
    accessCount: undefined,
    orbital: {
      activation_score: 0.8,
      level: "nested",
      last_access: 123,
      access_count: 9
    }
  });

  assert.equal(normalized.orbital.activation, null);
  assert.equal(normalized.orbital.level, false);
  assert.equal(normalized.orbital.lastAccess, "");
  assert.equal(normalized.orbital.accessCount, undefined);
});

test("supports string, object, null and absent content conservatively", () => {
  const legacy = normalizeMemory(loadFixture("legacy-memory.json"));
  assert.equal(legacy.content.text, "Synthetic legacy string content");

  const objectContent = normalizeMemory({
    activation: 1,
    content: { text: "", entities: ["entity"], context_tags: false, extra: 7 }
  });
  assert.equal(objectContent.content.text, "");
  assert.deepEqual(objectContent.content.entities, ["entity"]);
  assert.equal(objectContent.content.contextTags, false);
  assert.equal(objectContent.sourceSnapshot.content.extra, 7);

  assert.equal(normalizeMemory({ activation: 1, content: null }).content.text, null);
  assert.equal(normalizeMemory({ activation: 1 }).content.text, null);
  assert.equal(normalizeMemory({ activation: 1, text: "fallback" }).content.text, "fallback");
});

test("preserves historical and epoch timestamps exactly and generates none", () => {
  const historical = loadFixture("historical-timestamps-memory.json");
  const normalized = normalizeMemory(historical);
  const absent = normalizeMemory({ id: "no-time" });

  assert.equal(normalized.timestamps.createdAt, -2208988800000);
  assert.equal(normalized.orbital.lastAccess, -2208902400000);
  assert.equal(normalized.sourceSnapshot.orbital.birth, "1900-01-01T00:00:00.000Z");
  assert.equal(absent.timestamps.createdAt, null);
  assert.equal(absent.timestamps.updatedAt, null);
});

test("preserves historical and core memoryDepth without inference", () => {
  assert.equal(normalizeMemory(loadFixture("legacy-memory.json")).memoryDepth, "historical");
  assert.equal(
    normalizeMemory(loadFixture("historical-timestamps-memory.json")).memoryDepth,
    "core"
  );
  assert.equal(normalizeMemory({ orbitalLevel: "long" }).storageTier, null);
});

test("recognizes FIX 10 processing while preserving explicit processingState precedence", () => {
  assert.equal(normalizeMemory({
    id: "super",
    memoryKind: "super_memory",
    storageTier: "core",
    processing: { state: "consolidated" }
  }).processingState, "consolidated");
  assert.equal(normalizeMemory({
    processingState: "legacy-explicit",
    processing: { state: "consolidated" }
  }).processingState, "legacy-explicit");
});

test("preserves unknown legacy fields in a detached source snapshot", () => {
  const memory = loadFixture("legacy-memory.json");
  const normalized = normalizeMemory(memory);

  assert.deepEqual(
    normalized.sourceSnapshot.unknownLegacyField,
    memory.unknownLegacyField
  );
  assert.equal(normalized.storageTier, null);
  assert.equal(normalized.memoryKind, null);
  assert.equal(normalized.processingState, null);
});

test("does not mutate input or share mutable references", () => {
  const memory = deepFreeze(loadFixture("nested-memory.json"));
  const before = structuredClone(memory);
  const normalized = normalizeMemory(memory);

  assert.deepEqual(memory, before);
  assert.notStrictEqual(normalized.content.entities, memory.content.entities);
  assert.notStrictEqual(normalized.cluster, memory.cluster);
  assert.notStrictEqual(normalized.meta, memory.meta);
  assert.notStrictEqual(normalized.sourceSnapshot, memory);

  normalized.content.entities.push("changed");
  normalized.cluster.density = 99;
  normalized.sourceSnapshot.meta.user_id = "changed";
  assert.deepEqual(memory, before);
});

test("returns deterministic plain data", () => {
  const memory = loadFixture("zero-values-memory.json");
  const first = normalizeMemory(memory);
  const second = normalizeMemory(memory);

  assert.deepStrictEqual(first, second);
  assert.equal(Object.getPrototypeOf(first), Object.prototype);
  assert.equal(Object.getPrototypeOf(first.orbital), Object.prototype);
  assert.equal(Object.getPrototypeOf(first.sourceSnapshot), Object.prototype);
});

test("normalizer has no runtime or external-service imports", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "..", "core", "MemoryContractNormalizer.js"),
    "utf8"
  );

  assert.doesNotMatch(source, /require\s*\(/);
  assert.doesNotMatch(source, /MemoryNode|JsonMemoryStorage|Keblomemory|Qwen|Ollama/);
});
