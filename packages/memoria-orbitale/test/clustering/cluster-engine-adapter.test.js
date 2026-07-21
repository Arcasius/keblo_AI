"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  validateEmbedding,
  cosineSimilarity,
  calculateCentroid,
  calculateInternalDensity,
  calculateClusterIsolation,
  fingerprintEmbedding
} = require("../../core/clustering/ClusterMath");
const {
  CLUSTER_ADAPTER_SCHEMA_VERSION,
  CLUSTER_ALGORITHM_VERSION,
  CLUSTER_REASON_CODES,
  DEFAULT_CLUSTER_POLICY,
  ClusterEngineAdapterError,
  createClusterEngineAdapter
} = require("../../core/clustering/ClusterEngineAdapter");
const { selectConsolidationCandidates } = require("../../core/consolidation/CandidateSelector");
const { buildConsolidationPlan } = require("../../core/consolidation/ConsolidationPlan");

function memory(id, extra = {}) {
  return {
    id,
    content: { text: `PRIVATE_SYNTHETIC_${id}` },
    memoryKind: "raw",
    storageTier: "warm",
    processingState: "raw",
    embedding_ref: `ref-${id}`,
    ...extra
  };
}

function planFor(memories) {
  return buildConsolidationPlan(selectConsolidationCandidates(memories));
}

function providerFor(vectors, options = {}) {
  return {
    schemaVersion: 1,
    async getEmbedding(request) {
      if (options.observe) options.observe(request);
      if (options.fail?.has(request.memoryId)) throw new Error("synthetic provider failure");
      const value = vectors[request.memoryId];
      if (options.deferred?.has(request.memoryId)) {
        return new Promise((resolve) => setImmediate(() => resolve(value)));
      }
      return value;
    }
  };
}

function clone(value) {
  return structuredClone(value);
}

test("ClusterMath validates only non-empty finite non-zero number arrays", () => {
  assert.equal(validateEmbedding([1, 2, 3]), true);
  for (const invalid of [
    [], [NaN], [Infinity], [-Infinity], ["1"], [1, null], [0, 0],
    new Float32Array([1, 2]), null, "vector"
  ]) assert.throws(() => validateEmbedding(invalid), TypeError);
});

test("cosine similarity handles identity, orthogonality, opposition and symmetry", () => {
  assert.ok(Math.abs(cosineSimilarity([1, 2], [1, 2]) - 1) < 1e-12);
  assert.ok(Math.abs(cosineSimilarity([1, 0], [0, 1])) < 1e-12);
  assert.ok(Math.abs(cosineSimilarity([1, 0], [-1, 0]) + 1) < 1e-12);
  const ab = cosineSimilarity([0.1, 0.2, 0.3], [0.3, -0.2, 0.4]);
  const ba = cosineSimilarity([0.3, -0.2, 0.4], [0.1, 0.2, 0.3]);
  assert.ok(Math.abs(ab - ba) < 1e-15);
  assert.ok(ab >= -1 && ab <= 1);
  assert.throws(() => cosineSimilarity([1], [1, 2]), /dimensions/);
  assert.throws(() => cosineSimilarity([0], [1]), /non-zero/);
});

test("centroid is deterministic, correct and non-mutating", () => {
  const embeddings = [[1, 0], [0, 1], [1, 1]];
  const before = clone(embeddings);
  const centroid = calculateCentroid(embeddings);
  assert.deepEqual(centroid, [2 / 3, 2 / 3]);
  assert.deepEqual(embeddings, before);
  assert.notStrictEqual(centroid, embeddings[0]);
  assert.throws(() => calculateCentroid([]), /At least one/);
  assert.throws(() => calculateCentroid([[1], [1, 2]]), /dimensions/);
});

test("internal density reports average, minimum, maximum and count", () => {
  const embeddings = [[1, 0], [1, 1], [0, 1]];
  const centroid = calculateCentroid(embeddings);
  const density = calculateInternalDensity(embeddings, centroid);
  const similarities = embeddings.map((item) => cosineSimilarity(item, centroid));
  assert.deepEqual(density, {
    averageSimilarity: similarities.reduce((sum, value) => sum + value, 0) / 3,
    minimumSimilarity: Math.min(...similarities),
    maximumSimilarity: Math.max(...similarities),
    memberCount: 3
  });
});

test("cluster isolation is explicit with and without other centroids", () => {
  assert.deepEqual(calculateClusterIsolation([1, 0], []), {
    averageSimilarity: null,
    externalIsolation: 1,
    comparedClusterCount: 0
  });
  const isolation = calculateClusterIsolation([1, 0], [[1, 0], [0, 1], [-1, 0]]);
  assert.ok(Math.abs(isolation.averageSimilarity) < 1e-12);
  assert.ok(Math.abs(isolation.externalIsolation - 1) < 1e-12);
  assert.equal(isolation.comparedClusterCount, 3);
});

