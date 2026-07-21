"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  EMBEDDING_CACHE_MODEL,
  EMBEDDING_CACHE_REVISION,
  EMBEDDING_CACHE_DIMENSION,
  createIdentity,
  createPointId,
  validateEmbedding,
  createVectorFingerprint
} = require("../../core/hippocampus/embedding-cache/EmbeddingCacheRecord");
const {
  MAX_MATERIALIZE_ITEMS,
  BgeM3EmbeddingCacheCoordinatorError,
  createBgeM3EmbeddingCacheCoordinator
} = require("../../core/hippocampus/embedding-cache/BgeM3EmbeddingCacheCoordinator");

const PRIVATE_TEXT = "PRIVATE_TEXT_MUST_NOT_ESCAPE";
const PRIVATE_USER = "PRIVATE_USER_MUST_NOT_ESCAPE";

function hash(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
function signal() { return new AbortController().signal; }
function vector(position = 0) {
  const value = new Array(EMBEDDING_CACHE_DIMENSION).fill(0);
  value[position % EMBEDDING_CACHE_DIMENSION] = 1;
  return value;
}
function item(index, overrides = {}) {
  const text = `synthetic-text-${index}`;
  return {
    userId: `user-${index % 3}`,
    memoryId: `memory-${index}`,
    contentHash: hash(text),
    text,
    ...overrides
  };
}
function pointId(value) {
  return createPointId(createIdentity({
    userId: value.userId,
    memoryId: value.memoryId,
    contentHash: value.contentHash,
    model: EMBEDDING_CACHE_MODEL,
    revision: EMBEDDING_CACHE_REVISION
  }));
}

function cacheDouble(options = {}) {
  const points = options.points || new Map();
  const calls = [];
  const cacheAdapter = {
    async getValidEmbedding(request) {
      calls.push({ method: "getValidEmbedding", request });
      if (options.getValidEmbedding) {
        return options.getValidEmbedding({ request, points, calls });
      }
      const id = pointId(request);
      const embedding = points.get(id);
      return embedding
        ? { status: "hit", reasonCode: "CACHE_HIT", pointId: id, embedding: [...embedding] }
        : { status: "miss", reasonCode: "POINT_NOT_FOUND", pointId: id };
    },
    async upsertEmbedding(request) {
      calls.push({ method: "upsertEmbedding", request });
      if (options.upsertEmbedding) {
        return options.upsertEmbedding({ request, points, calls });
      }
      const id = pointId(request);
      const canonical = validateEmbedding(request.embedding);
      const existing = points.get(id);
      if (existing) {
        if (createVectorFingerprint(existing) !== createVectorFingerprint(canonical)) {
          throw Object.assign(new Error("sanitized cache conflict"), {
            code: "POINT_IDENTITY_CONFLICT", retryable: false
          });
        }
        return { pointId: id, created: false, idempotentReplay: true };
      }
      points.set(id, canonical);
      return { pointId: id, created: true, idempotentReplay: false };
    }
  };
  return { cacheAdapter, calls, points };
}

function embeddingDouble(options = {}) {
  const calls = [];
  const embeddingProvider = {
    schemaVersion: 1,
    providerId: "in-memory-bge-m3",
    model: EMBEDDING_CACHE_MODEL,
    revision: EMBEDDING_CACHE_REVISION,
    dimension: EMBEDDING_CACHE_DIMENSION,
    normalized: true,
    version: "in-memory-v1",
    async embedBatch(request) {
      calls.push(request);
      if (options.embedBatch) return options.embedBatch({ request, calls });
      return request.items.map((value, index) => ({
        id: value.id,
        contentHash: hash(value.text),
        embedding: vector(index)
      }));
    }
  };
  Object.assign(embeddingProvider, options.provenance || {});
  return { embeddingProvider, calls };
}

function coordinator(cache, embedding, embeddingBatchSize = 64, overrides = {}) {
  return createBgeM3EmbeddingCacheCoordinator({
    cacheAdapter: cache.cacheAdapter,
    embeddingProvider: embedding.embeddingProvider,
    embeddingBatchSize,
    model: EMBEDDING_CACHE_MODEL,
    revision: EMBEDDING_CACHE_REVISION,
    ...overrides
  });
}

function request(items, requestSignal = signal()) {
  return { items, signal: requestSignal };
}

test("all hits produce no BGE call and lightweight hit identities", async () => {
  const items = [item(0), item(1), item(2)];
  const points = new Map(items.map((value, index) => [pointId(value), validateEmbedding(vector(index))]));
  const cache = cacheDouble({ points });
  const embedding = embeddingDouble();
  const result = await coordinator(cache, embedding).materialize(request(items));
  assert.equal(result.total, 3);
  assert.equal(result.hitCount, 3);
  assert.equal(result.embeddedCount, 0);
  assert.equal(result.createdCount, 0);
  assert.equal(result.replayedCount, 0);
  assert.equal(result.batches, 0);
  assert.deepEqual(result.identities.map(({ status }) => status), ["hit", "hit", "hit"]);
  assert.equal(embedding.calls.length, 0);
});

test("all misses are embedded, created and post-write delegated to EC-4", async () => {
  const items = [item(0), item(1), item(2), item(3), item(4)];
  const cache = cacheDouble();
  const embedding = embeddingDouble();
  const result = await coordinator(cache, embedding, 2).materialize(request(items));
  assert.deepEqual({
    total: result.total, hitCount: result.hitCount, embeddedCount: result.embeddedCount,
    createdCount: result.createdCount, replayedCount: result.replayedCount, batches: result.batches
  }, { total: 5, hitCount: 0, embeddedCount: 5, createdCount: 5, replayedCount: 0, batches: 3 });
  assert.equal(cache.calls.filter(({ method }) => method === "upsertEmbedding").length, 5);
  assert.equal(cache.points.size, 5);
});

test("HACT-5 identical rerun is all-hit with no BGE call or upsert", async () => {
  const items = [item(0), item(1), item(2)];
  const cache = cacheDouble();
  const firstBge = embeddingDouble();
  const first = await coordinator(cache, firstBge).materialize(request(items));
  assert.equal(first.createdCount, 3);
  assert.equal(first.hitCount, 0);

  cache.calls.length = 0;
  const secondBge = embeddingDouble();
  const second = await coordinator(cache, secondBge)
    .materialize(request(items));
  assert.equal(second.hitCount, 3);
  assert.equal(second.createdCount, 0);
  assert.equal(second.replayedCount, 0);
  assert.equal(secondBge.calls.length, 0);
  assert.equal(cache.calls.some(({ method }) => method === "upsertEmbedding"),
    false);
});

test("HACT-5 changed content hash creates a new identity, never a false hit", async () => {
  const cache = cacheDouble();
  const original = item(0);
  await coordinator(cache, embeddingDouble()).materialize(request([original]));
  const changedText = "synthetic-text-0-changed";
  const changed = {
    ...original,
    text: changedText,
    contentHash: hash(changedText)
  };
  const result = await coordinator(cache, embeddingDouble())
    .materialize(request([changed]));
  assert.equal(result.hitCount, 0);
  assert.equal(result.createdCount, 1);
  assert.notEqual(pointId(original), pointId(changed));
  assert.equal(cache.points.size, 2);
});

test("mixed input sends only exact misses to BGE", async () => {
  const items = [item(0), item(1), item(2), item(3)];
  const points = new Map([[pointId(items[1]), validateEmbedding(vector(1))],
    [pointId(items[3]), validateEmbedding(vector(3))]]);
  const cache = cacheDouble({ points });
  const embedding = embeddingDouble();
  const result = await coordinator(cache, embedding).materialize(request(items));
  assert.equal(result.hitCount, 2);
  assert.equal(result.embeddedCount, 2);
  assert.deepEqual(embedding.calls.map((call) => call.items.length), [2]);
  assert.deepEqual(new Set(embedding.calls[0].items.map(({ id }) => id)),
    new Set([pointId(items[0]), pointId(items[2])]));
});

test("257 all-miss items use bounded 64/64/64/64/1 BGE calls", async () => {
  const items = Array.from({ length: 257 }, (_, index) => item(index));
  const cache = cacheDouble();
  const embedding = embeddingDouble();
  const result = await coordinator(cache, embedding, 64).materialize(request(items));
  assert.deepEqual(embedding.calls.map((call) => call.items.length), [64, 64, 64, 64, 1]);
  assert.equal(result.embeddedCount, 257);
  assert.equal(result.createdCount, 257);
  assert.equal(result.batches, 5);
});

test("batch size changes only operational batch count, not semantic identities", async () => {
  const items = Array.from({ length: 9 }, (_, index) => item(index));
  const cacheA = cacheDouble();
  const cacheB = cacheDouble();
  const resultA = await coordinator(cacheA, embeddingDouble(), 1).materialize(request(items));
  const resultB = await coordinator(cacheB, embeddingDouble(), 7).materialize(request([...items].reverse()));
  assert.notEqual(resultA.batches, resultB.batches);
  assert.deepEqual(resultA.identities, resultB.identities);
  assert.deepEqual(resultA.identities.map(({ pointId: id }) => id),
    [...resultA.identities.map(({ pointId: id }) => id)].sort());
});

test("output is deterministic, frozen and ordered by pointId", async () => {
  const items = [item(4), item(0), item(3), item(1), item(2)];
  const first = await coordinator(cacheDouble(), embeddingDouble(), 3).materialize(request(items));
  const second = await coordinator(cacheDouble(), embeddingDouble(), 3)
    .materialize(request([...items].reverse()));
  assert.deepEqual(first, second);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.identities), true);
  assert.equal(Object.isFrozen(first.identities[0]), true);
});

