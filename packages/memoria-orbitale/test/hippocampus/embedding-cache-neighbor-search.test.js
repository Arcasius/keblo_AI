"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  EMBEDDING_CACHE_COLLECTION,
  EMBEDDING_CACHE_MODEL,
  EMBEDDING_CACHE_REVISION,
  EMBEDDING_CACHE_DIMENSION,
  createIdentity,
  createPointId,
  validateEmbedding,
  createPayload
} = require("../../core/hippocampus/embedding-cache/EmbeddingCacheRecord");
const {
  PAYLOAD_INDEXES,
  MAX_NEIGHBOR_LIMIT,
  NEIGHBOR_OVERFETCH_FACTOR,
  createHippocampusEmbeddingCacheAdapter
} = require("../../core/hippocampus/embedding-cache/HippocampusEmbeddingCacheAdapter");
const {
  CurrentEmbeddingIdentityIndexError,
  createCurrentEmbeddingIdentityIndex,
  buildCurrentEmbeddingIdentityIndex
} = require("../../core/hippocampus/embedding-cache/CurrentEmbeddingIdentityIndex");

const USER_A = "synthetic-user-a";
const USER_B = "synthetic-user-b";
const PRIVATE = "PRIVATE_TEXT VECTOR SECRET_ENDPOINT API_KEY";