test("math helpers never mutate inputs and fingerprint deterministically", () => {
  const left = Object.freeze([1, 2]);
  const right = Object.freeze([2, 1]);
  cosineSimilarity(left, right);
  calculateInternalDensity([left, right], [1.5, 1.5]);
  calculateClusterIsolation([1, 0], [[0, 1]]);
  assert.equal(fingerprintEmbedding(left), fingerprintEmbedding([1, 2]));
  assert.match(fingerprintEmbedding(left), /^[a-f0-9]{64}$/);
});

test("exports immutable adapter constants and default policy", () => {
  assert.equal(CLUSTER_ADAPTER_SCHEMA_VERSION, 1);
  assert.equal(CLUSTER_ALGORITHM_VERSION, "complete-link-greedy-v1");
  assert.deepEqual(DEFAULT_CLUSTER_POLICY, {
    similarityThreshold: 0.7, minClusterSize: 3, maxClusterSize: null
  });
  assert.equal(Object.isFrozen(DEFAULT_CLUSTER_POLICY), true);
  for (const code of [
    "CLUSTERED", "UNCLUSTERED_BELOW_MIN_SIZE", "EMBEDDING_PROVIDER_FAILED",
    "INVALID_EMBEDDING", "EMBEDDING_DIMENSION_MISMATCH",
    "CANDIDATE_MEMORY_NOT_FOUND", "OVERSIZED_CLUSTER_DEFERRED",
    "INVALID_CONSOLIDATION_PLAN"
  ]) assert.equal(CLUSTER_REASON_CODES[code], code);
});

test("requires an explicit valid provider and rejects execution options", () => {
  for (const options of [undefined, null, {}, { embeddingProvider: {} }, {
    embeddingProvider: { schemaVersion: 2, getEmbedding() {} }
  }, { embeddingProvider: { schemaVersion: 1, getEmbedding: true } }]) {
    assert.throws(() => createClusterEngineAdapter(options), ClusterEngineAdapterError);
  }
  assert.throws(() => createClusterEngineAdapter({
    embeddingProvider: providerFor({}), storage: {}
  }), /Unsupported/);
  assert.throws(() => createClusterEngineAdapter({
    embeddingProvider: providerFor({}), policy: { maxClusterSize: 5, minClusterSize: 6 }
  }), /maxClusterSize/);
});

test("requires a valid untampered dry-run consolidation plan", async () => {
  const memories = [memory("a"), memory("b"), memory("c")];
  const adapter = createClusterEngineAdapter({
    embeddingProvider: providerFor({ a: [1, 0], b: [1, 0], c: [1, 0] })
  });
  await assert.rejects(adapter.buildClusterCandidates({ memories, consolidationPlan: null }), {
    code: "INVALID_CONSOLIDATION_PLAN"
  });
  const tampered = clone(planFor(memories));
  tampered.dryRun = false;
  await assert.rejects(adapter.buildClusterCandidates({ memories, consolidationPlan: tampered }), {
    code: "INVALID_CONSOLIDATION_PLAN"
  });
  await assert.rejects(adapter.buildClusterCandidates({
    memories, consolidationPlan: planFor(memories), commit: true
  }), /only memories and consolidationPlan/);
});

test("accepts array and object map with flat, nested and hybrid candidates", async () => {
  const memories = [
    memory("flat", { activation: 0 }),
    memory("nested", { orbital: { level: "short" } }),
    memory("hybrid", { activation: 0, orbital: { level: "long" } })
  ];
  const vectors = { flat: [1, 0], nested: [1, 0.01], hybrid: [1, -0.01] };
  for (const collection of [memories, { z: memories[2], x: memories[0], y: memories[1] }]) {
    const result = await createClusterEngineAdapter({ embeddingProvider: providerFor(vectors) })
      .buildClusterCandidates({ memories: collection, consolidationPlan: planFor(memories) });
    assert.equal(result.clusters.length, 1);
    assert.deepEqual(result.clusters[0].memberIds, ["flat", "hybrid", "nested"]);
  }
});