test("wrong content hash rejects the complete input before cache or BGE", async () => {
  const cache = cacheDouble();
  const embedding = embeddingDouble();
  const items = [item(0), item(1, { contentHash: "0".repeat(64) })];
  await assert.rejects(coordinator(cache, embedding).materialize(request(items)), {
    code: "INVALID_ITEM", retryable: false
  });
  assert.equal(cache.calls.length, 0);
  assert.equal(embedding.calls.length, 0);
});

test("logical duplicates reject before every dependency call", async () => {
  const value = item(0);
  const cache = cacheDouble();
  const embedding = embeddingDouble();
  await assert.rejects(coordinator(cache, embedding).materialize(request([value, { ...value }])), {
    code: "DUPLICATE_LOGICAL_ITEM", retryable: false
  });
  assert.equal(cache.calls.length, 0);
  assert.equal(embedding.calls.length, 0);
});

test("constructor is closed and binds batch, model, revision and provider provenance", () => {
  const cache = cacheDouble();
  for (const size of [0, 129, 1.5]) {
    assert.throws(() => coordinator(cache, embeddingDouble(), size), { code: "INVALID_CONFIGURATION" });
  }
  assert.throws(() => coordinator(cache, embeddingDouble(), 64, { model: "other" }), {
    code: "INVALID_CONFIGURATION"
  });
  assert.throws(() => coordinator(cache, embeddingDouble(), 64, { revision: "other" }), {
    code: "INVALID_CONFIGURATION"
  });
  assert.throws(() => coordinator(cache, embeddingDouble({ provenance: { normalized: false } })), {
    code: "INVALID_CONFIGURATION"
  });
  assert.throws(() => createBgeM3EmbeddingCacheCoordinator({
    cacheAdapter: cache.cacheAdapter,
    embeddingProvider: embeddingDouble().embeddingProvider,
    embeddingBatchSize: 64,
    model: EMBEDDING_CACHE_MODEL,
    revision: EMBEDDING_CACHE_REVISION,
    fallback: "forbidden"
  }), { code: "INVALID_CONFIGURATION" });
  assert.equal(MAX_MATERIALIZE_ITEMS, 4096);
});

