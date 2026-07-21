"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  RECALL_ROUTER_SCHEMA_VERSION,
  RECALL_MODES,
  RECALL_TIERS,
  RECALL_REASON_CODES,
  DEFAULT_RECALL_POLICY,
  RecallRouterError,
  createRecallRouter
} = require("../../core/recall/RecallRouter");

function coreMemory(id = "sm_1", text = "Synthetic super memory", sourceIds = []) {
  return {
    id,
    type: "super_memory",
    content: { text },
    memoryKind: "super_memory",
    storageTier: "core",
    processing: { state: "consolidated" },
    source_memory_ids: sourceIds,
    timestamp: 100
  };
}

function warmMemory(id = "warm_1", text = "Synthetic warm memory", extra = {}) {
  return {
    id,
    type: "episodic",
    content: { text },
    memoryKind: "raw",
    storageTier: "warm",
    timestamp: 200,
    activation: 0.4,
    lastAccess: 201,
    accessCount: 3,
    ...extra
  };
}

function deepMemory(id = "deep_1", text = "Synthetic deep memory", extra = {}) {
  return {
    id,
    type: "episodic",
    content: { text },
    memoryKind: "raw",
    storageTier: "deep",
    timestamp: 50,
    ...extra
  };
}

function result(memory, score, tier) {
  return { id: memory.id, score, retrievalTier: tier, memory };
}

function retriever(id, implementation = async () => []) {
  const calls = [];
  const value = {
    schemaVersion: 1,
    id,
    async search(input) {
      calls.push(input);
      return implementation(input);
    }
  };
  Object.defineProperty(value, "calls", { value: calls, enumerable: false });
  return value;
}

function router({ core = [], warm = [], deep, policy, coreImpl, warmImpl, deepImpl } = {}) {
  const coreRetriever = retriever("core-r", coreImpl || (async () => core));
  const warmRetriever = retriever("warm-r", warmImpl || (async () => warm));
  const deepRetriever = deep === undefined && !deepImpl
    ? undefined
    : retriever("deep-r", deepImpl || (async () => deep));
  return {
    instance: createRecallRouter({ coreRetriever, warmRetriever, ...(deepRetriever ? { deepRetriever } : {}), ...(policy ? { policy } : {}) }),
    coreRetriever,
    warmRetriever,
    deepRetriever
  };
}

function request(overrides = {}) {
  return { query: "Synthetic Query", limit: 20, ...overrides };
}

function mutable(value) {
  return structuredClone(value);
}

test("exports stable immutable FIX 11 vocabulary and policy", () => {
  assert.equal(RECALL_ROUTER_SCHEMA_VERSION, 1);
  assert.deepEqual(RECALL_MODES, { DEFAULT: "default", FULL_HISTORY: "full-history" });
  assert.deepEqual(RECALL_TIERS, { CORE: "core", WARM: "warm", DEEP: "deep" });
  for (const code of [
    "CORE_SELECTED", "WARM_SELECTED", "DEEP_EXPLICIT", "DEEP_FULL_HISTORY",
    "DEEP_FALLBACK_LOW_COUNT", "DEEP_FALLBACK_LOW_SCORE", "DEEP_NOT_REQUESTED",
    "INVALID_RESULT", "INVALID_SCORE", "TIER_MISMATCH", "INCOMPATIBLE_MEMORY_KIND",
    "DUPLICATE_ID_SUPPRESSED", "DUPLICATE_CONTENT_SUPPRESSED",
    "SOURCE_COVERED_BY_SUPER_MEMORY", "FINAL_LIMIT_APPLIED"
  ]) assert.equal(RECALL_REASON_CODES[code], code);
  assert.deepEqual(DEFAULT_RECALL_POLICY, { schemaVersion: 1, suppressCoveredSources: true });
  assert.equal(Object.isFrozen(DEFAULT_RECALL_POLICY), true);
});

test("requires valid explicit core and warm retrievers while deep remains optional", () => {
  const valid = retriever("valid");
  assert.throws(() => createRecallRouter({ warmRetriever: valid }), { code: "MISSING_RETRIEVER" });
  assert.throws(() => createRecallRouter({ coreRetriever: valid }), { code: "MISSING_RETRIEVER" });
  for (const bad of [
    {},
    { schemaVersion: 2, id: "x", search() {} },
    { schemaVersion: 1, id: "", search() {} },
    { schemaVersion: 1, id: "x", search: true }
  ]) assert.throws(() => createRecallRouter({ coreRetriever: bad, warmRetriever: valid }), RecallRouterError);
  assert.doesNotThrow(() => createRecallRouter({ coreRetriever: valid, warmRetriever: retriever("warm") }));
});

