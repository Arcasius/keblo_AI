"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const JsonMemoryStorage = require("../../core/JsonMemoryStorage");
const { fingerprintEmbedding } = require("../../core/clustering/ClusterMath");
const {
  CLUSTER_RECORD_SCHEMA_VERSION, ClusterRecordError, createClusterRecord,
  validateClusterRecord, computeClusterIdempotencyKey,
  computeClusterRecordFingerprint
} = require("../../core/clustering/ClusterRecord");

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function candidate(overrides = {}) {
  const centroid = overrides.centroid || [1, 0.5];
  return {
    schemaVersion: 1, algorithmVersion: "complete-link-greedy-v1",
    clusterId: HASH_A, memberIds: ["mem_a", "mem_b", "mem_c"],
    embeddingDimension: centroid.length, centroid,
    centroidFingerprint: overrides.centroidFingerprint || fingerprintEmbedding(centroid),
    density: { averageSimilarity: 0.9, minimumSimilarity: 0.8, maximumSimilarity: 1, memberCount: 3 },
    policy: { similarityThreshold: 0.7, minClusterSize: 3, maxClusterSize: null },
    reasonCodes: ["CLUSTERED"], persisted: false, ...overrides
  };
}

function input(overrides = {}) {
  return {
    userId: "synthetic_user", clusterCandidate: candidate(), planId: HASH_B,
    createdAt: 1780000000000,
    embedding: { providerId: "synthetic-provider", model: "synthetic-model", version: "1" },
    ...overrides
  };
}
function mutable(value) { return structuredClone(value); }
function makeTemp() { return fs.mkdtempSync(path.join(os.tmpdir(), "mo-cluster-persistence-")); }
function residues(directory) { return fs.readdirSync(directory).filter((name) => name.endsWith(".tmp")); }

