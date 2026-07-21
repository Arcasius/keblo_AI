"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  CANDIDATE_SELECTION_ALGORITHM_VERSION,
  DEFAULT_CANDIDATE_SCALE_OPTIONS,
  selectConsolidationCandidates,
  selectConsolidationCandidatesScalable
} = require("../../core/consolidation/CandidateSelector");
const {
  CONSOLIDATION_PLAN_ALGORITHM_VERSION,
  buildConsolidationPlan,
  buildConsolidationPlanScalable,
  validateConsolidationPlan
} = require("../../core/consolidation/ConsolidationPlan");
const { createHippocampusDaemon } = require("../../core/hippocampus/HippocampusDaemon");

const BASE = 1960000000000;

function memory(id, text = `synthetic ${id}`, overrides = {}) {
  return {
    id,
    type: "episodic",
    content: { text, entities: ["private-entity"], contextTags: ["private-tag"] },
    timestamp: BASE,
    memoryKind: "raw",
    storageTier: "warm",
    processingState: "raw",
    meta: { private: "PRIVATE_META_SENTINEL" },
    unknown: { preserve: true },
    ...overrides
  };
}

async function scalablePlan(memories, batchSize, extra = {}) {
  return buildConsolidationPlanScalable(memories, {
    batchSize,
    budget: { maxElapsedMs: 60000, maxRssDeltaBytes: 512 * 1024 * 1024 },
    ...extra
  });
}

test("legacy and scalable APIs are semantically identical for every batch size", async () => {
  const input = [
    memory("z"),
    memory("a"),
    memory("deep", "deep", { storageTier: "deep" }),
    memory("failed", "failed", { processingState: "failed" }),
    { id: "legacy", content: "legacy", activation: 0 }
  ];
  const legacySelection = selectConsolidationCandidates(input, { allowLegacyUnclassified: true });
  const legacyPlan = buildConsolidationPlan(legacySelection);
  for (const batchSize of [1, 7, 100, 500, 1000]) {
    const scalable = await scalablePlan(input, batchSize, { allowLegacyUnclassified: true });
    assert.deepStrictEqual(scalable.plan, legacyPlan);
    assert.deepStrictEqual((await selectConsolidationCandidatesScalable(input, {
      batchSize,
      allowLegacyUnclassified: true,
      budget: { maxElapsedMs: 60000, maxRssDeltaBytes: 512 * 1024 * 1024 }
    })).selection, legacySelection);
    assert.equal(scalable.telemetry.batchSize, batchSize);
  }
});

test("deduplication remains global across batch boundaries", async () => {
  const input = [
    memory("duplicate-id", "second"),
    memory("middle-a", "shared exact"),
    memory("middle-b", "unique"),
    memory("duplicate-id", "first"),
    memory("last", "shared exact")
  ];
  const result = await scalablePlan(input, 2);
  assert.equal(result.plan.stats.duplicateIdCount, 1);
  assert.equal(result.plan.stats.duplicateContentCount, 1);
  assert.equal(result.plan.decisions.filter(item => item.reasonCodes[0] === "DUPLICATE_ID").length, 1);
  assert.equal(result.plan.decisions.find(item => item.memoryId === "middle-a").reasonCodes[0], "DUPLICATE_CONTENT");
  assert.equal(result.telemetry.duplicateIdCount, 1);
  assert.equal(result.telemetry.duplicateContentCount, 1);
});

test("array order, object maps and batch scheduling produce one planId", async () => {
  const input = [memory("c"), memory("a"), memory("b"), memory("same", "z"), memory("same", "a")];
  const reversed = [...input].reverse();
  const map = Object.fromEntries(reversed.map((item, index) => [`key-${index}`, structuredClone(item)]));
  const plans = [
    (await scalablePlan(input, 1)).plan,
    (await scalablePlan(reversed, 7)).plan,
    (await scalablePlan(map, 100)).plan
  ];
  assert.deepStrictEqual(plans[0], plans[1]);
  assert.deepStrictEqual(plans[1], plans[2]);
  assert.equal(new Set(plans.map(plan => plan.planId)).size, 1);
});

test("zero, one, twelve and one hundred inputs are fully accounted without top five", async () => {
  for (const count of [0, 1, 12, 100]) {
    const result = await scalablePlan(Array.from({ length: count }, (_, index) => memory(`m-${String(index).padStart(3, "0")}`)), 7);
    assert.equal(result.plan.decisions.length, count);
    assert.equal(result.plan.stats.inputCount, count);
    assert.equal(result.plan.candidateIds.length, count);
    assert.equal(result.telemetry.processedCount, count);
    assert.equal(result.telemetry.batchCount, count === 0 ? 0 : Math.ceil(count / 7));
  }
});

