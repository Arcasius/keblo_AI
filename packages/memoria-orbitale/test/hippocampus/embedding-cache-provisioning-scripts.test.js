"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");

const {
  EMBEDDING_CACHE_COLLECTION,
  EMBEDDING_CACHE_MODEL,
  EMBEDDING_CACHE_REVISION,
  EMBEDDING_CACHE_DIMENSION
} = require("../../core/hippocampus/embedding-cache/EmbeddingCacheRecord");
const {
  PAYLOAD_INDEXES
} = require("../../core/hippocampus/embedding-cache/HippocampusEmbeddingCacheAdapter");
const {
  createQdrantEmbeddingCacheProvider
} = require("../../core/providers/vector/QdrantEmbeddingCacheProvider");
const {
  CREATE_CONFIRMATION,
  parseArguments,
  runProvisioning
} = require("../../scripts/provision-hippocampus-embedding-cache");
const {
  SYNTHETIC_USER_ID,
  EMBEDDING_BATCH_SIZE,
  PAYLOAD_KEYS,
  syntheticItems,
  runSyntheticSmoke
} = require("../../scripts/hippocampus-embedding-cache-synthetic-smoke");

const PRIVATE_ENV = Object.freeze({
  HIPPOCAMPUS_QDRANT_URL: "http://127.0.0.1:6333",
  HIPPOCAMPUS_EMBEDDING_URL: "http://127.0.0.1:8001/api/v1/embed",
  HIPPOCAMPUS_EMBEDDING_API_KEY: "synthetic-test-key"
});
const INDEX_NAMES = Object.keys(PAYLOAD_INDEXES).sort();

function operation() {
  return { acknowledged: true, operationId: null, status: null };
}

function readyInfo(indexNames = INDEX_NAMES) {
  return {
    exists: true,
    collectionStatus: "green",
    config: { params: { vectors: { size: EMBEDDING_CACHE_DIMENSION, distance: "Cosine" } } },
    payloadSchema: Object.fromEntries(indexNames.map((name) => [
      name, { data_type: PAYLOAD_INDEXES[name] }
    ]))
  };
}

function matchesFilter(payload, filter) {
  return (filter?.must || []).every((condition) =>
    payload?.[condition.key] === condition.match?.value);
}

function cosine(left, right) {
  let score = 0;
  for (let index = 0; index < left.length; index += 1) score += left[index] * right[index];
  return score;
}

function qdrantDouble(options = {}) {
  let collection = options.ready ? readyInfo() : { exists: false };
  const points = new Map();
  const calls = [];
  let indexAttempts = 0;
  const provider = {
    schemaVersion: 1,
    providerId: "ec7-qdrant-double",
    async health() {
      calls.push({ method: "health" });
      return { ok: true, providerId: "ec7-qdrant-double" };
    },
    async getCollectionInfo(request) {
      calls.push({ method: "getCollectionInfo", request });
      return structuredClone(collection);
    },
    async createCollection(request) {
      calls.push({ method: "createCollection", request });
      collection = readyInfo([]);
      return operation();
    },
    async createPayloadIndex(request) {
      calls.push({ method: "createPayloadIndex", request });
      indexAttempts += 1;
      if (options.failIndexAttempt === indexAttempts) {
        throw Object.assign(new Error("synthetic partial failure"), {
          code: "QDRANT_UNAVAILABLE", retryable: true
        });
      }
      collection.payloadSchema[request.fieldName] = { data_type: request.fieldSchema };
      return operation();
    },
    async retrievePoints(request) {
      calls.push({ method: "retrievePoints", request });
      return { points: request.pointIds.flatMap((id) => {
        const point = points.get(String(id));
        return point ? [structuredClone(point)] : [];
      }) };
    },
    async upsertPoints(request) {
      calls.push({ method: "upsertPoints", request });
      for (const point of request.points) points.set(String(point.id), structuredClone(point));
      return operation();
    },
    async searchPoints(request) {
      calls.push({ method: "searchPoints", request });
      const result = [...points.values()]
        .filter((point) => matchesFilter(point.payload, request.filter))
        .map((point) => ({ ...structuredClone(point), score: cosine(request.vector, point.vector) }))
        .filter((point) => request.scoreThreshold === undefined || point.score >= request.scoreThreshold)
        .sort((left, right) => right.score - left.score)
        .slice(0, request.limit);
      return { points: result };
    },
    async scrollPayload(request) {
      calls.push({ method: "scrollPayload", request });
      const result = [...points.values()]
        .filter((point) => matchesFilter(point.payload, request.filter))
        .slice(0, request.limit)
        .map((point) => ({
          id: point.id,
          payload: request.withPayload ? structuredClone(point.payload) : null,
          vector: request.withVector ? [...point.vector] : null
        }));
      return { points: result, nextPageOffset: null };
    }
  };
  return {
    provider,
    points,
    calls,
    collectionNames() {
      return collection.exists
        ? ["existing_untouched", EMBEDDING_CACHE_COLLECTION]
        : ["existing_untouched"];
    },
    disableFailure() { options.failIndexAttempt = null; },
    get collection() { return collection; }
  };
}

