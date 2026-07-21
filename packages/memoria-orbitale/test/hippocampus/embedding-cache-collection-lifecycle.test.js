"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  EMBEDDING_CACHE_COLLECTION,
  EMBEDDING_CACHE_DIMENSION
} = require("../../core/hippocampus/embedding-cache/EmbeddingCacheRecord");
const {
  EMBEDDING_CACHE_DISTANCE,
  CREATE_CONFIRMATION,
  PAYLOAD_INDEXES,
  HippocampusEmbeddingCacheAdapterError,
  createHippocampusEmbeddingCacheAdapter
} = require("../../core/hippocampus/embedding-cache/HippocampusEmbeddingCacheAdapter");

const INDEX_NAMES = Object.keys(PAYLOAD_INDEXES).sort();
const PRIVATE_SENTINEL = "https://secret.invalid PRIVATE_API_KEY PRIVATE_PAYLOAD";

function signal() {
  return new AbortController().signal;
}

function operation() {
  return { acknowledged: true, operationId: null, status: null };
}

function payloadSchema(names = INDEX_NAMES) {
  return Object.fromEntries(names.map((name) => [name, { data_type: PAYLOAD_INDEXES[name] }]));
}

function present(overrides = {}) {
  return {
    exists: true,
    collectionStatus: "green",
    config: { params: { vectors: { size: EMBEDDING_CACHE_DIMENSION, distance: "Cosine" } } },
    payloadSchema: payloadSchema(),
    ...overrides
  };
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function inMemoryProvider(options = {}) {
  let info = clone(options.info ?? { exists: false });
  const calls = [];
  const provider = {
    schemaVersion: 1,
    providerId: "in-memory-qdrant",
    async health() { return { ok: true, providerId: "in-memory-qdrant" }; },
    async getCollectionInfo(request) {
      calls.push({ method: "getCollectionInfo", request });
      if (options.getCollectionInfo) return options.getCollectionInfo({ request, calls, getInfo, setInfo });
      return clone(info);
    },
    async createCollection(request) {
      calls.push({ method: "createCollection", request });
      if (options.createCollection) return options.createCollection({ request, calls, getInfo, setInfo });
      info = present({ payloadSchema: {} });
      return operation();
    },
    async createPayloadIndex(request) {
      calls.push({ method: "createPayloadIndex", request });
      if (options.createPayloadIndex) return options.createPayloadIndex({ request, calls, getInfo, setInfo });
      info.payloadSchema[request.fieldName] = { data_type: request.fieldSchema };
      return operation();
    },
    async retrievePoints() { throw new Error("not used"); },
    async upsertPoints() { throw new Error("not used"); },
    async searchPoints() { throw new Error("not used"); },
    async scrollPayload() { throw new Error("not used"); }
  };
  function getInfo() { return info; }
  function setInfo(value) { info = clone(value); }
  return { provider, calls, getInfo, setInfo };
}

function adapter(memory) {
  return createHippocampusEmbeddingCacheAdapter({ provider: memory.provider });
}

function authorizedRequest() {
  return { allowCreate: true, confirmCreate: CREATE_CONFIRMATION, signal: signal() };
}

test("inspect-only reports an absent collection without writes", async () => {
  const memory = inMemoryProvider();
  const result = await adapter(memory).ensureCollection({ signal: signal() });
  assert.deepEqual(result, {
    ready: false,
    created: false,
    collection: EMBEDDING_CACHE_COLLECTION,
    dimension: 1024,
    distance: "Cosine",
    payloadIndexesReady: false,
    missingPayloadIndexes: INDEX_NAMES,
    reasonCode: "COLLECTION_NOT_FOUND"
  });
  assert.deepEqual(memory.calls.map((call) => call.method), ["getCollectionInfo"]);
});

test("creation is not authorized by allowCreate false or an omitted flag", async () => {
  for (const request of [
    { signal: signal() },
    { allowCreate: false, signal: signal() },
    { allowCreate: false, confirmCreate: CREATE_CONFIRMATION, signal: signal() }
  ]) {
    const memory = inMemoryProvider();
    const result = await adapter(memory).ensureCollection(request);
    assert.equal(result.reasonCode, "COLLECTION_NOT_FOUND");
    assert.equal(memory.calls.some((call) => call.method.startsWith("create")), false);
  }
});

test("wrong confirmation token is rejected before any write", async () => {
  const memory = inMemoryProvider();
  await assert.rejects(adapter(memory).ensureCollection({
    allowCreate: true,
    confirmCreate: "WRONG_TOKEN",
    signal: signal()
  }), { code: "INVALID_CREATE_CONFIRMATION", retryable: false });
  assert.equal(memory.calls.length, 0);
});

test("authorized creation uses the fixed collection contract and verifies it", async () => {
  const memory = inMemoryProvider();
  const result = await adapter(memory).ensureCollection(authorizedRequest());
  assert.equal(result.ready, true);
  assert.equal(result.created, true);
  assert.equal(result.payloadIndexesReady, true);
  const create = memory.calls.find((call) => call.method === "createCollection");
  assert.deepEqual(create.request.configuration, {
    vectors: { size: 1024, distance: "Cosine" }
  });
  assert.equal(create.request.collection, EMBEDDING_CACHE_COLLECTION);
  assert.equal(memory.calls.filter((call) => call.method === "getCollectionInfo").length, 3);
});

test("wrong dimension is incompatible and causes no write", async () => {
  const info = present();
  info.config.params.vectors.size = 768;
  const memory = inMemoryProvider({ info });
  await assert.rejects(adapter(memory).ensureCollection(authorizedRequest()), {
    code: "COLLECTION_INCOMPATIBLE", retryable: false
  });
  assert.deepEqual(memory.calls.map((call) => call.method), ["getCollectionInfo"]);
});

test("wrong distance is incompatible and causes no write", async () => {
  const info = present();
  info.config.params.vectors.distance = "Dot";
  const memory = inMemoryProvider({ info });
  await assert.rejects(adapter(memory).ensureCollection(authorizedRequest()), {
    code: "COLLECTION_INCOMPATIBLE", retryable: false
  });
  assert.equal(memory.calls.length, 1);
});

test("named, multi-vector and ambiguous configurations fail closed", async () => {
  const vectorShapes = [
    { dense: { size: 1024, distance: "Cosine" } },
    {
      dense: { size: 1024, distance: "Cosine" },
      sparse: { size: 1024, distance: "Cosine" }
    },
    { size: 1024, distance: "Cosine", named: { size: 1024, distance: "Cosine" } },
    { size: 1024, distance: "Cosine", multivector_config: { comparator: "max_sim" } }
  ];
  for (const vectors of vectorShapes) {
    const info = present();
    info.config.params.vectors = vectors;
    const memory = inMemoryProvider({ info });
    await assert.rejects(adapter(memory).ensureCollection({ signal: signal() }), {
      code: "COLLECTION_INCOMPATIBLE"
    });
    assert.equal(memory.calls.length, 1);
  }
});

test("incomplete responses and a different collection name fail closed", async () => {
  for (const info of [
    { exists: true },
    { exists: true, collectionStatus: "green", config: {}, payloadSchema: {} },
    { ...present(), collection: "different-collection" }
  ]) {
    const memory = inMemoryProvider({ info });
    await assert.rejects(adapter(memory).ensureCollection({ signal: signal() }), {
      code: "COLLECTION_INCOMPATIBLE", retryable: false
    });
  }
});

test("all compatible payload indexes make an existing collection ready", async () => {
  const memory = inMemoryProvider({ info: present() });
  const result = await adapter(memory).ensureCollection({ allowCreate: false, signal: signal() });
  assert.equal(result.ready, true);
  assert.equal(result.created, false);
  assert.deepEqual(result.missingPayloadIndexes, []);
  assert.deepEqual(memory.calls.map((call) => call.method), ["getCollectionInfo"]);
});

test("inspect-only reports only missing indexes in deterministic order", async () => {
  const existing = ["user_id_hash", "memory_id", "normalized"];
  const memory = inMemoryProvider({ info: present({ payloadSchema: payloadSchema(existing) }) });
  const result = await adapter(memory).ensureCollection({ signal: signal() });
  assert.equal(result.ready, false);
  assert.equal(result.reasonCode, "PAYLOAD_INDEXES_MISSING");
  assert.deepEqual(result.missingPayloadIndexes, INDEX_NAMES.filter((name) => !existing.includes(name)));
  assert.equal(memory.calls.length, 1);
});

test("authorized repair creates only missing indexes", async () => {
  const existing = INDEX_NAMES.filter((name) => !["memory_id", "normalized"].includes(name));
  const memory = inMemoryProvider({ info: present({ payloadSchema: payloadSchema(existing) }) });
  const result = await adapter(memory).ensureCollection(authorizedRequest());
  assert.equal(result.ready, true);
  assert.equal(result.created, false);
  assert.deepEqual(memory.calls.filter((call) => call.method === "createPayloadIndex")
    .map((call) => call.request.fieldName), ["memory_id", "normalized"]);
  assert.equal(memory.calls.some((call) => call.method === "createCollection"), false);
});

test("an incompatible payload index fails before creating missing indexes", async () => {
  const schema = payloadSchema(["content_hash"]);
  schema.content_hash.data_type = "integer";
  const memory = inMemoryProvider({ info: present({ payloadSchema: schema }) });
  await assert.rejects(adapter(memory).ensureCollection(authorizedRequest()), {
    code: "COLLECTION_INCOMPATIBLE", retryable: false
  });
  assert.deepEqual(memory.calls.map((call) => call.method), ["getCollectionInfo"]);
});

test("vector_fingerprint is deliberately not indexed", async () => {
  const schema = payloadSchema();
  schema.vector_fingerprint = { data_type: "keyword" };
  const memory = inMemoryProvider({ info: present({ payloadSchema: schema }) });
  await assert.rejects(adapter(memory).ensureCollection({ signal: signal() }), {
    code: "COLLECTION_INCOMPATIBLE"
  });
  assert.equal(Object.hasOwn(PAYLOAD_INDEXES, "vector_fingerprint"), false);
});

test("payload indexes are created sequentially in lexical order", async () => {
  let active = 0;
  let maximumActive = 0;
  const memory = inMemoryProvider({
    info: present({ payloadSchema: {} }),
    async createPayloadIndex({ request, getInfo }) {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await Promise.resolve();
      getInfo().payloadSchema[request.fieldName] = { data_type: request.fieldSchema };
      active -= 1;
      return operation();
    }
  });
  await adapter(memory).ensureCollection(authorizedRequest());
  assert.deepEqual(memory.calls.filter((call) => call.method === "createPayloadIndex")
    .map((call) => call.request.fieldName), INDEX_NAMES);
  assert.equal(maximumActive, 1);
});

test("final reread is mandatory and incomplete provisioning is rejected", async () => {
  let reads = 0;
  const memory = inMemoryProvider({
    info: present({ payloadSchema: {} }),
    getCollectionInfo({ getInfo }) {
      reads += 1;
      const info = clone(getInfo());
      if (reads === 2) delete info.payloadSchema.user_id_hash;
      return info;
    }
  });
  await assert.rejects(adapter(memory).ensureCollection(authorizedRequest()), {
    code: "COLLECTION_POSTCONDITION_FAILED", retryable: false
  });
  assert.equal(reads, 2);
});

test("a concurrent collection creation is accepted only after compatible reinspection", async () => {
  const conflict = Object.assign(new Error(PRIVATE_SENTINEL), {
    code: "HTTP_ERROR", status: 409, retryable: false, endpoint: PRIVATE_SENTINEL
  });
  const memory = inMemoryProvider({
    createCollection({ setInfo }) {
      setInfo(present({ payloadSchema: {} }));
      throw conflict;
    }
  });
  const result = await adapter(memory).ensureCollection(authorizedRequest());
  assert.equal(result.ready, true);
  assert.equal(result.created, false);
  assert.equal(memory.calls.filter((call) => call.method === "createCollection").length, 1);
});

test("a concurrent incompatible collection fails without generic retry", async () => {
  const memory = inMemoryProvider({
    createCollection({ setInfo }) {
      const incompatible = present({ payloadSchema: {} });
      incompatible.config.params.vectors.size = 10;
      setInfo(incompatible);
      throw Object.assign(new Error("conflict"), { code: "HTTP_ERROR", status: 409 });
    }
  });
  await assert.rejects(adapter(memory).ensureCollection(authorizedRequest()), {
    code: "COLLECTION_INCOMPATIBLE", retryable: false
  });
  assert.equal(memory.calls.filter((call) => call.method === "createCollection").length, 1);
  assert.equal(memory.calls.filter((call) => call.method === "getCollectionInfo").length, 2);
});

test("a concurrent index creation is accepted only after verified reinspection", async () => {
  let conflicted = false;
  const memory = inMemoryProvider({
    info: present({ payloadSchema: {} }),
    createPayloadIndex({ request, getInfo }) {
      getInfo().payloadSchema[request.fieldName] = { data_type: request.fieldSchema };
      if (!conflicted) {
        conflicted = true;
        throw Object.assign(new Error("conflict"), { code: "HTTP_ERROR", status: 409 });
      }
      return operation();
    }
  });
  const result = await adapter(memory).ensureCollection(authorizedRequest());
  assert.equal(result.ready, true);
  assert.equal(memory.calls.filter((call) => call.method === "createPayloadIndex").length, INDEX_NAMES.length);
});

test("retryable provider errors are preserved without retry", async () => {
  const memory = inMemoryProvider({
    getCollectionInfo() {
      throw Object.assign(new Error(PRIVATE_SENTINEL), {
        code: "QDRANT_TIMEOUT", retryable: true, endpoint: PRIVATE_SENTINEL
      });
    }
  });
  await assert.rejects(adapter(memory).ensureCollection({ signal: signal() }), (error) => {
    assert.equal(error.code, "QDRANT_TIMEOUT");
    assert.equal(error.retryable, true);
    assert.equal(error.message.includes(PRIVATE_SENTINEL), false);
    assert.equal(JSON.stringify(error).includes(PRIVATE_SENTINEL), false);
    return true;
  });
  assert.equal(memory.calls.length, 1);
});

test("non-conflict provider failures have zero generic retries and stay sanitized", async () => {
  const memory = inMemoryProvider({
    createPayloadIndex() {
      throw Object.assign(new Error(PRIVATE_SENTINEL), {
        code: "HTTP_ERROR", status: 400, retryable: false, payload: PRIVATE_SENTINEL
      });
    },
    info: present({ payloadSchema: {} })
  });
  await assert.rejects(adapter(memory).ensureCollection(authorizedRequest()), (error) => {
    assert.equal(error.code, "HTTP_ERROR");
    assert.equal(error.status, 400);
    assert.equal(error.retryable, false);
    assert.equal(error.message.includes(PRIVATE_SENTINEL), false);
    assert.equal(JSON.stringify(error).includes(PRIVATE_SENTINEL), false);
    return true;
  });
  assert.equal(memory.calls.filter((call) => call.method === "createPayloadIndex").length, 1);
});

test("request and provider contracts are closed and require AbortSignal", async () => {
  const memory = inMemoryProvider({ info: present() });
  const value = adapter(memory);
  assert.deepEqual(Object.keys(value).sort(), ["ensureCollection", "schemaVersion"]);
  for (const request of [
    {},
    { signal: {} },
    { signal: signal(), endpoint: PRIVATE_SENTINEL },
    { signal: signal(), allowCreate: "true" },
    { signal: signal(), confirmCreate: 1 }
  ]) await assert.rejects(value.ensureCollection(request), { code: "INVALID_REQUEST" });
  assert.throws(() => createHippocampusEmbeddingCacheAdapter({ provider: {} }), {
    code: "INVALID_PROVIDER"
  });
  assert.throws(() => createHippocampusEmbeddingCacheAdapter({
    provider: memory.provider,
    fallback: memory.provider
  }), { code: "INVALID_ADAPTER_OPTIONS" });
});

test("no destructive API, network, BGE, storage, daemon or historic vector path exists", () => {
  const source = fs.readFileSync(path.join(
    __dirname,
    "../../core/hippocampus/embedding-cache/HippocampusEmbeddingCacheAdapter.js"
  ), "utf8");
  for (const forbidden of [
    "deleteCollection(", "deletePoints(", "clear(", "recreate(", "migrate(",
    "fetch(", "process.env", "BgeM3", "JsonMemoryStorage", "HippocampusDaemon",
    "VectorIndexAdapter", "VectorIndexRecord"
  ]) assert.equal(source.includes(forbidden), false, forbidden);
  assert.equal(source.includes(PRIVATE_SENTINEL), false);
  assert.equal(EMBEDDING_CACHE_DISTANCE, "Cosine");
  assert.equal(HippocampusEmbeddingCacheAdapterError.prototype instanceof Error, true);
});