test("provider receives only memoryId and embeddingRef, never memory content", async () => {
  const memories = [memory("a"), memory("b"), memory("c")];
  const requests = [];
  const provider = providerFor({ a: [1, 0], b: [1, 0], c: [1, 0] }, {
    observe(request) {
      requests.push(request);
      assert.deepEqual(Object.keys(request).sort(), ["embeddingRef", "memoryId"]);
      assert.equal(Object.isFrozen(request), true);
      assert.doesNotMatch(JSON.stringify(request), /PRIVATE_SYNTHETIC/);
    }
  });
  await createClusterEngineAdapter({ embeddingProvider: provider })
    .buildClusterCandidates({ memories, consolidationPlan: planFor(memories) });
  assert.deepEqual(requests.map((request) => request.memoryId), ["a", "b", "c"]);
});

test("rejects a missing or duplicated canonical candidate memory", async () => {
  const memories = [memory("a"), memory("b")];
  const plan = planFor([memory("a"), memory("b"), memory("c")]);
  const adapter = createClusterEngineAdapter({ embeddingProvider: providerFor({}) });
  await assert.rejects(adapter.buildClusterCandidates({ memories, consolidationPlan: plan }), {
    code: "CANDIDATE_MEMORY_NOT_FOUND"
  });
  await assert.rejects(adapter.buildClusterCandidates({
    memories: [memory("a"), memory("a"), memory("b"), memory("c")],
    consolidationPlan: plan
  }), { code: "DUPLICATE_CANDIDATE_MEMORY" });
});

test("isolates provider failure, invalid embedding and dimension mismatch deterministically", async () => {
  const memories = [memory("a"), memory("b"), memory("c"), memory("d"), memory("e")];
  const provider = providerFor({
    a: [1, 0], b: [1, 0], c: [0, 0], d: [1, 0, 0], e: [1, 0]
  }, { fail: new Set(["b"]) });
  const result = await createClusterEngineAdapter({ embeddingProvider: provider, policy: { minClusterSize: 2 } })
    .buildClusterCandidates({ memories, consolidationPlan: planFor(memories) });
  assert.deepEqual(result.embeddingFailures, [
    { memoryId: "b", reasonCodes: ["EMBEDDING_PROVIDER_FAILED"] },
    { memoryId: "c", reasonCodes: ["INVALID_EMBEDDING"] },
    { memoryId: "d", reasonCodes: ["EMBEDDING_DIMENSION_MISMATCH"] }
  ]);
  assert.equal(result.stats.providerFailureCount, 1);
  assert.equal(result.stats.invalidEmbeddingCount, 2);
  assert.equal(result.stats.validEmbeddingCount, 2);
  assert.deepEqual(result.clusters[0].memberIds, ["a", "e"]);
});

test("uses direct similarity >= threshold and reports below-minimum groups", async () => {
  const memories = [memory("a"), memory("b"), memory("c")];
  const threshold = 0.8;
  const vectors = { a: [1, 0], b: [0.8, 0.6], c: [0, 1] };
  assert.ok(Math.abs(cosineSimilarity(vectors.a, vectors.b) - threshold) < 1e-12);
  const result = await createClusterEngineAdapter({
    embeddingProvider: providerFor(vectors),
    policy: { similarityThreshold: threshold, minClusterSize: 2 }
  }).buildClusterCandidates({ memories, consolidationPlan: planFor(memories) });
  assert.deepEqual(result.clusters[0].memberIds, ["a", "b"]);
  assert.deepEqual(result.unclustered, [
    { memoryId: "c", reasonCodes: ["UNCLUSTERED_BELOW_MIN_SIZE"] }
  ]);
});

test("has no implicit five or hundred limit", async () => {
  for (const size of [12, 100]) {
    const memories = Array.from({ length: size }, (_, index) => memory(`m-${String(index).padStart(3, "0")}`));
    const vectors = Object.fromEntries(memories.map((item) => [item.id, [1, 0]]));
    const result = await createClusterEngineAdapter({ embeddingProvider: providerFor(vectors) })
      .buildClusterCandidates({ memories, consolidationPlan: planFor(memories) });
    assert.equal(result.stats.requestedCandidateCount, size);
    assert.equal(result.stats.clusteredMemoryCount, size);
    assert.equal(result.clusters[0].memberIds.length, size);
    assert.equal(result.policy.maxClusterSize, null);
  }
});

test("defers an oversized group without truncation or member loss", async () => {
  const memories = [memory("a"), memory("b"), memory("c"), memory("d")];
  const vectors = Object.fromEntries(memories.map((item) => [item.id, [1, 0]]));
  const result = await createClusterEngineAdapter({
    embeddingProvider: providerFor(vectors),
    policy: { minClusterSize: 2, maxClusterSize: 3 }
  }).buildClusterCandidates({ memories, consolidationPlan: planFor(memories) });
  assert.equal(result.clusters.length, 0);
  assert.equal(result.unclustered.length, 4);
  assert.equal(result.unclustered.every((item) => item.reasonCodes[0] === "OVERSIZED_CLUSTER_DEFERRED"), true);
  assert.equal(result.stats.oversizedGroupCount, 1);
  assert.equal(result.stats.unclusteredMemoryCount, 4);
});