function normalized(entries) {
  const vector = new Array(EMBEDDING_CACHE_DIMENSION).fill(0);
  let norm = 0;
  for (const [index, value] of entries) {
    vector[index] = value;
    norm += value * value;
  }
  norm = Math.sqrt(norm);
  return vector.map((value) => value / norm);
}

function vectorForText(text) {
  if (text.includes("satellite")) return normalized([[0, 1]]);
  if (text.includes("spaziale")) return normalized([[0, 0.98], [1, 0.2]]);
  if (text.includes("ricetta")) return normalized([[1, 1]]);
  if (text.includes("pane artificiale")) return normalized([[1, 0.95], [2, 0.1]]);
  if (text.includes("giardino")) return normalized([[2, 1]]);
  return normalized([[3, 1]]);
}

function embeddingDouble(options = {}) {
  const calls = [];
  return {
    calls,
    provider: Object.freeze({
      schemaVersion: 1,
      providerId: "ec7-bge-double",
      model: EMBEDDING_CACHE_MODEL,
      revision: EMBEDDING_CACHE_REVISION,
      dimension: EMBEDDING_CACHE_DIMENSION,
      normalized: true,
      version: `ec7-test+${EMBEDDING_CACHE_REVISION}`,
      async embedBatch(request) {
        calls.push(structuredClone({ items: request.items }));
        if (options.failCall === calls.length) {
          throw Object.assign(new Error("synthetic BGE failure"), {
            code: "HTTP_RETRYABLE", retryable: true
          });
        }
        return request.items.map((item) => ({
          id: item.id,
          contentHash: require("node:crypto").createHash("sha256").update(item.text).digest("hex"),
          embedding: vectorForText(item.text)
        }));
      }
    })
  };
}

function provisioningOptions(memory, args = []) {
  return {
    env: PRIVATE_ENV,
    args,
    providerFactory: () => memory.provider,
    listCollections: () => memory.collectionNames()
  };
}

function smokeOptions(memory, embedding, env = PRIVATE_ENV) {
  return {
    env,
    qdrantProvider: memory.provider,
    embeddingProvider: embedding.provider,
    bgeHealthCheck: async () => true,
    listCollections: () => memory.collectionNames()
  };
}

test("EC-7 provisioning defaults to inspect-only and performs zero writes", async () => {
  const memory = qdrantDouble();
  const result = await runProvisioning(provisioningOptions(memory));
  assert.equal(result.status, "DEFERRED_CREATE_NOT_AUTHORIZED");
  assert.equal(result.ready, false);
  assert.equal(result.writes, 0);
  assert.equal(memory.calls.some((call) => /^create|upsert|delete/.test(call.method)), false);
});

test("missing or wrong confirmation token authorizes no write", async () => {
  for (const args of [
    ["--allow-create"],
    ["--allow-create", "--confirm", "WRONG"],
    ["--confirm", CREATE_CONFIRMATION]
  ]) {
    const memory = qdrantDouble();
    const result = await runProvisioning(provisioningOptions(memory, args));
    assert.equal(result.status, "DEFERRED_CREATE_NOT_AUTHORIZED");
    assert.equal(result.writes, 0);
  }
  assert.deepEqual(parseArguments(["--allow-create", "--confirm", CREATE_CONFIRMATION]), {
    authorized: true, valid: true
  });
});

