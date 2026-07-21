import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  KebloReadOnlyRecallAdapterError,
  createKebloUserRecallAdapter
} from "../KebloReadOnlyRecallAdapter.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const adapterPath = path.resolve(here, "../KebloReadOnlyRecallAdapter.js");

function core(id, text, sourceIds = []) {
  return {
    id, type: "super_memory", memoryKind: "super_memory", storageTier: "core",
    content: { text }, timestamp: 100, processing: { state: "consolidated" },
    source_memory_ids: sourceIds
  };
}

function warm(id, text, extra = {}) {
  return {
    id, type: "episodic", memoryKind: "raw", storageTier: "warm",
    content: { text }, timestamp: 200, activation: 0.4, accessCount: 2,
    processingState: "raw", ...extra
  };
}

function syntheticReader(byUser, calls = []) {
  return {
    async searchReadOnly(request) {
      calls.push({ ...request });
      return (byUser[request.userId] || []).map((entry) => ({
        memory: structuredClone(entry.memory), score: entry.score
      }));
    }
  };
}

test("import and construction are lazy and missing storage fails closed", async () => {
  let reads = 0;
  const storageReader = { async searchReadOnly() { reads += 1; return []; } };
  const adapter = createKebloUserRecallAdapter({ userId: "user-a", storageReader });
  assert.equal(reads, 0);
  assert.equal(adapter.userId, "user-a");
  assert.throws(
    () => createKebloUserRecallAdapter({ userId: "user-a" }),
    (error) => error instanceof KebloReadOnlyRecallAdapterError && error.code === "MISSING_STORAGE_READER"
  );
  assert.throws(
    () => createKebloUserRecallAdapter({ userId: " " , storageReader }),
    (error) => error.code === "INVALID_USER_ID"
  );
});

test("two factories remain strictly isolated by their authenticated userId", async () => {
  const calls = [];
  const reader = syntheticReader({
    alice: [{ memory: warm("alice-memory", "alpha"), score: 0.8 }],
    bob: [{ memory: warm("bob-memory", "beta"), score: 0.9 }]
  }, calls);
  const alice = createKebloUserRecallAdapter({ userId: "alice", storageReader: reader });
  const bob = createKebloUserRecallAdapter({ userId: "bob", storageReader: reader });
  assert.deepEqual((await alice.recall({ query: "a", limit: 10 })).results.map(({ id }) => id), ["alice-memory"]);
  assert.deepEqual((await bob.recall({ query: "b", limit: 10 })).results.map(({ id }) => id), ["bob-memory"]);
  assert.deepEqual(new Set(calls.slice(0, 2).map(({ userId }) => userId)), new Set(["alice"]));
  assert.deepEqual(new Set(calls.slice(2).map(({ userId }) => userId)), new Set(["bob"]));
});

test("canonical mapping admits only valid core super-memory and warm raw", async () => {
  const reader = syntheticReader({ user: [
    { memory: core("super", "summary", ["raw-covered"]), score: 0.9 },
    { memory: warm("raw-covered", "source"), score: 0.8 },
    { memory: warm("raw", "warm text"), score: 0.7 },
    { memory: warm("semantic", "wrong kind", { memoryKind: "semantic" }), score: 1 },
    { memory: core("bad-super", "bad", ["x", "x"]), score: 1 }
  ] });
  const adapter = createKebloUserRecallAdapter({ userId: "user", storageReader: reader });
  const output = await adapter.recall({ query: "topic", limit: 10 });
  assert.deepEqual(output.results.map(({ id }) => id), ["super", "raw"]);
  assert.deepEqual(output.results.map(({ retrievalTier }) => retrievalTier), ["core", "warm"]);
  assert.equal(output.suppressed.some(({ id }) => id === "raw-covered"), true);
});

