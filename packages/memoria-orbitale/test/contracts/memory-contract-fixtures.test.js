const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const fixtureDirectory = path.join(__dirname, "..", "fixtures", "memory-contract");
const fixtureNames = [
  "flat-memory.json",
  "nested-memory.json",
  "zero-values-memory.json",
  "null-values-memory.json",
  "historical-timestamps-memory.json",
  "legacy-memory.json"
];

function loadFixture(name) {
  const fixturePath = path.join(fixtureDirectory, name);
  return JSON.parse(fs.readFileSync(fixturePath, "utf8"));
}

test("all memory contract fixtures are valid JSON", () => {
  assert.deepEqual(
    fs.readdirSync(fixtureDirectory).sort(),
    [...fixtureNames].sort()
  );

  for (const name of fixtureNames) {
    assert.doesNotThrow(() => loadFixture(name), name);
  }
});

test("zero values remain explicit zero values", () => {
  const memory = loadFixture("zero-values-memory.json");

  assert.equal(memory.activation, 0);
  assert.equal(memory.orbitalState, 0);
  assert.equal(memory.accessCount, 0);
  assert.equal(memory.timestamp, 0);
  assert.equal(memory.lastAccess, 0);
  assert.equal(memory.orbital.activation_score, 0);
  assert.equal(memory.orbital.decay_rate, 0);
  assert.equal(memory.orbital.access_count, 0);
  assert.equal(memory.linkProbe.reinforcement_count, 0);
});

test("explicit null values remain null", () => {
  const memory = loadFixture("null-values-memory.json");

  assert.equal(memory.activation, null);
  assert.equal(memory.content.text, null);
  assert.equal(memory.lastAccess, null);
  assert.equal(memory.embedding_ref, null);
  assert.equal(memory.cluster, null);
  assert.equal(memory.links_summary, null);
});

test("historical timestamps are preserved without regeneration", () => {
  const memory = loadFixture("historical-timestamps-memory.json");

  assert.equal(memory.timestamp, -2208988800000);
  assert.equal(memory.lastAccess, -2208902400000);
  assert.equal(memory.orbital.birth, "1900-01-01T00:00:00.000Z");
  assert.equal(memory.orbital.last_access, "1900-01-02T00:00:00.000Z");
  assert.equal(memory.meta.timestamp, "1900-01-01T00:00:00.000Z");
});

test("flat and nested contracts stay separate", () => {
  const flat = loadFixture("flat-memory.json");
  const nested = loadFixture("nested-memory.json");

  assert.equal(flat.fixtureType, "operational-flat");
  assert.equal(typeof flat.activation, "number");
  assert.equal(typeof flat.orbitalLevel, "string");
  assert.equal(Object.hasOwn(flat, "orbital"), false);

  assert.equal(nested.fixtureType, "theoretical-nested");
  assert.equal(typeof nested.orbital.activation_score, "number");
  assert.equal(typeof nested.orbital.level, "string");
  assert.equal(Object.hasOwn(nested, "activation"), false);
  assert.equal(Object.hasOwn(nested, "orbitalLevel"), false);
});

test("legacy variants and future-only fields are explicit", () => {
  const legacy = loadFixture("legacy-memory.json");
  const operational = loadFixture("flat-memory.json");

  assert.equal(typeof legacy.content, "string");
  assert.equal(legacy.unknownLegacyField.preserveMe, true);
  assert.equal(legacy.futureContractExample.contractStatus, "future");
  assert.equal(legacy.futureContractExample.storageTier, "warm");
  assert.equal(legacy.futureContractExample.memoryKind, "raw");
  assert.equal(legacy.futureContractExample.processingState, "candidate");

  assert.equal(Object.hasOwn(operational, "storageTier"), false);
  assert.equal(Object.hasOwn(operational, "memoryKind"), false);
  assert.equal(Object.hasOwn(operational, "processingState"), false);
});

test("fixtures cover documented orbital levels and memory depths", () => {
  const fixtures = fixtureNames.map(loadFixture);
  const orbitalLevels = new Set();
  const memoryDepths = new Set();

  for (const memory of fixtures) {
    if (memory.orbitalLevel) orbitalLevels.add(memory.orbitalLevel);
    if (memory.orbital && memory.orbital.level) orbitalLevels.add(memory.orbital.level);
    if (memory.memoryDepth) memoryDepths.add(memory.memoryDepth);
  }

  assert.deepEqual([...orbitalLevels].sort(), ["long", "medium", "short"]);
  for (const depth of ["temporary", "normal", "deep", "core"]) {
    assert.equal(memoryDepths.has(depth), true, depth);
  }
});