function hash(character) { return character.repeat(64); }
function signal() { return new AbortController().signal; }
function vector(position = 0) {
  const value = new Array(EMBEDDING_CACHE_DIMENSION).fill(0);
  value[position % EMBEDDING_CACHE_DIMENSION] = 1;
  return value;
}
function current(memoryId, character, overrides = {}) {
  return {
    memoryId,
    contentHash: hash(character),
    model: EMBEDDING_CACHE_MODEL,
    revision: EMBEDDING_CACHE_REVISION,
    ...overrides
  };
}
function identity(userId, value) {
  return createIdentity({ userId, ...value });
}
function point(userId, value, embedding = vector(), score) {
  const recordIdentity = identity(userId, value);
  const canonical = validateEmbedding(embedding);
  const result = {
    id: createPointId(recordIdentity),
    vector: [...canonical],
    payload: { ...createPayload(recordIdentity, canonical) }
  };
  if (score !== undefined) result.score = score;
  return result;
}
function index(userId, items) {
  return createCurrentEmbeddingIdentityIndex({ userId, items });
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
function providerDouble(options = {}) {
  const points = new Map((options.points || []).map((value) => [String(value.id), structuredClone(value)]));
  const calls = [];
  let searchCalls = 0;
  const provider = {
    schemaVersion: 1,
    providerId: "ec6-in-memory-qdrant",
    async health() { return { ok: true, providerId: "ec6-in-memory-qdrant" }; },
    async getCollectionInfo(request) {
      calls.push({ method: "getCollectionInfo", request });
      return readyInfo();
    },
    async createCollection() { throw new Error("not authorized"); },
    async createPayloadIndex() { throw new Error("not authorized"); },
    async retrievePoints(request) {
      calls.push({ method: "retrievePoints", request });
      return { points: request.pointIds.flatMap((id) => {
        const value = points.get(String(id));
        if (!value) return [];
        const copy = structuredClone(value);
        delete copy.score;
        return [copy];
      }) };
    },
    async upsertPoints() { throw new Error("read only"); },
    async searchPoints(request) {
      searchCalls += 1;
      calls.push({ method: "searchPoints", request });
      if (options.searchPoints) return options.searchPoints({ request, calls, points, searchCalls });
      return { points: structuredClone(options.searchResults || []) };
    },
    async scrollPayload() { throw new Error("not used"); }
  };
  return { provider, points, calls, get searchCalls() { return searchCalls; } };
}
function adapter(memory) {
  return createHippocampusEmbeddingCacheAdapter({ provider: memory.provider });
}
function searchRequest(userId, query, validIdentityIndex, overrides = {}) {
  return {
    userId,
    queryIdentity: { ...query },
    validIdentityIndex,
    scoreThreshold: -1,
    limit: 10,
    signal: signal(),
    ...overrides
  };
}
function fixture(neighbors = [], options = {}) {
  const query = current("query-memory", "a");
  const manifest = [query, ...(options.manifest || neighbors.map(({ value }) => value))];
  const queryPoint = point(options.userId || USER_A, query, vector(0));
  const results = neighbors.map(({ userId = USER_A, value, embedding = vector(1), score = 0.8 }) =>
    point(userId, value, embedding, score));
  const memory = providerDouble({
    points: [queryPoint],
    searchResults: results,
    ...options.providerOptions
  });
  return {
    query,
    validIdentityIndex: index(options.userId || USER_A, manifest),
    memory,
    value: adapter(memory)
  };
}

test("identity index is closed, immutable, user-scoped and contains only current identities", () => {
  const items = [current("m-1", "a"), current("m-2", "b")];
  const value = index(USER_A, items);
  assert.equal(value.size, 2);
  assert.equal(value.has("m-1"), true);
  assert.equal(value.has("absent"), false);
  assert.deepEqual(value.getExpected("m-1"), {
    contentHash: hash("a"),
    pointId: createPointId(identity(USER_A, items[0])),
    model: EMBEDDING_CACHE_MODEL,
    revision: EMBEDDING_CACHE_REVISION
  });
  assert.equal(value.getExpected("absent"), null);
  assert.equal(Object.isFrozen(value), true);
  assert.equal(Object.isFrozen(value.getExpected("m-1")), true);
  assert.deepEqual(Object.keys(value), []);
  assert.equal(JSON.stringify(value).includes(USER_A), false);
  assert.equal(CurrentEmbeddingIdentityIndexError.prototype instanceof Error, true);
  assert.equal(buildCurrentEmbeddingIdentityIndex({ userId: USER_A, items }).size, 2);
});

test("identity index rejects closed-input violations, duplicates and wrong provenance", () => {
  const one = current("m-1", "a");
  for (const input of [
    { userId: USER_A, items: [one], extra: true },
    { userId: USER_A, items: [{ ...one, text: PRIVATE }] },
    { userId: USER_A, items: [one, { ...one, contentHash: hash("b") }] },
    { userId: USER_A, items: [{ ...one, model: "other" }] },
    { userId: USER_A, items: [{ ...one, revision: "other" }] }
  ]) assert.throws(() => createCurrentEmbeddingIdentityIndex(input), { retryable: false });
});

test("valid query with no neighbors returns an explicit empty bounded result", async () => {
  const data = fixture();
  const result = await data.value.searchNeighbors(searchRequest(
    USER_A, data.query, data.validIdentityIndex
  ));
  assert.deepEqual(result, {
    queryPointId: createPointId(identity(USER_A, data.query)),
    neighbors: [],
    discardedStaleCount: 0,
    truncated: false
  });
});

test("valid neighbor is returned without vector, payload or identity hashes", async () => {
  const neighbor = current("neighbor-memory", "b");
  const data = fixture([{ value: neighbor, score: 0.91 }]);
  const result = await data.value.searchNeighbors(searchRequest(
    USER_A, data.query, data.validIdentityIndex
  ));
  assert.deepEqual(result.neighbors, [{
    memoryId: neighbor.memoryId,
    pointId: createPointId(identity(USER_A, neighbor)),
    score: 0.91
  }]);
  assert.equal(result.discardedStaleCount, 0);
});

test("self-hit is removed and counted without leaking query data", async () => {
  const data = fixture();
  data.memory.provider.searchPoints = async (request) => {
    data.memory.calls.push({ method: "searchPoints", request });
    return { points: [point(USER_A, data.query, vector(), 1)] };
  };
  const result = await data.value.searchNeighbors(searchRequest(
    USER_A, data.query, data.validIdentityIndex
  ));
  assert.deepEqual(result.neighbors, []);
  assert.equal(result.discardedStaleCount, 1);
  assert.equal(result.truncated, true);
});

test("users are isolated and complete global filters are sent", async () => {
  const other = current("other-user-memory", "b");
  const data = fixture([], {
    providerOptions: { searchResults: [point(USER_B, other, vector(1), 0.99)] }
  });
  const result = await data.value.searchNeighbors(searchRequest(
    USER_A, data.query, data.validIdentityIndex
  ));
  assert.deepEqual(result.neighbors, []);
  assert.equal(result.discardedStaleCount, 1);
  const request = data.memory.calls.find(({ method }) => method === "searchPoints").request;
  const userHash = identity(USER_A, data.query).userIdHash;
  assert.deepEqual(request.filter, { must: [
    { key: "schema_version", match: { value: 1 } },
    { key: "user_id_hash", match: { value: userHash } },
    { key: "embedding_model", match: { value: EMBEDDING_CACHE_MODEL } },
    { key: "embedding_revision", match: { value: EMBEDDING_CACHE_REVISION } },
    { key: "normalized", match: { value: true } }
  ] });
  assert.equal(request.withPayload, true);
  assert.equal(request.withVector, true);
  assert.equal(request.collection, EMBEDDING_CACHE_COLLECTION);
});

test("stale content is discarded even above a valid current neighbor", async () => {
  const stale = current("evolving-memory", "b");
  const now = current("evolving-memory", "c");
  const valid = current("valid-memory", "d");
  const data = fixture([], {
    manifest: [now, valid],
    providerOptions: { searchResults: [
      point(USER_A, stale, vector(1), 0.99),
      point(USER_A, valid, vector(2), 0.7)
    ] }
  });
  const result = await data.value.searchNeighbors(searchRequest(
    USER_A, data.query, data.validIdentityIndex
  ));
  assert.deepEqual(result.neighbors.map(({ memoryId }) => memoryId), ["valid-memory"]);
  assert.equal(result.discardedStaleCount, 1);
  assert.equal(result.truncated, true);
});

test("stale model and revision are discarded", async () => {
  const oldModel = point(USER_A, current("old-model", "b"), vector(1), 0.9);
  oldModel.id = "historical-model-point";
  oldModel.payload.embedding_model = "old-model";
  oldModel.payload.logical_key_hash = hash("d");
  const oldRevision = point(USER_A, current("old-revision", "c"), vector(2), 0.8);
  oldRevision.id = "historical-revision-point";
  oldRevision.payload.embedding_revision = "old-revision";
  oldRevision.payload.logical_key_hash = hash("e");
  const data = fixture([], {
    manifest: [current("old-model", "b"), current("old-revision", "c")],
    providerOptions: { searchResults: [oldModel, oldRevision] }
  });
  const result = await data.value.searchNeighbors(searchRequest(
    USER_A, data.query, data.validIdentityIndex
  ));
  assert.deepEqual(result.neighbors, []);
  assert.equal(result.discardedStaleCount, 2);
});

test("point absent from the current index is discarded", async () => {
  const absent = current("not-in-manifest", "b");
  const data = fixture([], {
    providerOptions: { searchResults: [point(USER_A, absent, vector(1), 0.8)] }
  });
  const result = await data.value.searchNeighbors(searchRequest(
    USER_A, data.query, data.validIdentityIndex
  ));
  assert.equal(result.neighbors.length, 0);
  assert.equal(result.discardedStaleCount, 1);
});

test("payload, logical identity and fingerprint corruption fail closed", async () => {
  const neighbor = current("neighbor-memory", "b");
  const variants = [
    (value) => { delete value.payload.normalized; },
    (value) => { value.payload.logical_key_hash = hash("f"); },
    (value) => { value.payload.vector_fingerprint = hash("e"); }
  ];
  for (const mutate of variants) {
    const corrupted = point(USER_A, neighbor, vector(1), 0.8);
    mutate(corrupted);
    const data = fixture([], {
      manifest: [neighbor], providerOptions: { searchResults: [corrupted] }
    });
    await assert.rejects(data.value.searchNeighbors(searchRequest(
      USER_A, data.query, data.validIdentityIndex
    )), { retryable: false });
  }
});

test("invalid vector and non-finite score fail closed", async () => {
  const neighbor = current("neighbor-memory", "b");
  const invalidVector = point(USER_A, neighbor, vector(1), 0.8);
  invalidVector.vector = [1];
  const invalidScore = point(USER_A, neighbor, vector(1), 0.8);
  invalidScore.score = Infinity;
  for (const resultPoint of [invalidVector, invalidScore]) {
    const data = fixture([], {
      manifest: [neighbor], providerOptions: { searchResults: [resultPoint] }
    });
    await assert.rejects(data.value.searchNeighbors(searchRequest(
      USER_A, data.query, data.validIdentityIndex
    )), { retryable: false });
  }
});

test("duplicate point IDs are rejected deterministically", async () => {
  const neighbor = current("neighbor-memory", "b");
  const resultPoint = point(USER_A, neighbor, vector(1), 0.8);
  const data = fixture([], {
    manifest: [neighbor], providerOptions: { searchResults: [resultPoint, resultPoint] }
  });
  await assert.rejects(data.value.searchNeighbors(searchRequest(
    USER_A, data.query, data.validIdentityIndex
  )), { code: "DUPLICATE_NEIGHBOR_POINT", retryable: false });
});

test("neighbors sort by descending score, memoryId and pointId", async () => {
  const values = [current("z-memory", "b"), current("a-memory", "c"), current("m-memory", "d")];
  const data = fixture([], {
    manifest: values,
    providerOptions: { searchResults: [
      point(USER_A, values[0], vector(1), 0.7),
      point(USER_A, values[2], vector(2), 0.9),
      point(USER_A, values[1], vector(3), 0.7)
    ] }
  });
  const result = await data.value.searchNeighbors(searchRequest(
    USER_A, data.query, data.validIdentityIndex
  ));
  assert.deepEqual(result.neighbors.map(({ memoryId }) => memoryId),
    ["m-memory", "a-memory", "z-memory"]);
});

test("limits 1, 2, 10 and values above five are explicit with no default", async () => {
  for (const limit of [1, 2, 10, 6]) {
    const data = fixture();
    await data.value.searchNeighbors(searchRequest(
      USER_A, data.query, data.validIdentityIndex, { limit }
    ));
    const search = data.memory.calls.find(({ method }) => method === "searchPoints");
    assert.equal(search.request.limit, limit * NEIGHBOR_OVERFETCH_FACTOR);
  }
  const data = fixture();
  const invalid = searchRequest(USER_A, data.query, data.validIdentityIndex);
  delete invalid.limit;
  await assert.rejects(data.value.searchNeighbors(invalid), { code: "INVALID_REQUEST" });
  assert.equal(MAX_NEIGHBOR_LIMIT, 1000);
});

test("overfetch is bounded and truncated covers saturation, stale and output limit", async () => {
  const values = Array.from({ length: 4 }, (_, index) =>
    current(`neighbor-${index}`, String.fromCharCode(98 + index)));
  const saturated = fixture([], {
    manifest: values,
    providerOptions: { searchResults: values.map((value, index) =>
      point(USER_A, value, vector(index + 1), 0.9 - index / 10)) }
  });
  const result = await saturated.value.searchNeighbors(searchRequest(
    USER_A, saturated.query, saturated.validIdentityIndex, { limit: 1 }
  ));
  assert.equal(result.neighbors.length, 1);
  assert.equal(result.truncated, true);
  const providerRequest = saturated.memory.calls.find(({ method }) => method === "searchPoints").request;
  assert.equal(providerRequest.limit, 4);
});

test("non-current query and another user's index fail before provider access", async () => {
  const data = fixture();
  const changed = { ...data.query, contentHash: hash("f") };
  await assert.rejects(data.value.searchNeighbors(searchRequest(
    USER_A, changed, data.validIdentityIndex
  )), { code: "QUERY_IDENTITY_NOT_CURRENT" });
  await assert.rejects(data.value.searchNeighbors(searchRequest(
    USER_A, data.query, index(USER_B, [data.query])
  )), { code: "INVALID_IDENTITY_INDEX" });
  assert.equal(data.memory.calls.length, 0);
});

test("cache miss is explicit and never starts search or BGE", async () => {
  const query = current("missing-query", "a");
  const memory = providerDouble();
  await assert.rejects(adapter(memory).searchNeighbors(searchRequest(
    USER_A, query, index(USER_A, [query])
  )), { code: "POINT_NOT_FOUND", retryable: false });
  assert.equal(memory.searchCalls, 0);
});

test("retryable search error is preserved, sanitized and never retried", async () => {
  const data = fixture([], { providerOptions: {
    searchPoints() {
      throw Object.assign(new Error(PRIVATE), {
        code: "QDRANT_TIMEOUT", retryable: true, endpoint: PRIVATE
      });
    }
  } });
  await assert.rejects(data.value.searchNeighbors(searchRequest(
    USER_A, data.query, data.validIdentityIndex
  )), (error) => {
    assert.equal(error.code, "QDRANT_TIMEOUT");
    assert.equal(error.retryable, true);
    assert.equal(error.message.includes(PRIVATE), false);
    return true;
  });
  assert.equal(data.memory.searchCalls, 1);
});

test("abort and malformed response fail without retry", async () => {
  const data = fixture();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(data.value.searchNeighbors(searchRequest(
    USER_A, data.query, data.validIdentityIndex, { signal: controller.signal }
  )), { code: "QDRANT_ABORTED" });
  assert.equal(data.memory.calls.length, 0);

  const malformed = fixture([], { providerOptions: { searchPoints: () => ({ results: [] }) } });
  await assert.rejects(malformed.value.searchNeighbors(searchRequest(
    USER_A, malformed.query, malformed.validIdentityIndex
  )), { code: "INVALID_PROVIDER_RESPONSE" });
  assert.equal(malformed.memory.searchCalls, 1);
});

test("global identity barrier finds an affine neighbor across synthetic batches 1 and 50", async () => {
  const batch1 = [current("global-query", "a"), current("first-other", "b")];
  const batch50 = [current("global-affine", "c"), current("fiftieth-other", "d")];
  const stored = [];
  function materializeBatch(values, vectorOffset) {
    for (let index = 0; index < values.length; index += 1) {
      stored.push(point(USER_A, values[index], vector(vectorOffset + index)));
    }
  }
  materializeBatch(batch1, 0);
  materializeBatch(batch50, 10);
  const queryPoint = stored[0];
  const crossPoint = { ...structuredClone(stored[2]), score: 0.97 };
  const memory = providerDouble({
    points: [queryPoint], searchResults: [crossPoint]
  });
  const globalIndex = index(USER_A, [...batch1, ...batch50]);
  const result = await adapter(memory).searchNeighbors(searchRequest(
    USER_A, batch1[0], globalIndex
  ));
  assert.deepEqual(result.neighbors.map(({ memoryId }) => memoryId), ["global-affine"]);
  assert.equal(JSON.stringify(crossPoint.payload).includes("batch"), false);
  assert.equal(Object.keys(crossPoint.payload).some((key) => /batch/i.test(key)), false);
  const search = memory.calls.find(({ method }) => method === "searchPoints").request;
  assert.equal(JSON.stringify(search.filter).includes("batch"), false);
});

test("output is closed, frozen and excludes text, vector, userId, hashes and payload", async () => {
  const neighbor = current("neighbor-memory", "b");
  const data = fixture([{ value: neighbor, score: 0.8 }]);
  const result = await data.value.searchNeighbors(searchRequest(
    USER_A, data.query, data.validIdentityIndex
  ));
  assert.deepEqual(Object.keys(result), [
    "queryPointId", "neighbors", "discardedStaleCount", "truncated"
  ]);
  assert.deepEqual(Object.keys(result.neighbors[0]), ["memoryId", "pointId", "score"]);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.neighbors), true);
  assert.equal(Object.isFrozen(result.neighbors[0]), true);
  const serialized = JSON.stringify(result);
  for (const forbidden of [PRIVATE, USER_A, "contentHash", "logical_key_hash", "payload", "vector"]){
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("request is closed and search path has no network, BGE, storage, daemon or delete", async () => {
  const data = fixture();
  for (const invalid of [
    {},
    { ...searchRequest(USER_A, data.query, data.validIdentityIndex), signal: {} },
    { ...searchRequest(USER_A, data.query, data.validIdentityIndex), fallback: true },
    searchRequest(USER_A, data.query, data.validIdentityIndex, { limit: 0 }),
    searchRequest(USER_A, data.query, data.validIdentityIndex, { limit: 1001 }),
    searchRequest(USER_A, data.query, data.validIdentityIndex, { scoreThreshold: 2 })
  ]) await assert.rejects(data.value.searchNeighbors(invalid), { code: "INVALID_REQUEST" });

  const adapterSource = fs.readFileSync(path.join(
    __dirname, "../../core/hippocampus/embedding-cache/HippocampusEmbeddingCacheAdapter.js"
  ), "utf8");
  const indexSource = fs.readFileSync(path.join(
    __dirname, "../../core/hippocampus/embedding-cache/CurrentEmbeddingIdentityIndex.js"
  ), "utf8");
  for (const forbidden of [
    "fetch(", "process.env", "BgeM3", "JsonMemoryStorage", "HippocampusDaemon",
    "ClusterEngine", "CandidateSelector", "RecallRouter", "deletePoints("
  ]) {
    assert.equal(adapterSource.includes(forbidden), false, forbidden);
    assert.equal(indexSource.includes(forbidden), false, forbidden);
  }
  assert.equal(typeof data.value.searchNeighbors, "function");
  assert.equal(data.value.deleteNeighbors, undefined);
});