test("cross-tier duplicate content is removed by RecallRouter", async () => {
  const reader = syntheticReader({ user: [
    { memory: core("super", "same exact text"), score: 0.8 },
    { memory: warm("raw", "same exact text"), score: 0.8 }
  ] });
  const adapter = createKebloUserRecallAdapter({ userId: "user", storageReader: reader });
  const output = await adapter.recall({ query: "same", limit: 10 });
  assert.deepEqual(output.results.map(({ id }) => id), ["super"]);
  assert.equal(output.stats.duplicateContentCount, 1);
});

test("mutate false is preserved and true or absent is rejected", async () => {
  const calls = [];
  const adapter = createKebloUserRecallAdapter({
    userId: "user",
    storageReader: syntheticReader({ user: [{ memory: warm("raw", "text"), score: 0.5 }] }, calls)
  });
  await adapter.search({ query: "text", tier: "warm", limit: 3, mutate: false });
  assert.equal(calls[0].mutate, false);
  assert.throws(
    () => adapter.search({ query: "text", tier: "warm", limit: 3, mutate: true }),
    (error) => error.code === "MUTATION_FORBIDDEN"
  );
  assert.throws(
    () => adapter.search({ query: "text", tier: "warm", limit: 3 }),
    (error) => error.code === "MUTATION_FORBIDDEN"
  );
});

test("recall performs no writes, reinforcement, or input mutation", async () => {
  const source = warm("raw", "immutable", { lastAccess: 10, accessCount: 4 });
  const before = structuredClone(source);
  const counters = { write: 0, reinforce: 0 };
  const storageReader = {
    async searchReadOnly() { return [{ memory: source, score: 0.6 }]; },
    async saveMemory() { counters.write += 1; },
    async saveMemories() { counters.write += 1; },
    async reinforce() { counters.reinforce += 1; }
  };
  const adapter = createKebloUserRecallAdapter({ userId: "user", storageReader });
  const output = await adapter.recall({ query: "immutable", limit: 3 });
  assert.equal(output.readOnly, true);
  assert.equal(output.reinforcementApplied, false);
  assert.deepEqual(counters, { write: 0, reinforce: 0 });
  assert.deepEqual(source, before);
});

test("malformed records are excluded without contamination or sensitive metrics", async () => {
  const circular = warm("circular", "secret-circular");
  circular.loop = circular;
  const storageReader = {
    async searchReadOnly() {
      return [
        null,
        { memory: circular, score: 0.8 },
        { memory: warm("bad-score", "secret-score"), score: 2 },
        { memory: warm("valid", "public synthetic"), score: 0.4 }
      ];
    }
  };
  const adapter = createKebloUserRecallAdapter({ userId: "user", storageReader });
  const output = await adapter.recall({ query: "synthetic", limit: 5 });
  assert.deepEqual(output.results.map(({ id }) => id), ["valid"]);
  assert.deepEqual(Object.keys(adapter.getMetrics()).sort(), [
    "accepted", "excludedIncompatible", "excludedMalformed", "scanned", "schemaVersion", "searches"
  ]);
  assert.equal(JSON.stringify(adapter.getMetrics()).includes("secret"), false);
});

test("ESM adapter imports the CommonJS package without network or real-data access", () => {
  const probe = `
    import net from "node:net";
    net.connect = () => { throw new Error("network forbidden"); };
    net.createConnection = () => { throw new Error("network forbidden"); };
    const module = await import(process.argv[1]);
    let reads = 0;
    const instance = module.createKebloUserRecallAdapter({
      userId: "synthetic-user",
      storageReader: { async searchReadOnly() { reads += 1; return []; } }
    });
    if (reads !== 0 || instance.schemaVersion !== 1) process.exit(2);
  `;
  execFileSync(process.execPath, ["--input-type=module", "-e", probe, pathToFileURL(adapterPath).href], {
    stdio: "pipe"
  });
});

test("adapter source has no filesystem, conversation, daemon, provider, or network dependency", () => {
  const source = fs.readFileSync(adapterPath, "utf8");
  for (const forbidden of [
    "node:fs", "conversation.jsonl", "server.js", "Daemon", "Provider",
    "node:http", "node:https", "node:net", "process.env"
  ]) assert.equal(source.includes(forbidden), false, forbidden);
});
