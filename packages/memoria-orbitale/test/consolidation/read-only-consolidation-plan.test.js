"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  CANDIDATE_DECISIONS,
  CANDIDATE_REASON_CODES,
  DEFAULT_CANDIDATE_POLICY,
  selectConsolidationCandidates
} = require("../../core/consolidation/CandidateSelector");
const {
  CONSOLIDATION_PLAN_SCHEMA_VERSION,
  buildConsolidationPlan,
  validateConsolidationPlan
} = require("../../core/consolidation/ConsolidationPlan");

function explicit(id, text = `synthetic-${id}`, extra = {}) {
  return {
    id,
    content: { text },
    memoryKind: "raw",
    storageTier: "warm",
    processingState: "raw",
    ...extra
  };
}

function clone(value) {
  return structuredClone(value);
}

function mutablePlan(plan) {
  return JSON.parse(JSON.stringify(plan));
}

test("exports the stable immutable FIX 5 vocabulary", () => {
  assert.deepEqual(CANDIDATE_DECISIONS, {
    ELIGIBLE: "eligible", EXCLUDED: "excluded", DEFERRED: "deferred"
  });
  for (const code of [
    "ELIGIBLE_EXPLICIT", "ELIGIBLE_LEGACY_OPT_IN", "INVALID_MEMORY",
    "MISSING_ID", "EMPTY_CONTENT", "DUPLICATE_ID", "DUPLICATE_CONTENT",
    "EXPLICIT_SUPER_MEMORY", "EXPLICIT_DEEP_TIER", "EXPLICIT_CONSOLIDATED",
    "EXPLICIT_SYNTHESIZING", "EXPLICIT_CANDIDATE_ALREADY_CLAIMED",
    "EXPLICIT_FAILED_REQUIRES_RETRY", "UNSUPPORTED_PROCESSING_STATE",
    "LEGACY_UNCLASSIFIED", "LIMIT_EXPLICITLY_APPLIED"
  ]) assert.equal(CANDIDATE_REASON_CODES[code], code);
  assert.deepEqual(DEFAULT_CANDIDATE_POLICY, {
    policyVersion: 1, allowLegacyUnclassified: false, maxCandidates: null
  });
  assert.equal(Object.isFrozen(DEFAULT_CANDIDATE_POLICY), true);
  assert.equal(CONSOLIDATION_PLAN_SCHEMA_VERSION, 1);
});

test("accepts arrays and object maps and makes map property order irrelevant", () => {
  const array = [explicit("b"), explicit("a")];
  const firstMap = { second: array[0], first: array[1] };
  const secondMap = { first: clone(array[1]), second: clone(array[0]) };
  assert.deepEqual(selectConsolidationCandidates(array).eligibleIds, ["a", "b"]);
  const first = buildConsolidationPlan(selectConsolidationCandidates(firstMap));
  const second = buildConsolidationPlan(selectConsolidationCandidates(secondMap));
  assert.deepStrictEqual(first, second);
  assert.equal(first.planId, second.planId);
});

test("normalizes flat, nested, hybrid and unknown memories", () => {
  const result = selectConsolidationCandidates([
    explicit("flat", "flat", { activation: 0 }),
    explicit("nested", "nested", { orbital: { level: "short" } }),
    explicit("hybrid", "hybrid", { activation: 0, orbital: { level: "long" } }),
    explicit("unknown", "unknown")
  ]);
  assert.deepEqual(result.decisions.map((item) => item.sourceContract), [
    "flat", "hybrid", "nested", "unknown"
  ]);
  assert.equal(result.stats.validCount, 4);
});

test("rejects invalid containers, ambiguous options, cycles and non-JSON-like values", () => {
  for (const value of [null, undefined, "x", 1, true, new Map()]) {
    assert.throws(() => selectConsolidationCandidates(value), TypeError);
  }
  const circular = { id: "cycle" };
  circular.self = circular;
  assert.throws(() => selectConsolidationCandidates([circular]), /circular/);
  assert.throws(() => selectConsolidationCandidates([{ id: "date", value: new Date(0) }]), /JSON-like/);
  assert.throws(() => selectConsolidationCandidates([explicit("x")], { maxCandidates: 0 }), /positive integer/);
  assert.throws(() => selectConsolidationCandidates([explicit("x")], { limit: 1 }), /Unsupported/);
});

test("classifies JSON-like non-memory entries without exposing their values", () => {
  const result = selectConsolidationCandidates([null, 7, "synthetic-private-marker"]);
  assert.equal(result.stats.validCount, 0);
  assert.deepEqual(result.decisions.map((item) => item.reasonCodes), [
    ["INVALID_MEMORY"], ["INVALID_MEMORY"], ["INVALID_MEMORY"]
  ]);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-private-marker/);
});

test("excludes missing IDs and absent, null or empty text", () => {
  const result = selectConsolidationCandidates([
    explicit("", "present"),
    { id: "absent", memoryKind: "raw", storageTier: "warm", processingState: "raw" },
    explicit("null", null),
    explicit("empty", "")
  ]);
  assert.equal(result.decisions.find((item) => item.memoryId === null).reasonCodes[0], "MISSING_ID");
  for (const id of ["absent", "null", "empty"]) {
    assert.equal(result.decisions.find((item) => item.memoryId === id).reasonCodes[0], "EMPTY_CONTENT");
  }
});

