"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  EMBEDDING_CACHE_COLLECTION,
  EMBEDDING_CACHE_DIMENSION,
  EMBEDDING_CACHE_MODEL,
  EMBEDDING_CACHE_REVISION,
  createIdentity,
  createPointId,
  validateEmbedding,
  createPayload
} = require("../../core/hippocampus/embedding-cache/EmbeddingCacheRecord");
const {
  PAYLOAD_INDEXES,
  createHippocampusEmbeddingCacheAdapter
} = require("../../core/hippocampus/embedding-cache/HippocampusEmbeddingCacheAdapter");

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const PRIVATE = "https://private.invalid SECRET_USER SECRET_POINT SECRET_VECTOR";

function signal() { return new AbortController().signal; }
function vector(index = 0) {
  const value = new Array(EMBEDDING_CACHE_DIMENSION).fill(0);
  value[index] = 1;
  return value;
}
function request(overrides = {}) {
  return {
    userId: "user-a",
    memoryId: "memory-a",
    contentHash: HASH_A,
    model: EMBEDDING_CACHE_MODEL,
    revision: EMBEDDING_CACHE_REVISION,
    signal: signal(),
    ...overrides
  };
}
function identityFor(value = request()) {
  return createIdentity({
    userId: value.userId,
    memoryId: value.memoryId,
    contentHash: value.contentHash,
    model: value.model,
    revision: value.revision
  });
}
function readyInfo() {
  return {
    exists: true,
    collectionStatus: "green",
    config: { params: { vectors: { size: EMBEDDING_CACHE_DIMENSION, distance: "Cosine" } } },
    payloadSchema: Object.fromEntries(Object.entries(PAYLOAD_INDEXES)
      .map(([name, dataType]) => [name, { data_type: dataType }]))
  };
}
function storedPoint(value = request(), embedding = vector()) {
  const identity = identityFor(value);
  const canonical = validateEmbedding(embedding);
  return {
    id: createPointId(identity),
    vector: [...canonical],
    payload: { ...createPayload(identity, canonical) }
  };
}
function memoryProvider(options = {}) {
  const points = new Map((options.points || []).map((point) => [String(point.id), structuredClone(point)]));
  const calls = [];
  let retrieves = 0;
  let writes = 0;
  const provider = {
    schemaVersion: 1,
    providerId: "ec4-in-memory",
    async health() { return { ok: true, providerId: "ec4-in-memory" }; },
    async getCollectionInfo(requestValue) {
      calls.push({ method: "getCollectionInfo", request: requestValue });
      if (options.getCollectionInfo) return options.getCollectionInfo({ calls });
      return options.ready === false ? { exists: false } : readyInfo();
    },
    async createCollection() { throw new Error("not authorized"); },
    async createPayloadIndex() { throw new Error("not authorized"); },
    async retrievePoints(requestValue) {
      retrieves += 1;
      calls.push({ method: "retrievePoints", request: requestValue });
      if (options.retrievePoints) {
        return options.retrievePoints({ request: requestValue, points, retrieves, writes, calls });
      }
      return { points: requestValue.pointIds.flatMap((id) => {
        const point = points.get(String(id));
        return point ? [structuredClone(point)] : [];
      }) };
    },
    async upsertPoints(requestValue) {
      writes += 1;
      calls.push({ method: "upsertPoints", request: requestValue });
      if (options.upsertPoints) {
        return options.upsertPoints({ request: requestValue, points, retrieves, writes, calls });
      }
      for (const point of requestValue.points) points.set(String(point.id), structuredClone(point));
      return { acknowledged: true, operationId: null, status: "completed" };
    },
    async searchPoints() { throw new Error("not used"); },
    async scrollPayload() { throw new Error("not used"); }
  };
  return { provider, calls, points, get retrieves() { return retrieves; }, get writes() { return writes; } };
}
function adapter(memory) {
  return createHippocampusEmbeddingCacheAdapter({ provider: memory.provider });
}

test("collection not ready fails before retrieve or write", async () => {
  const memory = memoryProvider({ ready: false });
  await assert.rejects(adapter(memory).getValidEmbedding(request()), {
    code: "COLLECTION_NOT_READY", retryable: false
  });
  assert.deepEqual(memory.calls.map(({ method }) => method), ["getCollectionInfo"]);
});

test("exact miss retrieves only one point with payload and vector", async () => {
  const memory = memoryProvider();
  const result = await adapter(memory).getValidEmbedding(request());
  assert.deepEqual(result, {
    status: "miss", reasonCode: "POINT_NOT_FOUND", pointId: createPointId(identityFor())
  });
  const retrieve = memory.calls.find(({ method }) => method === "retrievePoints").request;
  assert.deepEqual(retrieve.pointIds, [result.pointId]);
  assert.equal(retrieve.collection, EMBEDDING_CACHE_COLLECTION);
  assert.equal(retrieve.withPayload, true);
  assert.equal(retrieve.withVector, true);
});