test("input order and async completion order do not change output", async () => {
  const memories = [memory("d"), memory("b"), memory("a"), memory("c")];
  const vectors = { a: [1, 0], b: [1, 0.01], c: [0, 1], d: [0.01, 1] };
  const plan = planFor(memories);
  const first = await createClusterEngineAdapter({
    embeddingProvider: providerFor(vectors), policy: { minClusterSize: 2 }
  }).buildClusterCandidates({ memories, consolidationPlan: plan });
  const second = await createClusterEngineAdapter({
    embeddingProvider: providerFor(vectors, { deferred: new Set(["a", "c"]) }),
    policy: { minClusterSize: 2 }
  }).buildClusterCandidates({ memories: [...memories].reverse(), consolidationPlan: plan });
  assert.deepStrictEqual(first, second);
  assert.equal(first.clusters.length, 2);
  assert.match(first.clusters[0].clusterId, /^[a-f0-9]{64}$/);
  assert.match(first.clusters[0].centroidFingerprint, /^[a-f0-9]{64}$/);
});

test("result statistics are coherent and every requested member is accounted once", async () => {
  const memories = [memory("a"), memory("b"), memory("c"), memory("d")];
  const result = await createClusterEngineAdapter({
    embeddingProvider: providerFor({ a: [1, 0], b: [1, 0], c: [0, 1], d: [0, 0] }),
    policy: { minClusterSize: 2 }
  }).buildClusterCandidates({ memories, consolidationPlan: planFor(memories) });
  const stats = result.stats;
  assert.equal(stats.requestedCandidateCount, 4);
  assert.equal(stats.resolvedMemoryCount, 4);
  assert.equal(stats.validEmbeddingCount + stats.invalidEmbeddingCount + stats.providerFailureCount, 4);
  assert.equal(stats.clusteredMemoryCount + stats.unclusteredMemoryCount + result.embeddingFailures.length, 4);
  assert.equal(stats.clusterCount, result.clusters.length);
});

test("does not mutate plan, memories, provider or returned embeddings", async () => {
  const memories = [memory("a"), memory("b"), memory("c")];
  const plan = planFor(memories);
  const vectors = { a: [1, 0], b: [1, 0], c: [1, 0] };
  const provider = providerFor(vectors);
  const beforeMemories = clone(memories);
  const beforePlan = clone(plan);
  const providerKeys = Object.keys(provider);
  const result = await createClusterEngineAdapter({ embeddingProvider: provider })
    .buildClusterCandidates({ memories, consolidationPlan: plan });
  assert.deepEqual(memories, beforeMemories);
  assert.deepEqual(plan, beforePlan);
  assert.deepEqual(vectors, { a: [1, 0], b: [1, 0], c: [1, 0] });
  assert.deepEqual(Object.keys(provider), providerKeys);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.clusters[0].centroid), true);
  assert.equal(result.persisted, false);
  assert.equal(result.clusters[0].persisted, false);
  assert.throws(() => { result.clusters[0].memberIds.push("x"); }, TypeError);
});

test("result contains no memory text, source snapshot, storage reference or methods", async () => {
  const memories = [memory("a"), memory("b"), memory("c")];
  const result = await createClusterEngineAdapter({
    embeddingProvider: providerFor({ a: [1, 0], b: [1, 0], c: [1, 0] })
  }).buildClusterCandidates({ memories, consolidationPlan: planFor(memories) });
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /PRIVATE_SYNTHETIC|sourceSnapshot|storage|prompt|payload/);
  assert.equal(serialized.includes("function"), false);
});

test("FIX 7 modules have no storage, filesystem, model, network or legacy imports", () => {
  const directory = path.join(__dirname, "..", "..", "core", "clustering");
  for (const name of ["ClusterMath.js", "ClusterEngineAdapter.js"]) {
    const source = fs.readFileSync(path.join(directory, name), "utf8");
    assert.doesNotMatch(source, /JsonMemoryStorage|StorageCapabilityContract|AtomicJsonCommit|MemoryNode|Qwen|Ollama|Qdrant/);
    assert.doesNotMatch(source, /require\(["'](?:node:)?fs["']\)|fetch\s*\(|saveCluster|saveMemory|Date\.now|new Date|Math\.random|randomUUID/);
  }
});