test("strictly validates query, mode, includeDeep, limit and closed request properties", async () => {
  const { instance } = router();
  for (const input of [
    null, {}, { query: "", limit: 1 }, { query: "x" },
    { query: "x", limit: 0 }, { query: "x", limit: 1, mode: "all" },
    { query: "x", limit: 1, includeDeep: "yes" }, { query: "x", limit: 1, command: "history" }
  ]) await assert.rejects(instance.recall(input), { code: "INVALID_REQUEST" });
});

test("default route invokes core and warm in parallel, never deep, always mutate false", async () => {
  const core = [result(coreMemory(), 0.8, "core")];
  const warm = [result(warmMemory(), 0.7, "warm")];
  const setup = router({ core, warm, deep: [result(deepMemory(), 1, "deep")] });
  const output = await setup.instance.recall(request());
  assert.equal(setup.coreRetriever.calls.length, 1);
  assert.equal(setup.warmRetriever.calls.length, 1);
  assert.equal(setup.deepRetriever.calls.length, 0);
  for (const call of [setup.coreRetriever.calls[0], setup.warmRetriever.calls[0]]) {
    assert.deepEqual(Object.keys(call).sort(), ["filters", "limit", "mutate", "query", "tier"]);
    assert.equal(call.mutate, false);
    assert.equal(call.query, "Synthetic Query");
    assert.equal(call.limit, 20);
  }
  assert.deepEqual(output.routing.invokedTiers, ["core", "warm"]);
  assert.deepEqual(output.routing.deepReasonCodes, ["DEEP_NOT_REQUESTED"]);
});

test("includeDeep and full-history explicitly invoke deep with distinct reasons", async () => {
  for (const [options, reason] of [
    [{ includeDeep: true }, "DEEP_EXPLICIT"],
    [{ mode: "full-history" }, "DEEP_FULL_HISTORY"]
  ]) {
    const setup = router({ deep: [result(deepMemory(), 0.9, "deep")] });
    const output = await setup.instance.recall(request(options));
    assert.equal(setup.deepRetriever.calls.length, 1);
    assert.equal(setup.deepRetriever.calls[0].mutate, false);
    assert.deepEqual(output.routing.requestedTiers, ["core", "warm", "deep"]);
    assert.deepEqual(output.routing.deepReasonCodes, [reason]);
  }
});

test("explicit deep without retriever fails before any search", async () => {
  const setup = router();
  await assert.rejects(setup.instance.recall(request({ includeDeep: true })), { code: "MISSING_DEEP_RETRIEVER" });
  assert.equal(setup.coreRetriever.calls.length, 0);
  assert.equal(setup.warmRetriever.calls.length, 0);
});

test("deep fallback is disabled by default and validates explicit thresholds", async () => {
  const setup = router({ deep: [result(deepMemory(), 1, "deep")] });
  await setup.instance.recall(request());
  assert.equal(setup.deepRetriever.calls.length, 0);
  for (const deepFallback of [
    { enabled: true }, { enabled: true, minResults: 0 },
    { enabled: true, minBestScore: 2 }, { enabled: "yes", minResults: 1 }
  ]) await assert.rejects(setup.instance.recall(request({ deepFallback })), { code: "INVALID_REQUEST" });
});

test("fallback invokes deep only for low count or low best score and records reasons", async () => {
  const warm = [result(warmMemory(), 0.4, "warm")];
  const setup = router({ warm, deep: [result(deepMemory(), 0.7, "deep")] });
  const output = await setup.instance.recall(request({
    deepFallback: { enabled: true, minResults: 3, minBestScore: 0.5 }
  }));
  assert.equal(setup.deepRetriever.calls.length, 1);
  assert.deepEqual(output.routing.deepReasonCodes, ["DEEP_FALLBACK_LOW_COUNT", "DEEP_FALLBACK_LOW_SCORE"]);
  assert.equal(output.routing.deepRequested, false);
  assert.equal(output.routing.deepUsed, true);
});

