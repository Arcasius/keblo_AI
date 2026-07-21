import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createKebloUserRecallAdapter } from "../KebloReadOnlyRecallAdapter.js";
import {
  KebloOrbitaleReadOnlyStorageReaderError,
  createKebloOrbitaleReadOnlyStorageReader
} from "../KebloOrbitaleReadOnlyStorageReader.js";

const sourcePath = fileURLToPath(new URL("../KebloOrbitaleReadOnlyStorageReader.js", import.meta.url));
const rankReadOnly = ({ memories }) => memories
  .map((memory) => ({ id: memory.id, score: memory.rank }))
  .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));

function warm(id, text, rank, userId = undefined, extra = {}) {
  return { id, type: "episodic", memoryKind: "raw", storageTier: "warm", content: { text },
    timestamp: 1, activation: 0.4, accessCount: 0, processingState: "raw", rank, userId, ...extra };
}

function core(id, text, rank, sources = []) {
  return { id, type: "super_memory", memoryKind: "super_memory", storageTier: "core",
    content: { text }, timestamp: 1, activation: 0.4, processing: { state: "consolidated" },
    source_memory_ids: sources, rank };
}

async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kint3a-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function reader(baseDir, userId = "alice", options = {}) {
  return createKebloOrbitaleReadOnlyStorageReader({ baseDir, userId, rankReadOnly, ...options });
}

function request(userId = "alice", tier = "warm", limit = 10, mutate = false) {
  return { schemaVersion: 1, userId, query: "synthetic", tier, limit, mutate };
}

test("import and construction are lazy", async (t) => {
  const dir = await tempDir(t);
  const before = await readdir(dir);
  const instance = reader(dir);
  assert.equal(instance.userId, "alice");
  assert.deepEqual(await readdir(dir), before);
});

test("missing file returns empty and leaves directory byte-for-byte unchanged", async (t) => {
  const dir = await tempDir(t);
  await writeFile(path.join(dir, "sentinel"), "same");
  const before = await readdir(dir);
  assert.deepEqual(await reader(dir).searchReadOnly(request()), []);
  assert.deepEqual(await readdir(dir), before);
  assert.equal(await readFile(path.join(dir, "sentinel"), "utf8"), "same");
});

test("user scope and path validation prevent traversal and fallback", async (t) => {
  const dir = await tempDir(t);
  await writeFile(path.join(dir, "alice_memories.json"), JSON.stringify([warm("a", "alice", 0.8)]));
  await writeFile(path.join(dir, "bob_memories.json"), JSON.stringify([warm("b", "bob", 0.9)]));
  assert.deepEqual((await reader(dir).searchReadOnly(request())).map(({ memory }) => memory.id), ["a"]);
  await assert.rejects(() => reader(dir).searchReadOnly(request("bob")), (error) => error.code === "USER_SCOPE_VIOLATION");
  assert.throws(() => reader(dir, "../bob"), (error) => error.code === "INVALID_USER_ID");
  assert.throws(() => reader(dir, "a/b"), (error) => error.code === "INVALID_USER_ID");
});

test("object and array documents separate valid core and warm records", async (t) => {
  const dir = await tempDir(t);
  const records = [core("super", "summary", 0.9, ["source"]), warm("source", "raw", 0.8),
    warm("foreign", "other", 1, "bob"), warm("wrong", "wrong tier", 1, undefined, { storageTier: "core" })];
  await writeFile(path.join(dir, "alice_memories.json"), JSON.stringify(Object.fromEntries(records.map((m) => [m.id, m]))));
  assert.deepEqual((await reader(dir).searchReadOnly(request("alice", "core"))).map(({ memory }) => memory.id), ["super"]);
  assert.deepEqual((await reader(dir).searchReadOnly(request())).map(({ memory }) => memory.id), ["source"]);
  await writeFile(path.join(dir, "alice_memories.json"), JSON.stringify(records));
  assert.deepEqual((await reader(dir).searchReadOnly(request())).map(({ memory }) => memory.id), ["source"]);
});

test("corrupt JSON, invalid shape and oversize fail closed with sanitized errors", async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, "alice_memories.json");
  await writeFile(file, "{secret-broken");
  await assert.rejects(() => reader(dir).searchReadOnly(request()), (error) =>
    error instanceof KebloOrbitaleReadOnlyStorageReaderError && error.code === "INVALID_STORAGE_JSON" &&
    !error.message.includes("secret") && !error.message.includes(file));
  await writeFile(file, "42");
  await assert.rejects(() => reader(dir).searchReadOnly(request()), (error) => error.code === "INVALID_STORAGE_SHAPE");
  await writeFile(file, "[] ");
  await assert.rejects(() => reader(dir, "alice", { maxBytes: 2 }).searchReadOnly(request()),
    (error) => error.code === "STORAGE_TOO_LARGE");
});

test("mutate true or absent is rejected before filesystem access", async (t) => {
  const dir = await tempDir(t);
  const instance = reader(dir);
  await assert.rejects(() => instance.searchReadOnly(request("alice", "warm", 10, true)),
    (error) => error.code === "MUTATION_FORBIDDEN");
  const absent = request(); delete absent.mutate;
  await assert.rejects(() => instance.searchReadOnly(absent), (error) => error.code === "MUTATION_FORBIDDEN");
  assert.deepEqual(await readdir(dir), []);
});

test("search neither writes nor mutates fixture bytes or ranker objects", async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, "alice_memories.json");
  const fixture = JSON.stringify([warm("one", "immutable", 0.7)], null, 2);
  await writeFile(file, fixture);
  const instance = reader(dir, "alice", { rankReadOnly: ({ memories }) => {
    assert.equal(Object.isFrozen(memories), true);
    assert.equal(Object.isFrozen(memories[0]), true);
    assert.throws(() => { memories[0].accessCount = 99; }, TypeError);
    return [{ id: "one", score: 0.7 }];
  } });
  assert.equal((await instance.searchReadOnly(request()))[0].memory.accessCount, 0);
  assert.equal(await readFile(file, "utf8"), fixture);
  for (const forbidden of ["writeFile", "appendFile", "rename", "mkdir", "lock", "atomic"]) {
    assert.equal(fs.readFileSync(sourcePath, "utf8").includes(forbidden), false, forbidden);
  }
});

test("reader composes through KINT-2 and RecallRouter with deterministic dedupe and limit", async (t) => {
  const dir = await tempDir(t);
  const records = [core("super", "summary", 0.9, ["covered"]),
    core("core-a", "core a", 0.85), core("core-b", "core b", 0.84),
    warm("covered", "covered raw", 0.95), warm("dup-a", "duplicate", 0.8),
    warm("dup-b", "duplicate", 0.8), warm("last", "last", 0.7)];
  await writeFile(path.join(dir, "alice_memories.json"), JSON.stringify(records));
  const adapter = createKebloUserRecallAdapter({ userId: "alice", storageReader: reader(dir) });
  const output = await adapter.recall({ query: "synthetic", limit: 3 });
  assert.deepEqual(output.results.map(({ id }) => id), ["super", "core-a", "core-b"]);
  assert.equal(output.stats.coveredSourceCount, 1);
  assert.equal(output.stats.duplicateContentCount, 1);
  assert.equal(output.routing.truncated, true);
});
