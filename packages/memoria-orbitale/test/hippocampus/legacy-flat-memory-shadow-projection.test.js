"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  LEGACY_FLAT_SHADOW_PROJECTION_VERSION,
  projectLegacyFlatMemoriesForShadow
} = require("../../core/hippocampus/LegacyFlatMemoryShadowProjection");
const {
  buildConsolidationPlanScalable
} = require("../../core/consolidation/ConsolidationPlan");
const {
  createReadOnlyAuthoritativeStorage
} = require("../../scripts/hippocampus-run");

function legacy(id, text, overrides = {}) {
  return {
    id,
    content: { text, role: "user" },
    timestamp: 1700000000000,
    activation: 0.5,
    orbitalState: "active",
    orbitalLevel: 2,
    memoryDepth: 1,
    lastAccess: 1800000000000,
    type: "episodic",
    ...overrides
  };
}

function project(memories, overrides = {}) {
  return projectLegacyFlatMemoriesForShadow(memories, {
    requestedUserId: "francesco",
    sourceUserId: "francesco",
    maxCandidates: 20,
    ...overrides
  });
}

test("keyed flat record preserves id and projects canonical raw only in RAM", () => {
  const source = { alpha: legacy("alpha", "testo") };
  const before = structuredClone(source);
  const result = project(source);
  assert.equal(result.projectionVersion,
    LEGACY_FLAT_SHADOW_PROJECTION_VERSION);
  assert.equal(result.records[0].id, "alpha");
  assert.equal(result.records[0].processingState, "raw");
  assert.equal(result.records[0].shadowProjection.processingStatePersisted,
    false);
  assert.equal(result.records[0].shadowProjection.processingStateAuthority,
    "runtime_projection_only");
  assert.equal(Object.hasOwn(source.alpha, "processingState"), false);
  assert.deepEqual(source, before);
});

test("key/id mismatch and duplicate identities fail closed", () => {
  const mismatch = project({ key: legacy("other", "x") });
  assert.equal(mismatch.records.length, 0);
  assert.equal(mismatch.stats.exclusionCounts.keyIdentityMismatchCount, 1);

  const duplicate = project([
    legacy("same", "one"), legacy("same", "two")
  ]);
  assert.equal(duplicate.records.length, 0);
  assert.equal(duplicate.stats.exclusionCounts.duplicateIdentityCount, 2);
});

test("missing identities and missing or empty text are excluded", () => {
  const result = project([
    legacy("", "valid"),
    legacy("empty", ""),
    { id: "missing", content: {} }
  ]);
  assert.equal(result.records.length, 0);
  assert.deepEqual(result.stats.exclusionCounts, {
    duplicateIdentityCount: 0,
    emptyContentCount: 2,
    keyIdentityMismatchCount: 0,
    missingIdentityCount: 1,
    structuralIncompatibilityCount: 0,
    userScopeMismatchCount: 0
  });
});

test("contentHash is exact SHA-256 of the original UTF-8 text", () => {
  const text = "  memoria è\n";
  const result = project({ exact: legacy("exact", text) });
  assert.equal(Object.hasOwn(result.records[0].content, "content"), false);
  assert.equal(result.records[0].content.text, text);
  assert.equal(result.records[0].contentHash,
    createHash("sha256").update(text, "utf8").digest("hex"));
});

test("selection is deterministic, bounded and independent of input order", () => {
  const direct = Object.fromEntries(Array.from({ length: 30 }, (_, index) => {
    const id = `id-${String(index).padStart(2, "0")}`;
    return [id, legacy(id, `text-${index}`)];
  }));
  const inverse = Object.fromEntries(Object.entries(direct).reverse());
  const left = project(direct, { maxCandidates: 7 });
  const right = project(inverse, { maxCandidates: 7 });
  assert.equal(left.records.length, 7);
  assert.deepEqual(left.records, right.records);
  assert.deepEqual(left.records.map((record) => record.id),
    ["id-00", "id-01", "id-02", "id-03", "id-04", "id-05", "id-06"]);
});

test("lastAccess is preserved only as lastAccess and never invented as eventTime", () => {
  const result = project({ one: legacy("one", "x") });
  assert.equal(result.records[0].lastAccess, 1800000000000);
  assert.equal(Object.hasOwn(result.records[0], "eventTime"), false);
  assert.equal(Object.hasOwn(result.records[0], "eventTimeEvidence"), false);
});

test("user scope mismatch excludes records without exposing identities", () => {
  const result = project({ one: legacy("one", "x") }, {
    sourceUserId: "different-user"
  });
  assert.equal(result.records.length, 0);
  assert.equal(result.stats.exclusionCounts.userScopeMismatchCount, 1);
});

test("twenty valid legacy records produce twenty planner candidates", async () => {
  const source = Object.fromEntries(Array.from({ length: 20 }, (_, index) => {
    const id = `legacy-${String(index).padStart(2, "0")}`;
    return [id, legacy(id, `memory-${index}`)];
  }));
  const projection = project(source);
  const planned = await buildConsolidationPlanScalable(projection.records, {
    allowLegacyUnclassified: false,
    maxCandidates: 20,
    batchSize: 20,
    budget: { maxElapsedMs: 9500, maxRssDeltaBytes: 128 * 1024 * 1024 },
    signal: new AbortController().signal
  });
  assert.equal(projection.records.length, 20);
  assert.equal(planned.plan.candidateIds.length, 20);
  assert.ok(planned.plan.decisions.every((item) =>
    item.processingState === "raw" && item.contentHash !== null));
});

test("read-only storage never writes and reread exposes changed hash", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hact4-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "francesco_memories.json");
  fs.writeFileSync(file, JSON.stringify({ one: legacy("one", "before") }));
  const storage = createReadOnlyAuthoritativeStorage(directory);
  const signal = new AbortController().signal;
  const initial = await storage.loadLegacyShadowCandidates({
    userId: "francesco", limit: 1, signal
  });
  const beforeWrite = fs.readFileSync(file, "utf8");
  assert.equal(fs.readFileSync(file, "utf8"), beforeWrite);
  const changed = JSON.parse(beforeWrite);
  changed.one.content.text = "after";
  fs.writeFileSync(file, JSON.stringify(changed));
  const reread = await storage.rereadLegacyShadowCandidates({
    userId: "francesco", memoryIds: ["one"], signal
  });
  assert.notEqual(initial.records[0].contentHash,
    reread.records[0].contentHash);
  assert.equal(Object.hasOwn(changed.one, "processingState"), false);
  assert.equal(storage.getAuthoritativeMemoryReads(), 2);
});