test("forty thousand synthetic inputs produce forty thousand decisions", { timeout: 30000 }, async () => {
  const count = 40000;
  const input = Array.from({ length: count }, (_, index) => memory(`scale-${String(index).padStart(5, "0")}`, `scale text ${index}`));
  const result = await scalablePlan(input, 1000);
  assert.equal(result.plan.decisions.length, count);
  assert.equal(result.plan.candidateIds.length, count);
  assert.equal(result.telemetry.processedCount, count);
  assert.equal(result.telemetry.batchCount, 40);
  assert.equal(validateConsolidationPlan(result.plan).valid, true);
});

test("maxCandidates is semantic while batchSize is only operational", async () => {
  const input = Array.from({ length: 12 }, (_, index) => memory(`limit-${String(index).padStart(2, "0")}`));
  const small = await scalablePlan(input, 1, { maxCandidates: 5 });
  const large = await scalablePlan(input, 1000, { maxCandidates: 5 });
  assert.deepStrictEqual(small.plan, large.plan);
  assert.equal(small.plan.stats.eligibleBeforeLimit, 12);
  assert.equal(small.plan.stats.eligibleIncluded, 5);
  assert.equal(small.plan.stats.deferredCount, 7);
  assert.equal(small.plan.decisions.filter(item => item.reasonCodes[0] === "LIMIT_EXPLICITLY_APPLIED").length, 7);
});

test("telemetry is private, immutable and excluded from plan identity", async () => {
  const input = [memory("private", "PRIVATE_TEXT_SENTINEL")];
  const first = await scalablePlan(input, 1);
  const second = await scalablePlan(input, 100);
  assert.equal(first.plan.planId, second.plan.planId);
  assert.deepStrictEqual(first.plan, second.plan);
  assert.notDeepStrictEqual(first.telemetry, second.telemetry);
  assert.equal(Object.isFrozen(first.telemetry), true);
  assert.equal(Object.isFrozen(first.telemetry.budget), true);
  assert.throws(() => { first.telemetry.batchSize = 99; }, TypeError);
  const rawTelemetry = JSON.stringify(first.telemetry);
  assert.doesNotMatch(rawTelemetry, /private|PRIVATE_TEXT_SENTINEL|PRIVATE_META_SENTINEL|sourceSnapshot|contentHash|memoryId|userId|path/i);
  assert.doesNotMatch(JSON.stringify(first.plan), /PRIVATE_TEXT_SENTINEL|PRIVATE_META_SENTINEL|private-entity|sourceSnapshot/);
  assert.equal(first.telemetry.algorithmVersion, CONSOLIDATION_PLAN_ALGORITHM_VERSION);
  assert.equal(CANDIDATE_SELECTION_ALGORITHM_VERSION, "candidate-selection-batched-v1");
  assert.equal(DEFAULT_CANDIDATE_SCALE_OPTIONS.batchSize, 500);
});

test("input fields and processing state remain unchanged and outputs are frozen", async () => {
  const input = [memory("immutable", "immutable", { processing: { state: "raw", revision: 0 } })];
  const before = structuredClone(input);
  const result = await scalablePlan(input, 1);
  assert.deepStrictEqual(input, before);
  assert.equal(input[0].processing.state, "raw");
  assert.equal(input[0].unknown.preserve, true);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.plan), true);
  assert.equal(Object.isFrozen(result.plan.decisions[0]), true);
});

test("abort between batches rejects without returning a partial valid artifact", async () => {
  const controller = new AbortController();
  const pending = scalablePlan(Array.from({ length: 100 }, (_, index) => memory(`abort-${index}`)), 1, { signal: controller.signal });
  queueMicrotask(() => controller.abort());
  await assert.rejects(pending, { code: "CANDIDATE_SELECTION_ABORTED" });
  await assert.rejects(scalablePlan([memory("already-aborted")], 1, { signal: controller.signal }), { code: "CANDIDATE_SELECTION_ABORTED" });
});

test("daemon plan dry-run uses scalable path and reports sanitized telemetry", async () => {
  let writes = 0;
  const input = Array.from({ length: 12 }, (_, index) => memory(`daemon-${String(index).padStart(2, "0")}`));
  const storage = {
    capabilities: { schemaVersion: 1, statuses: { "memory.readAll": { status: "supported", verified: true } } },
    async loadMemories() { return input; },
    async saveMemories() { writes += 1; }
  };
  const daemon = createHippocampusDaemon({ storage, userId: "synthetic-user", candidatePolicy: { batchSize: 7 }, clock: (() => { let value = BASE; return () => value++; })(), idGenerator: () => "scale-dry-run" });
  const report = await daemon.runOnce();
  assert.equal(report.dryRun, true);
  assert.equal(report.writesAttempted, 0);
  assert.equal(writes, 0);
  assert.equal(report.scaleTelemetry.processedCount, 12);
  assert.equal(report.scaleTelemetry.batchSize, 7);
  assert.equal(report.scaleTelemetry.batchCount, 2);
  assert.doesNotMatch(JSON.stringify(report.scaleTelemetry), /daemon-00|synthetic-user|synthetic daemon/i);
});
