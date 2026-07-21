"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { KebloMemory, MemoryStorage } = require("../../core/Keblomemory.js");
const JsonMemoryStorage = require("../../core/JsonMemoryStorage.js");
const OrbitaleBridge = require("../../core/OrbitaleBridge.js");
const { createRecallRouter } = require("../../core/recall/RecallRouter.js");
const {
  LEGACY_DEEP_MEMORY_DEPTHS,
  classifyMemoryTier,
  matchesMemoryTier
} = require("../../core/recall/MemoryTierClassifier.js");
const { createLegacyRecallAdapter } = require("../../core/recall/LegacyRecallAdapter.js");
const { RECALL_COMMANDS, buildRecallRequest } = require("../../core/recall/RecallRequestBuilder.js");

const USER = "synthetic-user";

function memory(id, overrides = {}) {
  return {
    id,
    type: "episodic",
    content: { text: `topic ${id}` },
    activation: 0.4,
    orbitalState: 0.4,
    orbitalLevel: "medium",
    memoryDepth: "normal",
    timestamp: 1000,
    lastAccess: 1000,
    accessCount: 0,
    tags: [],
    ...overrides
  };
}

function superMemory(id = "sm-1", sourceIds = []) {
  return {
    schemaVersion: 1,
    id,
    type: "super_memory",
    memoryKind: "super_memory",
    storageTier: "core",
    source_memory_ids: sourceIds,
    content: { text: `topic synthesis ${id}` },
    timestamp: 1000
  };
}

async function setup(memories, links = [], Storage = MemoryStorage) {
  const storage = new Storage();
  await storage.saveMemories(USER, memories);
  await storage.saveLinks(USER, links);
  const kebloMemory = new KebloMemory({ storage });
  const adapter = createLegacyRecallAdapter({ kebloMemory, userId: USER });
  const router = createRecallRouter(adapter);
  kebloMemory.setRecallRouter(router);
  return { storage, kebloMemory, adapter, router };
}

test("classifier maps explicit core/warm/deep and rejects incompatible super-memory", () => {
  assert.equal(classifyMemoryTier(superMemory()).reasonCode, "EXPLICIT_CORE_SUPER_MEMORY");
  assert.equal(classifyMemoryTier(memory("w", { storageTier: "warm" })).tier, "warm");
  assert.equal(classifyMemoryTier(memory("d", { storageTier: "deep" })).tier, "deep");
  const incompatible = superMemory(); delete incompatible.storageTier;
  assert.deepEqual(classifyMemoryTier(incompatible), {
    tier: null, reasonCode: "INCOMPATIBLE_SUPER_MEMORY", legacyDerived: false, sourceContract: "flat"
  });
});

test("classifier maps legacy normal, temporary and core-depth to warm", () => {
  for (const depth of ["normal", "temporary", "core"]) {
    const classified = classifyMemoryTier(memory(depth, { memoryDepth: depth }));
    assert.equal(classified.tier, "warm");
    assert.equal(classified.reasonCode, "LEGACY_WARM");
    assert.equal(classified.legacyDerived, true);
  }
});

test("classifier maps only deep/historical depth to deep; orbital long remains warm", () => {
  assert.deepEqual(LEGACY_DEEP_MEMORY_DEPTHS, ["deep", "historical"]);
  assert.equal(classifyMemoryTier(memory("d", { memoryDepth: "deep" })).reasonCode, "LEGACY_DEEP_MEMORY_DEPTH");
  assert.equal(classifyMemoryTier(memory("h", { memoryDepth: "historical" })).reasonCode, "LEGACY_HISTORICAL_MEMORY_DEPTH");
  assert.equal(classifyMemoryTier(memory("long", { orbitalLevel: "long" })).tier, "warm");
});

test("classifier handles flat/nested/hybrid without mutation", () => {
  const flat = memory("flat");
  const nested = { id: "nested", type: "episodic", content: { text: "topic" }, orbital: { level: "long" } };
  const hybrid = { ...memory("hybrid"), orbital: { level: "long" } };
  const before = structuredClone([flat, nested, hybrid]);
  assert.equal(classifyMemoryTier(flat).sourceContract, "flat");
  assert.equal(classifyMemoryTier(nested).sourceContract, "nested");
  assert.equal(classifyMemoryTier(hybrid).sourceContract, "hybrid");
  assert.equal(matchesMemoryTier(nested, "warm"), true);
  assert.deepEqual([flat, nested, hybrid], before);
});