test("missing, duplicate and unexpected BGE responses fail before cache write", async () => {
  const variants = [
    ({ request }) => request.items.slice(1).map((value) => ({
      id: value.id, contentHash: hash(value.text), embedding: vector()
    })),
    ({ request }) => request.items.map((value) => ({
      id: request.items[0].id, contentHash: hash(request.items[0].text), embedding: vector()
    })),
    ({ request }) => request.items.map((value, index) => ({
      id: index === 0 ? "unexpected" : value.id,
      contentHash: hash(value.text), embedding: vector()
    }))
  ];
  for (const embedBatch of variants) {
    const cache = cacheDouble();
    await assert.rejects(coordinator(cache, embeddingDouble({ embedBatch }), 64)
      .materialize(request([item(0), item(1)])), { retryable: false });
    assert.equal(cache.calls.some(({ method }) => method === "upsertEmbedding"), false);
  }
});

test("BGE hash mismatch and invalid vector fail before cache write", async () => {
  const variants = [
    ({ request }) => request.items.map((value) => ({
      id: value.id, contentHash: "0".repeat(64), embedding: vector()
    })),
    ({ request }) => request.items.map((value) => ({
      id: value.id, contentHash: hash(value.text), embedding: [1]
    }))
  ];
  for (const embedBatch of variants) {
    const cache = cacheDouble();
    await assert.rejects(coordinator(cache, embeddingDouble({ embedBatch }))
      .materialize(request([item(0)])), { retryable: false });
    assert.equal(cache.calls.some(({ method }) => method === "upsertEmbedding"), false);
  }
});

test("cache conflict is preserved and never converted into a miss", async () => {
  const cache = cacheDouble({
    getValidEmbedding() {
      throw Object.assign(new Error(PRIVATE_TEXT), {
        code: "POINT_IDENTITY_CONFLICT", retryable: false
      });
    }
  });
  const embedding = embeddingDouble();
  await assert.rejects(coordinator(cache, embedding).materialize(request([item(0)])), (error) => {
    assert.equal(error.code, "POINT_IDENTITY_CONFLICT");
    assert.equal(error.retryable, false);
    assert.equal(error.message.includes(PRIVATE_TEXT), false);
    return true;
  });
  assert.equal(embedding.calls.length, 0);
});