test("fallback stays inactive when thresholds pass", async () => {
  const setup = router({
    core: [result(coreMemory(), 0.9, "core")],
    warm: [result(warmMemory(), 0.8, "warm")],
    deep: [result(deepMemory(), 1, "deep")]
  });
  const output = await setup.instance.recall(request({
    deepFallback: { enabled: true, minResults: 2, minBestScore: 0.8 }
  }));
  assert.equal(setup.deepRetriever.calls.length, 0);
  assert.deepEqual(output.routing.deepReasonCodes, ["DEEP_NOT_REQUESTED"]);
});

test("fallback failure preserves core/warm while explicit deep failure fails closed", async () => {
  const fallback = router({
    warm: [result(warmMemory(), 0.6, "warm")],
    deepImpl: async () => { throw new Error("PRIVATE DEEP PAYLOAD"); }
  });
  const output = await fallback.instance.recall(request({ deepFallback: { enabled: true, minResults: 2 } }));
  assert.deepEqual(output.results.map(({ id }) => id), ["warm_1"]);
  assert.equal(output.invalidResults[0].code, "RETRIEVER_FAILURE");
  assert.doesNotMatch(JSON.stringify(output), /PRIVATE DEEP PAYLOAD/);
  const explicit = router({ deepImpl: async () => { throw new Error("PRIVATE DEEP PAYLOAD"); } });
  await assert.rejects(explicit.instance.recall(request({ includeDeep: true })), (error) => {
    assert.equal(error.code, "RETRIEVER_FAILURE");
    assert.doesNotMatch(error.message, /PRIVATE DEEP PAYLOAD/);
    return true;
  });
});

test("normalizes flat, nested and hybrid memory results", async () => {
  const memories = [
    warmMemory("flat", "flat", { activation: 0 }),
    warmMemory("nested", "nested", { activation: undefined, orbital: { level: "short" } }),
    warmMemory("hybrid", "hybrid", { activation: 0, orbital: { level: "long" } })
  ];
  delete memories[1].activation;
  const setup = router({ warm: memories.map((memory, index) => result(memory, 0.6 + index * 0.1, "warm")) });
  const output = await setup.instance.recall(request());
  assert.deepEqual(output.results.map(({ id }) => id), ["hybrid", "nested", "flat"]);
  assert.equal(output.results.every((item) => !Object.hasOwn(item, "sourceSnapshot")), true);
});

test("accepts score boundaries and excludes invalid finite/range scores with reasons", async () => {
  const items = [
    result(warmMemory("zero", "zero"), 0, "warm"),
    result(warmMemory("one", "one"), 1, "warm"),
    result(warmMemory("negative", "negative"), -0.1, "warm"),
    result(warmMemory("high", "high"), 1.1, "warm"),
    result(warmMemory("nan", "nan"), NaN, "warm"),
    result(warmMemory("inf", "inf"), Infinity, "warm")
  ];
  const output = await router({ warm: items }).instance.recall(request());
  assert.deepEqual(output.results.map(({ id }) => id), ["one", "zero"]);
  assert.equal(output.invalidResults.length, 4);
  assert.equal(output.invalidResults.every(({ reasonCode }) => reasonCode === "INVALID_SCORE"), true);
});

test("excludes tier mismatch and incompatible kinds without reclassification", async () => {
  const setup = router({
    core: [
      result(coreMemory("wrong-tier"), 0.9, "deep"),
      result(warmMemory("not-super", "x", { storageTier: "core" }), 0.8, "core"),
      result({ ...coreMemory("not-core"), storageTier: "warm" }, 0.7, "core")
    ],
    warm: [result(warmMemory("not-warm", "x", { storageTier: "deep" }), 0.8, "warm")],
    deep: [result(deepMemory("not-deep", "x", { storageTier: "warm" }), 0.8, "deep")]
  });
  const output = await setup.instance.recall(request({ includeDeep: true }));
  assert.equal(output.results.length, 0);
  assert.equal(output.invalidResults.some(({ reasonCode }) => reasonCode === "TIER_MISMATCH"), true);
  assert.equal(output.invalidResults.some(({ reasonCode }) => reasonCode === "INCOMPATIBLE_MEMORY_KIND"), true);
});

test("a deep result cannot leak through core or warm in default mode", async () => {
  const output = await router({
    warm: [result(deepMemory("leak"), 1, "deep")]
  }).instance.recall(request());
  assert.equal(output.results.length, 0);
  assert.equal(output.invalidResults[0].reasonCode, "TIER_MISMATCH");
  assert.equal(output.routing.deepUsed, false);
});