test("request builder defaults to core+warm contract and has no default five", () => {
  const request = buildRecallRequest({ query: "storico ieri ricordo", limit: 12 });
  assert.equal(request.mode, "default");
  assert.equal(request.includeDeep, false);
  assert.equal(request.limit, 12);
  assert.equal(request.deepFallback.enabled, false);
  assert.equal(Object.isFrozen(request), true);
});

test("request builder recognizes only explicit case-insensitive prefixes", () => {
  const cases = [
    ["cerca nello storico completo: progetto", "progetto"],
    ["CERCA IN TUTTA LA MEMORIA progetto", "progetto"],
    ["Search Full History - project", "project"]
  ];
  assert.equal(RECALL_COMMANDS.length, 3);
  for (const [query, expected] of cases) {
    const request = buildRecallRequest({ query, limit: 9 });
    assert.equal(request.query, expected);
    assert.equal(request.mode, "full-history");
    assert.equal(request.includeDeep, true);
  }
});

test("request builder supports API deep and explicit fallback", () => {
  const request = buildRecallRequest({ query: "topic", limit: 8, includeDeep: true, allowDeepFallback: true });
  assert.equal(request.includeDeep, true);
  assert.deepEqual(request.deepFallback, { enabled: true, minResults: 8, minBestScore: null });
});

test("request builder rejects missing limit and command without useful query", () => {
  assert.throws(() => buildRecallRequest({ query: "topic" }), { code: "INVALID_LIMIT" });
  assert.throws(() => buildRecallRequest({ query: "cerca in tutta la memoria: ", limit: 8 }), { code: "EMPTY_COMMAND_QUERY" });
});

test("adapter exposes three stable retrievers and always uses recallReadOnly", async () => {
  const calls = [];
  const adapter = createLegacyRecallAdapter({
    userId: USER,
    kebloMemory: {
      async recallReadOnly(userId, query, options) {
        calls.push({ userId, query, options });
        return [{ ...memory("w"), _score: 0.5 }];
      }
    }
  });
  const results = await adapter.warmRetriever.search({ query: "topic", tier: "warm", limit: 7, mutate: false });
  assert.equal(results[0].memory.storageTier, "warm");
  assert.equal(calls[0].options.tier, "warm");
  assert.equal(calls[0].options.limit, 7);
  assert.equal(calls[0].options.mutateOnRecall, undefined);
  await assert.rejects(adapter.warmRetriever.search({ query: "topic", tier: "warm", limit: 7, mutate: true }), { code: "INVALID_RETRIEVAL_REQUEST" });
});

test("default router retrieves core and warm but never historical/deep", async () => {
  const state = await setup([superMemory(), memory("warm"), memory("history", { memoryDepth: "historical" })]);
  const output = await state.router.recall(buildRecallRequest({ query: "topic", limit: 12 }));
  assert.deepEqual(output.results.map(({ retrievalTier }) => retrievalTier).sort(), ["core", "warm"]);
  assert.equal(output.routing.deepUsed, false);
});

test("full-history command and includeDeep API retrieve deep", async () => {
  const state = await setup([memory("warm"), memory("deep", { memoryDepth: "deep" })]);
  const command = await state.router.recall(buildRecallRequest({ query: "cerca nello storico completo topic", limit: 10 }));
  assert.equal(command.results.some(({ retrievalTier }) => retrievalTier === "deep"), true);
  const api = await state.router.recall(buildRecallRequest({ query: "topic", limit: 10, includeDeep: true }));
  assert.equal(api.routing.deepUsed, true);
});