test("explicit exclusion signals are conservative and stable", () => {
  const cases = [
    explicit("super", "a", { memoryKind: "super_memory" }),
    explicit("deep", "b", { storageTier: "deep" }),
    explicit("done", "c", { processingState: "consolidated" }),
    explicit("busy", "d", { processingState: "synthesizing" })
  ];
  const result = selectConsolidationCandidates(cases);
  assert.deepEqual(result.decisions.map((item) => item.reasonCodes[0]), [
    "EXPLICIT_SYNTHESIZING", "EXPLICIT_DEEP_TIER", "EXPLICIT_CONSOLIDATED",
    "EXPLICIT_SUPER_MEMORY"
  ]);
  assert.equal(result.stats.excludedCount, 4);
});

test("legacy is deferred by default and eligible only through visible opt-in", () => {
  const memory = { id: "legacy", content: "synthetic legacy", activation: 0.2 };
  const before = clone(memory);
  const conservative = selectConsolidationCandidates([memory]);
  const optedIn = selectConsolidationCandidates([memory], { allowLegacyUnclassified: true });
  assert.equal(conservative.decisions[0].decision, "deferred");
  assert.deepEqual(conservative.decisions[0].reasonCodes, ["LEGACY_UNCLASSIFIED"]);
  assert.equal(optedIn.decisions[0].decision, "eligible");
  assert.deepEqual(optedIn.decisions[0].reasonCodes, ["ELIGIBLE_LEGACY_OPT_IN"]);
  assert.equal(optedIn.policy.allowLegacyUnclassified, true);
  assert.deepEqual(memory, before);
  assert.equal(Object.hasOwn(memory, "processingState"), false);
});

test("candidate and failed are deferred with explicit FIX 6 reasons", () => {
  const result = selectConsolidationCandidates([
    { id: "partial", content: "p", processingState: "candidate" },
    explicit("failed", "f", { processingState: "failed" })
  ]);
  assert.equal(result.decisions.every((item) => item.decision === "deferred"), true);
  assert.deepEqual(result.decisions.map((item) => item.reasonCodes[0]), [
    "EXPLICIT_FAILED_REQUIRES_RETRY", "EXPLICIT_CANDIDATE_ALREADY_CLAIMED"
  ]);
});

test("unknown processing state remains deferred with an explicit reason", () => {
  const result = selectConsolidationCandidates([
    explicit("unknown-state", "synthetic", { processingState: "RAW" })
  ]);
  assert.equal(result.decisions[0].decision, "deferred");
  assert.deepEqual(result.decisions[0].reasonCodes, ["UNSUPPORTED_PROCESSING_STATE"]);
});

test("has no default limit and includes 12 and 100 explicit candidates", () => {
  for (const size of [12, 100]) {
    const result = selectConsolidationCandidates(
      Array.from({ length: size }, (_, index) => explicit(`id-${String(index).padStart(3, "0")}`))
    );
    assert.equal(result.eligibleIds.length, size);
    assert.equal(result.stats.eligibleBeforeLimit, size);
    assert.equal(result.stats.eligibleIncluded, size);
    assert.equal(result.stats.truncated, false);
    assert.equal(result.policy.maxCandidates, null);
  }
});

test("explicit maxCandidates is validated, visible and explains overflow", () => {
  const result = selectConsolidationCandidates(
    Array.from({ length: 12 }, (_, index) => explicit(`limit-${index}`)),
    { maxCandidates: 5 }
  );
  assert.equal(result.policy.maxCandidates, 5);
  assert.equal(result.stats.eligibleBeforeLimit, 12);
  assert.equal(result.stats.eligibleIncluded, 5);
  assert.equal(result.stats.deferredCount, 7);
  assert.equal(result.stats.truncated, true);
  assert.equal(result.decisions.filter((item) => item.reasonCodes[0] === "LIMIT_EXPLICITLY_APPLIED").length, 7);
  const plan = buildConsolidationPlan(result);
  assert.equal(plan.policy.maxCandidates, 5);
  assert.equal(plan.stats.eligibleBeforeLimit, 12);
});

test("deduplicates IDs deterministically and counts each entry once", () => {
  const result = selectConsolidationCandidates([
    explicit("same", "first"), explicit("same", "second"), explicit("other", "third")
  ]);
  assert.equal(result.stats.duplicateIdCount, 1);
  assert.equal(result.stats.inputCount, 3);
  assert.equal(result.stats.eligibleIncluded + result.stats.excludedCount + result.stats.deferredCount, 3);
  assert.deepEqual(result.decisions.filter((item) => item.memoryId === "same").map((item) => item.reasonCodes[0]), [
    "ELIGIBLE_EXPLICIT", "DUPLICATE_ID"
  ]);
});