test("deduplicates IDs by score then tier and records suppressed entries", async () => {
  const output = await router({
    core: [result(coreMemory("same", "core text"), 0.7, "core")],
    warm: [result(warmMemory("same", "warm text"), 0.8, "warm")]
  }).instance.recall(request());
  assert.equal(output.results[0].text, "warm text");
  assert.equal(output.stats.duplicateIdCount, 1);
  assert.equal(output.suppressed[0].reasonCode, "DUPLICATE_ID_SUPPRESSED");
  const tied = await router({
    core: [result(coreMemory("same", "core text"), 0.8, "core")],
    warm: [result(warmMemory("same", "warm text"), 0.8, "warm")]
  }).instance.recall(request());
  assert.equal(tied.results[0].retrievalTier, "core");
});

test("deduplicates exact UTF-8 content but preserves similar text", async () => {
  const output = await router({ warm: [
    result(warmMemory("a", "Exact  Text"), 0.9, "warm"),
    result(warmMemory("b", "Exact  Text"), 0.8, "warm"),
    result(warmMemory("c", "exact  text"), 0.7, "warm"),
    result(warmMemory("d", "Exact Text"), 0.6, "warm")
  ] }).instance.recall(request());
  assert.deepEqual(output.results.map(({ id }) => id), ["a", "c", "d"]);
  assert.equal(output.stats.duplicateContentCount, 1);
});

test("selected super-memory suppresses covered raw sources by default", async () => {
  const output = await router({
    core: [result(coreMemory("sm", "summary", ["raw-a", "raw-b"]), 0.8, "core")],
    warm: [
      result(warmMemory("raw-a", "raw a"), 0.95, "warm"),
      result(warmMemory("other", "other"), 0.7, "warm")
    ],
    deep: [result(deepMemory("raw-b", "raw b"), 1, "deep")]
  }).instance.recall(request({ includeDeep: true }));
  assert.deepEqual(output.results.map(({ id }) => id), ["sm", "other"]);
  assert.equal(output.stats.coveredSourceCount, 2);
  assert.equal(output.suppressed.filter(({ reasonCode }) => reasonCode === "SOURCE_COVERED_BY_SUPER_MEMORY").length, 2);
  assert.doesNotMatch(JSON.stringify(output.suppressed), /raw a|raw b/);
});

test("covered-source suppression is explicitly disableable", async () => {
  const output = await router({
    policy: { suppressCoveredSources: false },
    core: [result(coreMemory("sm", "summary", ["raw"]), 0.7, "core")],
    warm: [result(warmMemory("raw", "raw"), 0.9, "warm")]
  }).instance.recall(request());
  assert.deepEqual(output.results.map(({ id }) => id), ["raw", "sm"]);
  assert.equal(output.routing.suppressCoveredSources, false);
  assert.equal(output.stats.coveredSourceCount, 0);
});

test("ranking uses score only, then core/warm/deep tie priority", async () => {
  const output = await router({
    core: [result(coreMemory("core", "core"), 0.7, "core")],
    warm: [result(warmMemory("warm-high", "warm high"), 0.9, "warm"), result(warmMemory("warm-tie", "warm tie"), 0.7, "warm")],
    deep: [result(deepMemory("deep-tie", "deep tie"), 0.7, "deep")]
  }).instance.recall(request({ includeDeep: true }));
  assert.deepEqual(output.results.map(({ id }) => id), ["warm-high", "core", "warm-tie", "deep-tie"]);
  assert.equal(output.results.every(({ score, finalScore }) => score === finalScore), true);
});

test("async completion order does not affect deterministic output", async () => {
  function delayed(value, turns) {
    return async () => {
      for (let index = 0; index < turns; index += 1) await new Promise((resolve) => setImmediate(resolve));
      return value;
    };
  }
  const core = [result(coreMemory(), 0.8, "core")];
  const warm = [result(warmMemory(), 0.7, "warm")];
  const first = router({ coreImpl: delayed(core, 2), warmImpl: delayed(warm, 0) });
  const second = router({ coreImpl: delayed(core, 0), warmImpl: delayed(warm, 2) });
  assert.deepStrictEqual(await first.instance.recall(request()), await second.instance.recall(request()));
});

