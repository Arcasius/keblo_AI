"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { rankReadOnly } = require("../../index.js");
const modulePath = path.resolve(__dirname, "../../core/recall/OrbitalReadOnlyRanker.js");

function memory(id, text, activation = 0.4, extra = {}) {
  return { id, type: "episodic", content: { text }, activation, orbitalState: activation,
    orbitalLevel: "medium", timestamp: 100, lastAccess: 100, accessCount: 0,
    memoryKind: "raw", storageTier: "warm", processingState: "raw", tags: [], ...extra };
}

function input(memories, query = "orbital project", extra = {}) {
  return { schemaVersion: 1, userId: "synthetic-user", query, tier: "warm", limit: 10,
    memories, ...extra };
}

function freeze(value) {
  Object.freeze(value);
  for (const child of Object.values(value)) {
    if (child && typeof child === "object" && !Object.isFrozen(child)) freeze(child);
  }
  return value;
}

test("accepts the exact KINT-3A call and deep-frozen memories without mutation", () => {
  const request = freeze(input([memory("relevant", "orbital project details"),
    memory("other", "unrelated synthetic text")]));
  const before = JSON.stringify(request);
  const ranked = rankReadOnly(request);
  assert.deepEqual(ranked.map(({ id }) => id), ["relevant", "other"]);
  assert.equal(JSON.stringify(request), before);
  assert.equal(Object.isFrozen(ranked), true);
  for (const result of ranked) {
    assert.deepEqual(Object.keys(result).sort(), ["id", "score"]);
    assert.equal(Number.isFinite(result.score), true);
    assert.equal(result.score >= 0 && result.score <= 0.9, true);
  }
});

test("ranking and identity tie-break are deterministic", () => {
  const request = input([memory("zeta", "neutral text"), memory("alpha", "neutral text")], "absent");
  const first = rankReadOnly(request);
  const second = rankReadOnly(request);
  assert.deepEqual(first, second);
  assert.deepEqual(first.map(({ id }) => id), ["alpha", "zeta"]);
});

test("text relevance and activation preserve the existing recall weights", () => {
  const textual = rankReadOnly(input([
    memory("match", "unique subject explained", 0),
    memory("miss", "different material", 0)
  ], "unique subject"));
  assert.equal(textual[0].id, "match");
  assert.equal(textual[0].score > textual[1].score, true);
  assert.equal(textual[0].score > rankReadOnly(input([
    memory("match", "unique subject explained", 0)
  ], "absent query"))[0].score, true);

  const activation = rankReadOnly(input([
    memory("high", "neutral", 1), memory("low", "neutral", 0)
  ], "absent"));
  assert.deepEqual(activation.map(({ id }) => id), ["high", "low"]);
  assert.equal(activation[0].score, 0.26);
  assert.equal(activation[1].score, 0);
});

test("temporal fields have zero weight as in current recall", () => {
  const ranked = rankReadOnly(input([
    memory("newer", "neutral", 0.5, { timestamp: 9999, lastAccess: 9999 }),
    memory("older", "neutral", 0.5, { timestamp: 1, lastAccess: 1 })
  ], "absent"));
  assert.equal(ranked[0].score, ranked[1].score);
  assert.deepEqual(ranked.map(({ id }) => id), ["newer", "older"]);
});

test("empty query and malformed or incompatible records fail closed without sensitive errors", () => {
  assert.deepEqual(rankReadOnly(input([memory("secret-id", "secret-content")], "   ")), []);
  const ranked = rankReadOnly(input([
    null,
    memory("bad-number", "secret-number", Number.NaN),
    memory("wrong-tier", "secret-tier", 0.5, { storageTier: "core" }),
    memory("valid", "safe synthetic", 0.5)
  ], "absent"));
  assert.deepEqual(ranked.map(({ id }) => id), ["valid"]);
  assert.throws(() => rankReadOnly({ ...input([]), limit: 0 }), (error) =>
    error.code === "INVALID_RANK_REQUEST" && !/secret|synthetic-user|orbital/i.test(error.message));
});

test("ranker has no filesystem, network, provider, timer, or nondeterministic time dependency", () => {
  const source = fs.readFileSync(modulePath, "utf8");
  for (const forbidden of ["node:fs", "node:http", "node:https", "node:net", "fetch(",
    "Date.now", "setTimeout", "setInterval", "provider", "Qdrant", "embedding"]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
  const probe = `
    Date.now = () => { throw new Error("time forbidden"); };
    global.setTimeout = () => { throw new Error("timer forbidden"); };
    global.fetch = () => { throw new Error("network forbidden"); };
    const { rankReadOnly } = require(process.argv[1]);
    const result = rankReadOnly({ schemaVersion: 1, userId: "u", query: "q", tier: "warm", limit: 1,
      memories: [{ id: "m", content: { text: "q" }, activation: 0, timestamp: 1,
        memoryKind: "raw", storageTier: "warm" }] });
    if (result.length !== 1) process.exit(2);
  `;
  execFileSync(process.execPath, ["-e", probe, modulePath], { stdio: "pipe" });
});