test("creates strict V1 records with deterministic identity and explicit timestamps", () => {
  const source = input();
  const before = mutable(source);
  const first = createClusterRecord(source);
  const second = createClusterRecord(input());
  assert.equal(CLUSTER_RECORD_SCHEMA_VERSION, 1);
  assert.match(first.id, /^clp_[a-f0-9]{64}$/);
  assert.match(first.idempotency_key, /^[a-f0-9]{64}$/);
  assert.match(first.record_fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(first.idempotency_key, second.idempotency_key);
  assert.equal(first.record_fingerprint, second.record_fingerprint);
  assert.equal(first.created_at, source.createdAt);
  assert.equal(first.updated_at, source.createdAt);
  assert.deepEqual(source, before);
  assert.equal(first.persisted, true);
  assert.deepEqual(validateClusterRecord(first), first);
  assert.equal(computeClusterIdempotencyKey(first), first.idempotency_key);
  assert.equal(computeClusterRecordFingerprint(first), first.record_fingerprint);
});

test("sorts source IDs without mutation and rejects duplicate provenance", () => {
  const source = input({ clusterCandidate: candidate({ memberIds: ["mem_c", "mem_a", "mem_b"] }) });
  const before = mutable(source);
  assert.deepEqual(createClusterRecord(source).source_memory_ids, ["mem_a", "mem_b", "mem_c"]);
  assert.deepEqual(source, before);
  assert.throws(() => createClusterRecord(input({ clusterCandidate: candidate({
    memberIds: ["mem_a", "mem_a", "mem_c"]
  }) })), { code: "DUPLICATE_SOURCE_MEMORY_ID" });
});

test("requires explicit embedding provenance, timestamp, dimension, centroid and density", () => {
  for (const embedding of [
    { providerId: "", model: "m", version: "1" },
    { providerId: "p", model: "", version: "1" },
    { providerId: "p", model: "m", version: null }
  ]) assert.throws(() => createClusterRecord(input({ embedding })), ClusterRecordError);
  assert.throws(() => createClusterRecord(input({ createdAt: undefined })), ClusterRecordError);
  assert.throws(() => createClusterRecord(input({ clusterCandidate: candidate({ embeddingDimension: 3 }) })), ClusterRecordError);
  assert.throws(() => createClusterRecord(input({ clusterCandidate: candidate({
    centroid: [0, 0], centroidFingerprint: HASH_A
  }) })), ClusterRecordError);
  assert.throws(() => createClusterRecord(input({ clusterCandidate: candidate({ centroidFingerprint: HASH_A }) })), {
    code: "INVALID_CENTROID_FINGERPRINT"
  });
  assert.throws(() => createClusterRecord(input({ clusterCandidate: candidate({ density: {
    averageSimilarity: 0.7, minimumSimilarity: 0.8, maximumSimilarity: 1, memberCount: 3
  } }) })), { code: "INVALID_DENSITY_ORDER" });
  assert.throws(() => createClusterRecord(input({ clusterCandidate: candidate({ density: {
    averageSimilarity: 0.9, minimumSimilarity: 0.8, maximumSimilarity: 1, memberCount: 2
  } }) })), { code: "INVALID_DENSITY_MEMBER_COUNT" });
});

test("outputs separate deeply frozen plain data without private/raw fields", () => {
  const source = input();
  const record = createClusterRecord(source);
  assert.equal(Object.getPrototypeOf(record), Object.prototype);
  for (const value of [record, record.policy, record.embedding, record.centroid,
    record.density, record.source_memory_ids]) assert.equal(Object.isFrozen(value), true);
  assert.notStrictEqual(record.centroid, source.clusterCandidate.centroid);
  assert.notStrictEqual(record.policy, source.clusterCandidate.policy);
  assert.notStrictEqual(record.source_memory_ids, source.clusterCandidate.memberIds);
  const serialized = JSON.stringify(record);
  for (const forbidden of ["sourceSnapshot", "content", "text", "entities", "prompt", "centroid_ref"]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test("strict validation rejects unknown, private and tampered fields", () => {
  const original = createClusterRecord(input());
  const mutations = [
    (r) => { r.id = `clp_${HASH_A}`; }, (r) => { r.idempotency_key = HASH_A; },
    (r) => { r.record_fingerprint = HASH_A; }, (r) => { r.source_memory_ids[0] = "mem_z"; },
    (r) => { r.embedding.model = "tampered"; }, (r) => { r.centroid[0] = 0.25; },
    (r) => { r.centroid_fingerprint = HASH_A; }, (r) => { r.density.average_similarity = 0.85; },
    (r) => { r.created_at = -1; }, (r) => { r.updated_at = r.created_at - 1; },
    (r) => { r.persisted = false; }, (r) => { r.text = "synthetic forbidden"; },
    (r) => { r.sourceSnapshot = {}; }
  ];
  for (const mutate of mutations) {
    const record = mutable(original); mutate(record);
    assert.throws(() => validateClusterRecord(record), ClusterRecordError);
  }
  assert.notStrictEqual(validateClusterRecord(original), original);
});

test("identity and fingerprint exclude retry timestamps and equivalent plan IDs", () => {
  const first = createClusterRecord(input());
  const retry = createClusterRecord(input({ createdAt: first.created_at + 9999, planId: "c".repeat(64) }));
  assert.equal(retry.id, first.id);
  assert.equal(retry.idempotency_key, first.idempotency_key);
  assert.equal(retry.record_fingerprint, first.record_fingerprint);
});

test("ClusterRecord generates no clock/random values and has no storage/model imports", () => {
  const source = fs.readFileSync(path.join(__dirname, "../../core/clustering/ClusterRecord.js"), "utf8");
  assert.doesNotMatch(source, /Date\.now|new Date|randomUUID|Math\.random/);
  assert.doesNotMatch(source, /JsonMemoryStorage|AtomicJsonCommit|Qwen|Ollama|saveMemory/);
});

test("cluster storage handles absent file and atomic object-map round trips", async () => {
  const directory = makeTemp();
  try {
    const storage = new JsonMemoryStorage(directory);
    const record = createClusterRecord(input());
    assert.deepEqual(await storage.loadClusters("synthetic_user"), []);
    const saved = await storage.saveCluster("synthetic_user", record);
    assert.deepEqual([saved.created, saved.idempotentReplay], [true, false]);
    const target = path.join(directory, "synthetic_user_clusters.json");
    const map = JSON.parse(fs.readFileSync(target, "utf8"));
    assert.deepEqual(Object.keys(map), [record.id]);
    assert.equal(map[record.id].id, record.id);
    const loaded = await storage.loadClusters("synthetic_user");
    const fetched = await storage.getCluster("synthetic_user", record.id);
    assert.deepEqual(loaded, [record]);
    assert.deepEqual(fetched, record);
    assert.equal(Object.getPrototypeOf(loaded[0]), Object.prototype);
    assert.notStrictEqual(loaded[0], fetched);
    assert.deepEqual(residues(directory), []);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("sequential replay preserves the original record without rewriting", async () => {
  const directory = makeTemp();
  try {
    const storage = new JsonMemoryStorage(directory);
    const original = createClusterRecord(input());
    const retry = createClusterRecord(input({ createdAt: original.created_at + 1000, planId: "c".repeat(64) }));
    await storage.saveCluster("synthetic_user", original);
    const target = path.join(directory, "synthetic_user_clusters.json");
    const before = fs.statSync(target).mtimeMs;
    const replay = await storage.saveCluster("synthetic_user", retry);
    assert.deepEqual([replay.created, replay.idempotentReplay], [false, true]);
    assert.deepEqual(replay.cluster, original);
    assert.equal(replay.cluster.created_at, original.created_at);
    assert.equal(fs.statSync(target).mtimeMs, before);
    assert.equal((await storage.loadClusters("synthetic_user")).length, 1);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("same idempotency key with different semantics conflicts without writing", async () => {
  const directory = makeTemp();
  try {
    const storage = new JsonMemoryStorage(directory);
    const original = createClusterRecord(input());
    await storage.saveCluster("synthetic_user", original);
    const conflicting = mutable(original);
    conflicting.density.average_similarity = 0.91;
    conflicting.record_fingerprint = computeClusterRecordFingerprint(conflicting);
    validateClusterRecord(conflicting);
    const target = path.join(directory, "synthetic_user_clusters.json");
    const before = fs.readFileSync(target, "utf8");
    await assert.rejects(storage.saveCluster("synthetic_user", conflicting), {
      code: "CLUSTER_IDEMPOTENCY_CONFLICT"
    });
    assert.equal(fs.readFileSync(target, "utf8"), before);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("delete is deterministic, preserves other clusters and advances backup", async () => {
  const directory = makeTemp();
  try {
    const storage = new JsonMemoryStorage(directory);
    const first = createClusterRecord(input());
    const second = createClusterRecord(input({ clusterCandidate: candidate({
      clusterId: "d".repeat(64), memberIds: ["mem_d", "mem_e", "mem_f"]
    }) }));
    await storage.saveCluster("synthetic_user", first);
    await storage.saveCluster("synthetic_user", second);
    assert.deepEqual(await storage.deleteCluster("synthetic_user", first.id), { deleted: true, clusterId: first.id });
    assert.deepEqual(await storage.deleteCluster("synthetic_user", first.id), { deleted: false, clusterId: first.id });
    assert.deepEqual(await storage.loadClusters("synthetic_user"), [second]);
    const target = path.join(directory, "synthetic_user_clusters.json");
    const backup = JSON.parse(fs.readFileSync(`${target}.bak`, "utf8"));
    assert.equal(Object.hasOwn(backup, first.id), true);
    assert.equal(Object.hasOwn(backup, second.id), true);
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(target, "utf8")));
    assert.deepEqual(residues(directory), []);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("storage rejects mismatch, invalid records, corrupt maps and empty IDs", async () => {
  const directory = makeTemp();
  try {
    const storage = new JsonMemoryStorage(directory);
    const record = createClusterRecord(input());
    await assert.rejects(storage.saveCluster("another_user", record), { code: "CLUSTER_USER_MISMATCH" });
    const invalid = mutable(record); invalid.persisted = false;
    await assert.rejects(storage.saveCluster("synthetic_user", invalid), ClusterRecordError);
    assert.equal(fs.existsSync(path.join(directory, "synthetic_user_clusters.json")), false);
    await assert.rejects(storage.getCluster("synthetic_user", ""), { code: "INVALID_CLUSTER_ARGUMENT" });
    const target = path.join(directory, "synthetic_user_clusters.json");
    fs.writeFileSync(target, JSON.stringify({ wrong_key: record }), "utf8");
    await assert.rejects(storage.loadClusters("synthetic_user"), { code: "CLUSTER_MAP_KEY_MISMATCH" });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("cluster CRUD never changes source memory files or writes outside temp", async () => {
  const directory = makeTemp();
  try {
    const memoryPath = path.join(directory, "synthetic_user_memories.json");
    fs.writeFileSync(memoryPath, JSON.stringify({ mem_a: { id: "mem_a" } }), "utf8");
    const before = fs.readFileSync(memoryPath, "utf8");
    const storage = new JsonMemoryStorage(directory);
    const record = createClusterRecord(input());
    await storage.saveCluster("synthetic_user", record);
    await storage.deleteCluster("synthetic_user", record.id);
    assert.equal(fs.readFileSync(memoryPath, "utf8"), before);
    assert.deepEqual(fs.readdirSync(directory).sort(), [
      "synthetic_user_clusters.json", "synthetic_user_clusters.json.bak", "synthetic_user_memories.json"
    ]);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