test("final limit applies after ranking, reports truncation, and has no implicit five", async () => {
  const warm = Array.from({ length: 12 }, (_, index) =>
    result(warmMemory(`w${String(index).padStart(2, "0")}`, `text-${index}`), 1 - index / 20, "warm")
  );
  const all = await router({ warm }).instance.recall(request({ limit: 12 }));
  assert.equal(all.results.length, 12);
  assert.equal(all.routing.truncated, false);
  const limited = await router({ warm }).instance.recall(request({ limit: 7 }));
  assert.equal(limited.results.length, 7);
  assert.equal(limited.routing.truncated, true);
  assert.equal(limited.stats.beforeFinalLimit, 12);
  assert.equal(limited.suppressed.filter(({ reasonCode }) => reasonCode === "FINAL_LIMIT_APPLIED").length, 5);
});

test("is read-only and never mutates access, activation, request, retriever or backend results", async () => {
  let methodCalls = 0;
  const memory = warmMemory("readonly", "readonly");
  Object.defineProperty(memory, "updateAccess", { value: () => { methodCalls += 1; }, enumerable: false });
  const backend = [result(memory, 0.8, "warm")];
  const input = request();
  const beforeInput = mutable(input);
  const beforeBackend = mutable(backend);
  const setup = router({ warm: backend });
  const output = await setup.instance.recall(input);
  assert.deepEqual(input, beforeInput);
  assert.deepEqual(backend, beforeBackend);
  assert.equal(memory.activation, 0.4);
  assert.equal(memory.lastAccess, 201);
  assert.equal(memory.accessCount, 3);
  assert.equal(methodCalls, 0);
  assert.equal(output.readOnly, true);
  assert.equal(output.reinforcementApplied, false);
  assert.deepEqual(output.reinforcementPendingIds, ["readonly"]);
});

test("returns minimal detached deeply frozen views with coherent stats", async () => {
  const backendMemory = warmMemory("minimal", "minimal", { sourceSnapshot: { private: true }, meta: { private: true } });
  const output = await router({ warm: [result(backendMemory, 0.8, "warm")] }).instance.recall(request());
  assert.deepEqual(Object.keys(output.results[0]).sort(), [
    "contentHash", "finalScore", "id", "memoryKind", "reasonCodes", "retrievalTier",
    "retrieverId", "score", "sourceMemoryIds", "storageTier", "text", "timestamp"
  ]);
  assert.doesNotMatch(JSON.stringify(output), /sourceSnapshot|private|activation|lastAccess|accessCount/);
  assert.equal(Object.isFrozen(output), true);
  assert.equal(Object.isFrozen(output.results[0]), true);
  assert.throws(() => { output.results[0].score = 0; }, TypeError);
  assert.deepEqual(output.stats, {
    coreReturned: 0, warmReturned: 1, deepReturned: 0, validBeforeDedupe: 1,
    duplicateIdCount: 0, duplicateContentCount: 0, coveredSourceCount: 0,
    beforeFinalLimit: 1, finalCount: 1
  });
});

test("repeated calls with identical inputs are deepStrictEqual", async () => {
  const setup = router({ core: [result(coreMemory(), 0.8, "core")], warm: [result(warmMemory(), 0.7, "warm")] });
  assert.deepStrictEqual(await setup.instance.recall(request()), await setup.instance.recall(request()));
});

test("core/warm failures fail closed with sanitized tier-aware errors", async () => {
  for (const tier of ["core", "warm"]) {
    const setup = router({
      ...(tier === "core" ? { coreImpl: async () => { throw new Error("PRIVATE MEMORY CONTENT"); } } : {}),
      ...(tier === "warm" ? { warmImpl: async () => { throw new Error("PRIVATE MEMORY CONTENT"); } } : {})
    });
    await assert.rejects(setup.instance.recall(request()), (error) => {
      assert.equal(error.code, "RETRIEVER_FAILURE");
      assert.equal(error.tier, tier);
      assert.doesNotMatch(error.message, /PRIVATE MEMORY CONTENT/);
      return true;
    });
  }
});

test("FIX 11 imports no storage, runtime, filesystem, models or network", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "..", "core", "recall", "RecallRouter.js"), "utf8");
  assert.doesNotMatch(source, /JsonMemoryStorage|KebloMemory|Keblomemory|Qdrant|Qwen|Ollama|fetch\s*\(/);
  assert.doesNotMatch(source, /require\(["'](?:node:)?fs["']\)|saveMemory\s*\(|updateAccess\s*\(|\breinforce\s*\(|activationEngine/);
  assert.doesNotMatch(source, /Date\.now|Math\.random|randomUUID/);
});