test("intermediate batch failure leaves verified earlier batch and rerun is idempotent", async () => {
  const items = Array.from({ length: 5 }, (_, index) => item(index));
  const cache = cacheDouble();
  const failing = embeddingDouble({
    embedBatch({ request, calls }) {
      if (calls.length === 2) {
        throw Object.assign(new Error(PRIVATE_TEXT), { code: "HTTP_RETRYABLE", retryable: true });
      }
      return request.items.map((value) => ({
        id: value.id, contentHash: hash(value.text), embedding: vector()
      }));
    }
  });
  await assert.rejects(coordinator(cache, failing, 2).materialize(request(items)), {
    code: "HTTP_RETRYABLE", retryable: true
  });
  assert.equal(cache.points.size, 2);

  const rerunBge = embeddingDouble();
  const result = await coordinator(cache, rerunBge, 2).materialize(request(items));
  assert.equal(result.hitCount, 2);
  assert.equal(result.createdCount, 3);
  assert.deepEqual(rerunBge.calls.map((call) => call.items.length), [2, 1]);
});

test("abort is checked without retry or fallback", async () => {
  const controller = new AbortController();
  controller.abort();
  const cache = cacheDouble();
  const embedding = embeddingDouble();
  await assert.rejects(coordinator(cache, embedding).materialize(request([item(0)], controller.signal)), {
    code: "MATERIALIZE_ABORTED", retryable: true
  });
  assert.equal(cache.calls.length, 0);
  assert.equal(embedding.calls.length, 0);
});

test("retryable provider errors are preserved, sanitized and not retried", async () => {
  const cache = cacheDouble();
  const embedding = embeddingDouble({
    embedBatch() {
      throw Object.assign(new Error(`${PRIVATE_TEXT} endpoint api-key`), {
        code: "EMBEDDING_TIMEOUT", retryable: true, status: 504
      });
    }
  });
  await assert.rejects(coordinator(cache, embedding).materialize(request([item(0)])), (error) => {
    assert.equal(error.code, "EMBEDDING_TIMEOUT");
    assert.equal(error.retryable, true);
    assert.equal(error.status, 504);
    assert.equal(JSON.stringify(error).includes(PRIVATE_TEXT), false);
    return true;
  });
  assert.equal(embedding.calls.length, 1);
});

test("request and item contracts are closed, non-empty and explicitly bounded", async () => {
  const value = coordinator(cacheDouble(), embeddingDouble());
  for (const invalid of [
    {}, { items: [], signal: signal() }, { items: [item(0)], signal: signal(), extra: true },
    { items: [{ ...item(0), extra: true }], signal: signal() },
    { items: [item(0)], signal: {} },
    { items: Array.from({ length: MAX_MATERIALIZE_ITEMS + 1 }, (_, index) => item(index)), signal: signal() }
  ]) await assert.rejects(value.materialize(invalid), { retryable: false });
});

test("output and errors contain no text, userId or vectors", async () => {
  const privateItem = item(0, {
    userId: PRIVATE_USER,
    memoryId: "safe-memory-id",
    text: PRIVATE_TEXT,
    contentHash: hash(PRIVATE_TEXT)
  });
  const result = await coordinator(cacheDouble(), embeddingDouble()).materialize(request([privateItem]));
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(PRIVATE_TEXT), false);
  assert.equal(serialized.includes(PRIVATE_USER), false);
  assert.equal(serialized.includes("embedding"), false);
  assert.deepEqual(Object.keys(result), [
    "total", "hitCount", "embeddedCount", "createdCount", "replayedCount", "batches", "identities"
  ]);
  assert.deepEqual(Object.keys(result.identities[0]), [
    "memoryId", "contentHash", "pointId", "model", "revision", "status"
  ]);
  assert.equal(BgeM3EmbeddingCacheCoordinatorError.prototype instanceof Error, true);
});

test("source has bounded sequential batches and no forbidden integration", () => {
  const source = fs.readFileSync(path.join(
    __dirname,
    "../../core/hippocampus/embedding-cache/BgeM3EmbeddingCacheCoordinator.js"
  ), "utf8");
  for (const forbidden of [
    "Promise.all", "fetch(", "process.env", "deletePoints(", "fallback",
    "VectorIndex", "HippocampusDaemon", "ClusterEngine", "CandidateSelector",
    "RecallRouter", "JsonMemoryStorage", "Qwen"
  ]) assert.equal(source.includes(forbidden), false, forbidden);
  assert.equal(source.includes("embeddingBatchSize"), true);
  assert.equal(source.includes("splice(0, this.embeddingBatchSize)"), true);
});