test("warm link and Echo scoring cannot reintroduce a deep candidate", async () => {
  const links = [{ id: "l1", source: "warm", target: "deep", weight: 1, type: "semantic" }];
  const state = await setup([
    memory("warm", { content: { text: "topic mco" } }),
    memory("deep", { memoryDepth: "deep", content: { text: "topic mco" } })
  ], links);
  const warm = await state.kebloMemory.recallReadOnly(USER, "mco", { tier: "warm", limit: 10, includeLinks: true });
  assert.deepEqual(warm.map(({ id }) => id), ["warm"]);
  assert.equal(warm[0]._linkBoost, 0);
});

test("core retriever returns only core super-memory", async () => {
  const state = await setup([superMemory(), memory("fake-core", { storageTier: "core", memoryDepth: "core" })]);
  const results = await state.adapter.coreRetriever.search({ query: "topic", tier: "core", limit: 10, mutate: false });
  assert.deepEqual(results.map(({ id }) => id), ["sm-1"]);
});

test("router registration is idempotent for the same instance and rejects replacement", async () => {
  const state = await setup([memory("warm")]);
  assert.equal(state.kebloMemory.getRecallRouter(), state.router);
  assert.equal(state.kebloMemory.setRecallRouter(state.router), state.router);
  assert.throws(() => state.kebloMemory.setRecallRouter({ recall() {} }));
});

test("getContext uses registered router once and only final result text", async () => {
  const storage = new MemoryStorage();
  const kebloMemory = new KebloMemory({ storage });
  let calls = 0;
  kebloMemory.setRecallRouter({
    async recall() {
      calls += 1;
      return { results: [{ id: "selected", text: "selected text", finalScore: 0.7 }], reinforcementPendingIds: ["selected"] };
    }
  });
  kebloMemory.recall = async () => { throw new Error("legacy recall must not be called"); };
  const context = await kebloMemory.getContextForKeblo(USER, "topic", { limit: 9, reinforce: false });
  assert.equal(calls, 1);
  assert.deepEqual(context.relevant, [{ text: "selected text", score: "0.700" }]);
});

test("read-only retrieval does not mutate activation/access fields", async () => {
  const original = memory("warm");
  const state = await setup([original]);
  await state.router.recall(buildRecallRequest({ query: "topic", limit: 10 }));
  const stored = await state.storage.getMemory(USER, "warm");
  assert.equal(stored.activation, 0.4);
  assert.equal(stored.lastAccess, 1000);
  assert.equal(stored.accessCount, 0);
});

test("single reinforcement deduplicates IDs and applies legacy formula once", async () => {
  const state = await setup([memory("warm")]);
  const report = await state.kebloMemory.reinforceRecallSelection(USER, ["warm", "warm"]);
  const stored = await state.storage.getMemory(USER, "warm");
  assert.equal(report.reinforcedCount, 1);
  assert.ok(Math.abs(stored.activation - 0.43) < Number.EPSILON);
  assert.equal(stored.accessCount, 1);
  assert.notEqual(stored.lastAccess, 1000);
});

test("reinforcement excludes suppressed source and does not invent super-memory orbital fields", async () => {
  const state = await setup([superMemory("sm", ["raw"]), memory("raw")]);
  const output = await state.router.recall(buildRecallRequest({ query: "topic", limit: 10 }));
  assert.deepEqual(output.reinforcementPendingIds, ["sm"]);
  await state.kebloMemory.reinforceRecallSelection(USER, output.reinforcementPendingIds);
  const raw = await state.storage.getMemory(USER, "raw");
  const sm = await state.storage.getMemory(USER, "sm");
  assert.equal(raw.accessCount, 0);
  assert.equal(Object.hasOwn(sm, "activation"), false);
  assert.equal(Object.hasOwn(sm, "orbitalState"), false);
  assert.equal(Object.hasOwn(sm, "lastAccess"), false);
  assert.equal(Object.hasOwn(sm, "accessCount"), false);
});

test("reinforcement can be disabled", async () => {
  const state = await setup([memory("warm")]);
  const report = await state.kebloMemory.reinforceRecallSelection(USER, ["warm"], { enabled: false });
  assert.equal(report.saved, false);
  assert.equal((await state.storage.getMemory(USER, "warm")).accessCount, 0);
});