test("authorized provisioning creates only the exact collection and eight indexes", async () => {
  const memory = qdrantDouble();
  const result = await runProvisioning(provisioningOptions(memory, [
    "--allow-create", "--confirm", CREATE_CONFIRMATION
  ]));
  assert.equal(result.status, "PROVISIONED_AND_VERIFIED");
  assert.equal(result.ready, true);
  assert.equal(result.created, true);
  assert.equal(result.payloadIndexesReady, true);
  assert.equal(memory.calls.filter((call) => call.method === "createCollection").length, 1);
  assert.deepEqual(memory.calls.filter((call) => call.method === "createPayloadIndex")
    .map((call) => call.request.fieldName), INDEX_NAMES);
  assert.equal(Object.hasOwn(memory.collection.payloadSchema, "vector_fingerprint"), false);
  assert.equal(memory.calls.every((call) => !call.request?.collection ||
    call.request.collection === EMBEDDING_CACHE_COLLECTION), true);
});

test("Qdrant provider accepts HTTP 200 empty body only for health", async (context) => {
  const server = http.createServer((request, response) => {
    if (request.url === "/healthz") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end("");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const provider = createQdrantEmbeddingCacheProvider({
    endpoint: `http://127.0.0.1:${address.port}`,
    timeoutMs: 1000,
    maxResponseBytes: 1024,
    providerId: "empty-health-test"
  });
  assert.deepEqual(await provider.health({ signal: new AbortController().signal }), {
    ok: true, providerId: "empty-health-test"
  });
  await assert.rejects(provider.getCollectionInfo({
    collection: EMBEDDING_CACHE_COLLECTION,
    signal: new AbortController().signal
  }), { code: "INVALID_HTTP_JSON" });
});

test("smoke defers before points when collection is not ready", async () => {
  const memory = qdrantDouble();
  const embedding = embeddingDouble();
  const result = await runSyntheticSmoke(smokeOptions(memory, embedding));
  assert.equal(result.status, "DEFERRED_COLLECTION_NOT_READY");
  assert.equal(memory.points.size, 0);
  assert.equal(embedding.calls.length, 0);
});

test("missing configuration is sanitized and causes no provider call", async () => {
  const provisioning = await runProvisioning({ env: {}, args: [] });
  const smoke = await runSyntheticSmoke({ env: {} });
  assert.equal(provisioning.status, "DEFERRED_INVALID_CONFIGURATION");
  assert.equal(smoke.status, "DEFERRED_INVALID_CONFIGURATION");
  assert.equal(JSON.stringify([provisioning, smoke]).includes("undefined"), false);
});

test("public Qdrant endpoint without auth is rejected without fallback", async () => {
  const env = { ...PRIVATE_ENV, HIPPOCAMPUS_QDRANT_URL: "https://qdrant.public.example" };
  const provisioning = await runProvisioning({ env, args: [] });
  const smoke = await runSyntheticSmoke({ env });
  assert.equal(provisioning.status, "DEFERRED_PUBLIC_ENDPOINT_WITHOUT_AUTH");
  assert.equal(smoke.status, "DEFERRED_PUBLIC_ENDPOINT_WITHOUT_AUTH");
  assert.equal(provisioning.qdrantAuth, "absent-private-network");
});

test("synthetic smoke materializes six items in batches of two and pure-hit replays", async () => {
  const memory = qdrantDouble({ ready: true });
  const embedding = embeddingDouble();
  const result = await runSyntheticSmoke(smokeOptions(memory, embedding));
  assert.equal(result.status, "PASS");
  assert.equal(result.syntheticPoints, 6);
  assert.equal(result.batchSize, EMBEDDING_BATCH_SIZE);
  assert.deepEqual(embedding.calls.map((call) => call.items.length), [2, 2, 2]);
  assert.deepEqual(result.firstMaterialize, { hit: 0, created: 6, replay: 0, batches: 3 });
  assert.deepEqual(result.secondMaterialize, {
    hit: 6, created: 0, replay: 0, newBgeCalls: 0, newWrites: 0
  });
  assert.equal(memory.points.size, 6);
});

test("cross-batch neighbor is affine and scores above unrelated", async () => {
  const memory = qdrantDouble({ ready: true });
  const result = await runSyntheticSmoke(smokeOptions(memory, embeddingDouble()));
  assert.equal(result.status, "PASS");
  assert.equal(result.crossBatchNeighbor, true);
  assert.ok(result.affineSimilarity > result.unrelatedSimilarity);
});

test("stored synthetic payload has exact EC-1 shape and contains no text or clear user", async () => {
  const memory = qdrantDouble({ ready: true });
  const result = await runSyntheticSmoke(smokeOptions(memory, embeddingDouble()));
  assert.equal(result.status, "PASS");
  for (const point of memory.points.values()) {
    assert.deepEqual(Object.keys(point.payload).sort(), [...PAYLOAD_KEYS].sort());
    const serialized = JSON.stringify(point.payload);
    assert.equal(serialized.includes(SYNTHETIC_USER_ID), false);
    for (const item of syntheticItems()) assert.equal(serialized.includes(item.text), false);
  }
  assert.equal(result.payloadContainsText, false);
});

test("partial provisioning preserves retryability and rerun completes without delete", async () => {
  const memory = qdrantDouble({ failIndexAttempt: 3 });
  const args = ["--allow-create", "--confirm", CREATE_CONFIRMATION];
  const first = await runProvisioning(provisioningOptions(memory, args));
  assert.equal(first.status, "FAILED");
  assert.equal(first.retryable, true);
  assert.equal(first.verifiedPhase, "provision");
  memory.disableFailure();
  const second = await runProvisioning(provisioningOptions(memory, args));
  assert.equal(second.status, "PROVISIONED_AND_VERIFIED");
  assert.equal(second.ready, true);
  assert.equal(memory.calls.some((call) => /delete|cleanup|recreate|migrate/i.test(call.method)), false);
});

test("existing collection names are preserved and all writes target only EC-7", async () => {
  const memory = qdrantDouble({ ready: true });
  const result = await runSyntheticSmoke(smokeOptions(memory, embeddingDouble()));
  assert.equal(result.status, "PASS");
  assert.equal(result.existingCollectionsModified, false);
  assert.equal(memory.collectionNames().includes("existing_untouched"), true);
  assert.equal(memory.calls.filter((call) => ["createCollection", "createPayloadIndex", "upsertPoints"]
    .includes(call.method)).every((call) => call.request.collection === EMBEDDING_CACHE_COLLECTION), true);
});

test("failures do not retry automatically or clean up synthetic points", async () => {
  const memory = qdrantDouble({ ready: true });
  const embedding = embeddingDouble({ failCall: 2 });
  const result = await runSyntheticSmoke(smokeOptions(memory, embedding));
  assert.equal(result.status, "FAIL");
  assert.equal(result.retryable, true);
  assert.equal(embedding.calls.length, 2);
  assert.equal(memory.points.size, 2);
  assert.equal(memory.calls.some((call) => /delete|cleanup|rollback/i.test(call.method)), false);
});

test("all script output is sanitized", async () => {
  const secret = "EC7_SUPER_SECRET";
  const env = {
    ...PRIVATE_ENV,
    HIPPOCAMPUS_QDRANT_API_KEY: secret,
    HIPPOCAMPUS_EMBEDDING_API_KEY: `${secret}_BGE`
  };
  const memory = qdrantDouble({ ready: true });
  const result = await runSyntheticSmoke(smokeOptions(memory, embeddingDouble(), env));
  const output = JSON.stringify(result);
  assert.equal(result.status, "PASS");
  for (const forbidden of [secret, env.HIPPOCAMPUS_EMBEDDING_API_KEY,
    env.HIPPOCAMPUS_QDRANT_URL, env.HIPPOCAMPUS_EMBEDDING_URL, "127.0.0.1"]) {
    assert.equal(output.includes(forbidden), false);
  }
});