test("a fully valid exact point is a canonical float32 hit", async () => {
  const source = vector();
  source[0] = 1 + 1e-8;
  const point = storedPoint(request(), source);
  const result = await adapter(memoryProvider({ points: [point] })).getValidEmbedding(request());
  assert.equal(result.status, "hit");
  assert.equal(result.reasonCode, "CACHE_HIT");
  assert.deepEqual(result.embedding, validateEmbedding(source));
  assert.equal(Object.isFrozen(result.embedding), true);
  assert.deepEqual(Object.keys(result), ["status", "reasonCode", "pointId", "embedding"]);
});

test("users and content hashes have isolated deterministic point IDs", async () => {
  const memory = memoryProvider();
  const value = adapter(memory);
  const a = await value.getValidEmbedding(request());
  const otherUser = await value.getValidEmbedding(request({ userId: "user-b" }));
  const otherHash = await value.getValidEmbedding(request({ contentHash: HASH_B }));
  assert.notEqual(a.pointId, otherUser.pointId);
  assert.notEqual(a.pointId, otherHash.pointId);
  assert.equal(new Set([a.pointId, otherUser.pointId, otherHash.pointId]).size, 3);
});

test("wrong model or revision and text fields are rejected before provider access", async () => {
  for (const invalid of [
    request({ model: "other-model" }),
    request({ revision: "other-revision" }),
    { ...request(), text: "forbidden" }
  ]) {
    const memory = memoryProvider();
    await assert.rejects(adapter(memory).getValidEmbedding(invalid), {
      code: invalid.text ? "INVALID_REQUEST" : "INVALID_IDENTITY", retryable: false
    });
    assert.equal(memory.calls.length, 0);
  }
});

test("unexpected and duplicate points fail closed", async () => {
  for (const points of [
    [{ ...storedPoint(), id: "unexpected" }],
    [storedPoint(), storedPoint()]
  ]) {
    const memory = memoryProvider({ retrievePoints: () => ({ points }) });
    await assert.rejects(adapter(memory).getValidEmbedding(request()), {
      code: points.length === 1 ? "POINT_IDENTITY_CONFLICT" : "CACHE_RECORD_INVALID",
      retryable: false
    });
  }
});

test("altered payload and full logical hash conflicts are not misses", async () => {
  const malformed = storedPoint();
  delete malformed.payload.normalized;
  const conflict = storedPoint();
  conflict.payload.logical_key_hash = HASH_B;
  for (const [point, code] of [
    [malformed, "CACHE_RECORD_INVALID"],
    [conflict, "POINT_IDENTITY_CONFLICT"]
  ]) {
    await assert.rejects(adapter(memoryProvider({ points: [point] })).getValidEmbedding(request()), {
      code, retryable: false
    });
  }
});

test("invalid vector dimension, norm and finite values fail as invalid records", async () => {
  const cases = [vector().slice(1), vector(), vector()];
  cases[1][0] = 2;
  cases[2][0] = Infinity;
  for (const embedding of cases) {
    const point = storedPoint();
    point.vector = embedding;
    await assert.rejects(adapter(memoryProvider({ points: [point] })).getValidEmbedding(request()), {
      code: "CACHE_RECORD_INVALID", retryable: false
    });
  }
});

test("fingerprint mismatch is an invalid cache record", async () => {
  const point = storedPoint();
  point.payload.vector_fingerprint = HASH_B;
  await assert.rejects(adapter(memoryProvider({ points: [point] })).getValidEmbedding(request()), {
    code: "CACHE_RECORD_INVALID", retryable: false
  });
});

test("same fingerprint replay performs zero upserts", async () => {
  const memory = memoryProvider({ points: [storedPoint()] });
  const result = await adapter(memory).upsertEmbedding({ ...request(), embedding: vector() });
  assert.deepEqual(result, {
    pointId: createPointId(identityFor()), created: false, idempotentReplay: true
  });
  assert.equal(memory.writes, 0);
  assert.equal(memory.retrieves, 1);
});

test("a pre-existing different valid embedding is never overwritten", async () => {
  const memory = memoryProvider({ points: [storedPoint(request(), vector(1))] });
  await assert.rejects(adapter(memory).upsertEmbedding({ ...request(), embedding: vector() }), {
    code: "POINT_IDENTITY_CONFLICT", retryable: false
  });
  assert.equal(memory.writes, 0);
});