test("deduplicates only exact UTF-8 content with deterministic SHA-256", () => {
  const result = selectConsolidationCandidates([
    explicit("exact-a", "Exact  text"),
    explicit("exact-b", "Exact  text"),
    explicit("case", "exact  text"),
    explicit("space", "Exact text")
  ]);
  assert.equal(result.stats.duplicateContentCount, 1);
  assert.equal(result.decisions.find((item) => item.memoryId === "exact-b").reasonCodes[0], "DUPLICATE_CONTENT");
  assert.equal(result.decisions.find((item) => item.memoryId === "case").decision, "eligible");
  assert.equal(result.decisions.find((item) => item.memoryId === "space").decision, "eligible");
  assert.equal(
    result.decisions.find((item) => item.memoryId === "exact-a").contentHash,
    "fe9b857e064a7ac6ddb95e747985338d811f7f4d003914a04962f3fa016b8692"
  );
});

test("selection is deterministic, detached, deeply immutable and does not mutate input", () => {
  const input = [explicit("b", "private-b", { meta: { private: true } }), explicit("a", "private-a")];
  const before = clone(input);
  const first = selectConsolidationCandidates(input);
  const second = selectConsolidationCandidates(input);
  assert.deepStrictEqual(first, second);
  assert.deepEqual(input, before);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.decisions), true);
  assert.equal(Object.isFrozen(first.decisions[0].reasonCodes), true);
  assert.throws(() => { first.stats.inputCount = 99; }, TypeError);
  assert.throws(() => { first.decisions.push({}); }, TypeError);
  assert.notStrictEqual(first.policy, DEFAULT_CANDIDATE_POLICY);
});

test("plan is deterministic, dry-run, private, detached and deeply immutable", () => {
  const selection = selectConsolidationCandidates([
    explicit("private", "PRIVATE_SYNTHETIC_TEXT", {
      sourceSnapshot: { secret: true }, entities: ["PRIVATE_ENTITY"], meta: { private: true }
    })
  ]);
  const first = buildConsolidationPlan(selection);
  const second = buildConsolidationPlan(selection);
  assert.deepStrictEqual(first, second);
  assert.match(first.planId, /^[a-f0-9]{64}$/);
  assert.equal(first.dryRun, true);
  assert.doesNotMatch(JSON.stringify(first), /PRIVATE_SYNTHETIC_TEXT|PRIVATE_ENTITY|sourceSnapshot/);
  assert.notStrictEqual(first.decisions, selection.decisions);
  assert.notStrictEqual(first.policy, selection.policy);
  assert.equal(Object.isFrozen(first.decisions[0]), true);
  assert.throws(() => { first.candidateIds[0] = "changed"; }, TypeError);
});

test("rejects commit, writes, false dry-run and all execution options", () => {
  const selection = selectConsolidationCandidates([explicit("safe")]);
  for (const options of [{ commit: true }, { dryRun: false }, { writer() {} }, { storageWriter: {} }]) {
    assert.throws(() => buildConsolidationPlan(selection, options), /no execution options/);
  }
  const plan = mutablePlan(buildConsolidationPlan(selection));
  plan.dryRun = false;
  assert.equal(validateConsolidationPlan(plan).valid, false);
  plan.dryRun = true;
  plan.commit = true;
  assert.equal(validateConsolidationPlan(plan).valid, false);
});

test("validates a valid plan and rejects tampering, unknown reasons and bad stats", () => {
  const plan = buildConsolidationPlan(selectConsolidationCandidates([explicit("valid")]));
  assert.deepEqual(validateConsolidationPlan(plan), { valid: true, errors: [] });
  for (const mutate of [
    (copy) => { copy.candidateIds.push("intruder"); },
    (copy) => { copy.decisions[0].reasonCodes = ["UNKNOWN_REASON"]; },
    (copy) => { copy.stats.inputCount = 99; },
    (copy) => { copy.planId = "0".repeat(64); },
    (copy) => { copy.decisions[0].content = "forbidden"; }
  ]) {
    const copy = mutablePlan(plan);
    mutate(copy);
    assert.equal(validateConsolidationPlan(copy).valid, false);
  }
});

test("validator rejects circular references and functions without inspecting content", () => {
  const plan = mutablePlan(buildConsolidationPlan(selectConsolidationCandidates([explicit("valid")] )));
  plan.loop = plan;
  assert.equal(validateConsolidationPlan(plan).valid, false);
  delete plan.loop;
  plan.callback = () => undefined;
  assert.equal(validateConsolidationPlan(plan).valid, false);
});

test("FIX 5 modules import neither storage, fs, models nor clustering", () => {
  const root = path.join(__dirname, "..", "..", "core", "consolidation");
  for (const name of ["CandidateSelector.js", "ConsolidationPlan.js"]) {
    const source = fs.readFileSync(path.join(root, name), "utf8");
    assert.doesNotMatch(source, /require\(["'](?:node:)?fs["']\)/);
    assert.doesNotMatch(source, /JsonMemoryStorage|StorageCapabilityContract|Qwen|Ollama|ClusterEngine|Keblomemory/);
    assert.doesNotMatch(source, /Date\.now|new Date|Math\.random|randomUUID|slice\(0,\s*5\)/);
  }
});
