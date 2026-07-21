import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

import { createKebloUserRecallAdapter } from "../KebloReadOnlyRecallAdapter.js";
import { projectKebloLegacyFlatMemoryToWarm } from "../KebloLegacyFlatWarmProjection.js";
import { createKebloOrbitaleReadOnlyStorageReader } from "../KebloOrbitaleReadOnlyStorageReader.js";

const require = createRequire(import.meta.url);
const api = require("../../../../packages/memoria-orbitale");

function flat(id = "legacy", extra = {}) {
  return { id, type: "episodic", content: { text: "synthetic project" }, activation: 0.5,
    timestamp: 1, tags: ["synthetic"], ...extra };
}

async function fixture(t, records) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kint5e-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "alice_memories.json");
  const bytes = JSON.stringify(records, null, 2);
  await writeFile(file, bytes);
  return { dir, file, bytes };
}

function reader(baseDir, rankReadOnly = api.rankReadOnly) {
  return createKebloOrbitaleReadOnlyStorageReader({ userId: "alice", baseDir, rankReadOnly });
}

function request(tier = "warm") {
  return { schemaVersion: 1, userId: "alice", query: "synthetic", tier, limit: 6, mutate: false };
}

test("valid historical flat memory projects to a warm raw runtime copy without mutation", () => {
  const input = flat();
  const before = JSON.stringify(input);
  const output = projectKebloLegacyFlatMemoryToWarm(input, api);
  assert.equal(output.status, "projected");
  assert.equal(output.memory.memoryKind, "raw");
  assert.equal(output.memory.storageTier, "warm");
  assert.equal(output.memory.type, "episodic");
  assert.equal(output.memory.processing, undefined);
  assert.equal(JSON.stringify(input), before);
  for (const field of ["id", "content", "activation", "tags", "timestamp"]) {
    assert.deepEqual(output.memory[field], input[field]);
  }
});

test("reader projects only warm, preserves fixture bytes and exposes aggregate metrics", async (t) => {
  const { dir, file, bytes } = await fixture(t, [flat()]);
  const instance = reader(dir);
  assert.deepEqual(await instance.searchReadOnly(request("core")), []);
  const warm = await instance.searchReadOnly(request());
  assert.equal(warm.length, 1);
  assert.equal(warm[0].memory.memoryKind, "raw");
  assert.equal(warm[0].memory.storageTier, "warm");
  assert.deepEqual(instance.getMetrics(), { projectedFlatWarmCount: 1, rejectedFlatWarmCount: 0 });
  assert.equal(await readFile(file, "utf8"), bytes);
});

test("conflicts, incomplete SuperMemory and malformed records are rejected", async (t) => {
  const records = [
    flat("kind-conflict", { memoryKind: "invalid" }),
    flat("tier-conflict", { storageTier: "invalid" }),
    flat("super", { type: "super_memory", source_memory_ids: [] }),
    flat("activation", { activation: 2 }),
    { id: "malformed", content: { text: "synthetic" } }
  ];
  const { dir } = await fixture(t, records);
  const instance = reader(dir);
  assert.deepEqual(await instance.searchReadOnly(request()), []);
  assert.deepEqual(instance.getMetrics(), { projectedFlatWarmCount: 0, rejectedFlatWarmCount: 5 });
});

test("user isolation is enforced before projection", async (t) => {
  const { dir } = await fixture(t, [flat("own", { userId: "alice" }), flat("foreign", { userId: "bob" })]);
  const instance = reader(dir, ({ memories }) => memories.map((memory) => ({ id: memory.id, score: 1 })));
  const results = await instance.searchReadOnly(request());
  assert.equal(results.length, 1);
  assert.deepEqual(instance.getMetrics(), { projectedFlatWarmCount: 1, rejectedFlatWarmCount: 0 });
});

test("ranker receives projected records and adapter plus RecallRouter returns warm", async (t) => {
  const { dir } = await fixture(t, [flat()]);
  let received = 0;
  const instance = reader(dir, (input) => {
    if (input.tier === "warm") {
      received = input.memories.length;
      assert.equal(input.memories[0].memoryKind, "raw");
      assert.equal(input.memories[0].storageTier, "warm");
    } else {
      assert.equal(input.memories.length, 0);
    }
    return api.rankReadOnly(input);
  });
  const adapter = createKebloUserRecallAdapter({ userId: "alice", storageReader: instance });
  const output = await adapter.recall({ query: "synthetic", limit: 6 });
  assert.equal(received, 1);
  assert.equal(output.stats.coreReturned, 0);
  assert.equal(output.stats.warmReturned, 1);
  assert.equal(output.stats.finalCount, 1);
  assert.equal(output.results[0].retrievalTier, "warm");
});

test("read-only search creates no filesystem side effects", async (t) => {
  const { dir, file, bytes } = await fixture(t, [flat()]);
  const before = await readdir(dir);
  await reader(dir).searchReadOnly(request());
  assert.deepEqual(await readdir(dir), before);
  assert.equal(await readFile(file, "utf8"), bytes);
});