test("reinforcement uses one batch save", async () => {
  class CountingStorage extends MemoryStorage {
    constructor() { super(); this.batchSaves = 0; }
    async saveMemories(...args) { this.batchSaves += 1; return super.saveMemories(...args); }
  }
  const state = await setup([memory("a"), memory("b")], [], CountingStorage);
  state.storage.batchSaves = 0;
  await state.kebloMemory.reinforceRecallSelection(USER, ["a", "b"]);
  assert.equal(state.storage.batchSaves, 1);
});

test("reinforcement respects storage user lock and passes its handle", async () => {
  class LockingStorage extends MemoryStorage {
    constructor() { super(); this.lockCalls = 0; this.handleSeen = null; }
    async withUserLock(_userId, callback) { this.lockCalls += 1; return callback({ token: "synthetic" }); }
    async saveMemories(userId, memories, options) {
      this.handleSeen = options?.lockHandle || null;
      return super.saveMemories(userId, memories);
    }
  }
  const state = await setup([memory("a")], [], LockingStorage);
  state.storage.handleSeen = null;
  await state.kebloMemory.reinforceRecallSelection(USER, ["a"]);
  assert.equal(state.storage.lockCalls, 1);
  assert.deepEqual(state.storage.handleSeen, { token: "synthetic" });
});

test("JsonMemoryStorage reinforcement performs one locked synthetic batch in temp", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fix12-reinforce-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const storage = new JsonMemoryStorage(directory);
  await storage.saveMemories(USER, [memory("locked")]);
  const kebloMemory = new KebloMemory({ storage });
  await kebloMemory.reinforceRecallSelection(USER, ["locked"]);
  assert.equal((await storage.getMemory(USER, "locked")).accessCount, 1);
});

test("legacy recall preserves default mutation and mutateOnRecall false", async () => {
  const state = await setup([memory("legacy")]);
  await state.kebloMemory.recall(USER, "topic", { limit: 1, includeLinks: false });
  assert.equal((await state.storage.getMemory(USER, "legacy")).accessCount, 1);
  const before = await state.storage.getMemory(USER, "legacy");
  await state.kebloMemory.recall(USER, "topic", { limit: 1, includeLinks: false, mutateOnRecall: false });
  assert.equal((await state.storage.getMemory(USER, "legacy")).accessCount, before.accessCount);
});

test("router returns at least twelve warm results when requested", async () => {
  const state = await setup(Array.from({ length: 12 }, (_, index) => memory(`m-${index}`)));
  const output = await state.router.recall(buildRecallRequest({ query: "topic", limit: 12 }));
  assert.equal(output.results.length, 12);
});

test("chat source registers one router pipeline without second legacy recall", () => {
  const source = fs.readFileSync(path.join(__dirname, "../../chat_orbitale_ollama.js"), "utf8");
  assert.match(source, /const recallRouter = createRecallRouter\(recallAdapter\)/);
  assert.match(source, /memory\.setRecallRouter\(recallRouter\)/);
  assert.match(source, /await recallRouter\.recall\(buildRecallRequest/);
  assert.doesNotMatch(source, /Promise\.resolve\(memory\.recall/);
});

test("OrbitaleBridge uses one router pipeline and supports read-only final selection", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fix12-bridge-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const bridge = new OrbitaleBridge({ dataDir: directory });
  await bridge.memory.storage.saveMemories(USER, [memory("bridge")]);
  const results = await bridge.recall(USER, "topic", { limit: 12, reinforce: false });
  assert.equal(results.length, 1);
  assert.equal(bridge.memory.getRecallRouter(), bridge.recallRouter);
  assert.equal((await bridge.memory.storage.getMemory(USER, "bridge")).accessCount, 0);
});

test("integration modules contain no model, network, daemon or real-data access", () => {
  const files = ["MemoryTierClassifier.js", "LegacyRecallAdapter.js", "RecallRequestBuilder.js"];
  const source = files.map(file => fs.readFileSync(path.join(__dirname, "../../core/recall", file), "utf8")).join("\n");
  assert.doesNotMatch(source, /fetch\s*\(|Ollama|Qwen|Hippocampus|orbitale_chat_data|JsonMemoryStorage/);
});