test("miss performs one-point upsert and exact post-write verification", async () => {
  const memory = memoryProvider();
  const result = await adapter(memory).upsertEmbedding({ ...request(), embedding: vector() });
  assert.deepEqual(result, {
    pointId: createPointId(identityFor()), created: true, idempotentReplay: false
  });
  assert.equal(memory.writes, 1);
  assert.equal(memory.retrieves, 2);
  const upsert = memory.calls.find(({ method }) => method === "upsertPoints").request;
  assert.equal(upsert.points.length, 1);
  assert.deepEqual(Object.keys(upsert.points[0]).sort(), ["id", "payload", "vector"]);
  assert.equal(memory.calls.filter(({ method }) => method === "getCollectionInfo").length, 3);
});

test("invalid acknowledgement prevents success and verification", async () => {
  const memory = memoryProvider({ upsertPoints: () => ({ acknowledged: false }) });
  await assert.rejects(adapter(memory).upsertEmbedding({ ...request(), embedding: vector() }), {
    code: "UPSERT_ACKNOWLEDGEMENT_INVALID", retryable: true
  });
  assert.equal(memory.writes, 1);
  assert.equal(memory.retrieves, 1);
});

test("missing post-write point fails verification without automatic retry", async () => {
  const memory = memoryProvider({ retrievePoints: () => ({ points: [] }) });
  await assert.rejects(adapter(memory).upsertEmbedding({ ...request(), embedding: vector() }), {
    code: "UPSERT_VERIFICATION_FAILED", retryable: true
  });
  assert.equal(memory.writes, 1);
  assert.equal(memory.retrieves, 2);
});

test("different or invalid post-write point fails closed", async () => {
  for (const postWrite of [
    () => ({ ...storedPoint(), id: "race-winner" }),
    () => {
      const point = storedPoint();
      point.payload.vector_fingerprint = HASH_B;
      return point;
    }
  ]) {
    const memory = memoryProvider({
      retrievePoints({ retrieves }) {
        return { points: retrieves === 1 ? [] : [postWrite()] };
      },
      upsertPoints: () => ({ acknowledged: true, operationId: 1, status: "completed" })
    });
    await assert.rejects(adapter(memory).upsertEmbedding({ ...request(), embedding: vector() }), {
      code: "UPSERT_VERIFICATION_FAILED", retryable: false
    });
    assert.equal(memory.writes, 1);
    assert.equal(memory.retrieves, 2);
  }
});

test("retryable provider classification is preserved and never retried", async () => {
  const memory = memoryProvider({
    retrievePoints() {
      throw Object.assign(new Error(PRIVATE), {
        code: "QDRANT_TIMEOUT", retryable: true, endpoint: PRIVATE, body: PRIVATE
      });
    }
  });
  await assert.rejects(adapter(memory).getValidEmbedding(request()), (error) => {
    assert.equal(error.code, "QDRANT_TIMEOUT");
    assert.equal(error.retryable, true);
    assert.equal(error.message.includes(PRIVATE), false);
    assert.equal(JSON.stringify(error).includes(PRIVATE), false);
    return true;
  });
  assert.equal(memory.retrieves, 1);
});

test("closed requests and AbortSignal are mandatory for both operations", async () => {
  const value = adapter(memoryProvider());
  for (const method of ["getValidEmbedding", "upsertEmbedding"]) {
    const base = method === "upsertEmbedding" ? { ...request(), embedding: vector() } : request();
    for (const invalid of [
      {}, { ...base, signal: {} }, { ...base, endpoint: PRIVATE },
      method === "upsertEmbedding" ? { ...base, text: "forbidden" } : { ...base, embedding: vector() }
    ]) await assert.rejects(value[method](invalid), { code: "INVALID_REQUEST", retryable: false });
  }
});

test("invalid upsert vector is rejected before collection inspection", async () => {
  const memory = memoryProvider();
  await assert.rejects(adapter(memory).upsertEmbedding({ ...request(), embedding: [1] }), {
    code: "INVALID_VECTOR", retryable: false
  });
  assert.equal(memory.calls.length, 0);
});

test("EC-4 adds no batch, search, stale, delete, network or subsystem path", () => {
  const value = adapter(memoryProvider());
  assert.equal(typeof value.getValidEmbedding, "function");
  assert.equal(typeof value.upsertEmbedding, "function");
  for (const method of [
    "getEmbeddings", "upsertEmbeddings", "batch", "search", "scanStale", "delete", "deletePoints"
  ]) assert.equal(value[method], undefined, method);
  const source = fs.readFileSync(path.join(
    __dirname, "../../core/hippocampus/embedding-cache/HippocampusEmbeddingCacheAdapter.js"
  ), "utf8");
  for (const forbidden of [
    "fetch(", "process.env", "BgeM3", "JsonMemoryStorage", "HippocampusDaemon",
    "RecallRouter", "deletePoints(", "searchPoints(", "scrollPayload("
  ]) assert.equal(source.includes(forbidden), false, forbidden);
  assert.equal(source.includes(PRIVATE), false);
});
