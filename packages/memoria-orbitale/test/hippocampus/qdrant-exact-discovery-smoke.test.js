"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  EMBEDDING_CACHE_DIMENSION,
  createIdentity,
  createPointId,
  createPayload
} = require("../../core/hippocampus/embedding-cache/EmbeddingCacheRecord");
const {
  SYNTHETIC_USER_ID
} = require("../../scripts/hippocampus-embedding-cache-synthetic-smoke");
const {
  MAX_HITS_PER_QUERY,
  currentItems,
  runExactDiscoverySmoke
} = require("../../scripts/hippocampus-qdrant-exact-discovery-smoke");

const ENV = Object.freeze({
  HIPPOCAMPUS_QDRANT_URL: "http://127.0.0.1:6333"
});

function vector(position) {
  const value = new Array(EMBEDDING_CACHE_DIMENSION).fill(0);
  value[position] = 1;
  return value;
}

function identity(item) {
  return createIdentity({ userId: SYNTHETIC_USER_ID, ...item });
}

function transport() {
  const items = currentItems();
  const calls = [];
  return {
    calls,
    provider: {
      schemaVersion: 1,
      providerId: "bc8-smoke-double",
      timeoutMs: 30000,
      maxResponseBytes: 16 * 1024 * 1024,
      async scrollPayload(request) {
        calls.push({ method: "scrollPayload", request });
        return {
          points: items.map((item) => ({
            id: createPointId(identity(item)),
            payload: null,
            vector: null
          })),
          nextPageOffset: null
        };
      },
      async queryPoints(request) {
        calls.push({ method: "queryPoints", request });
        const affine = items.find((item) => item.memoryId === "orbit-affine-8");
        const affineIdentity = identity(affine);
        return {
          exact: true,
          points: [{
            id: createPointId(affineIdentity),
            vector: null,
            payload: { ...createPayload(affineIdentity, vector(0)) },
            score: 0.81
          }]
        };
      },
      async upsertPoints() {
        throw new Error("not authorized");
      }
    }
  };
}

test("synthetic read-only smoke verifies exact request, certificate and cap", async () => {
  const data = transport();
  const result = await runExactDiscoverySmoke({
    env: ENV,
    qdrantProvider: data.provider
  });
  assert.equal(result.status, "PASS");
  assert.equal(result.syntheticPoints, 6);
  assert.equal(result.maxHitsPerQuery, MAX_HITS_PER_QUERY);
  assert.equal(result.requestedLimit, MAX_HITS_PER_QUERY + 1);
  assert.equal(result.scoreThreshold, 0.70);
  assert.equal(result.exactQuery, true);
  assert.equal(result.certificateValid, true);
  assert.equal(result.observedHitCount, 1);
  assert.equal(result.writes, 0);
  const query = data.calls.find((call) => call.method === "queryPoints").request;
  assert.equal(query.exact, true);
  assert.equal(query.limit, MAX_HITS_PER_QUERY + 1);
  assert.equal(query.withVector, false);
  assert.equal(data.calls.some((call) =>
    /upsert|create|delete|provision/i.test(call.method)), false);
});

test("smoke is deferred without explicit Qdrant configuration", async () => {
  const result = await runExactDiscoverySmoke({ env: {} });
  assert.equal(result.status, "DEFERRED_INVALID_CONFIGURATION");
  assert.equal(result.writes, 0);
});

test("smoke blocks a synthetic point-set mismatch before exact discovery", async () => {
  const data = transport();
  data.provider.scrollPayload = async () => ({
    points: [],
    nextPageOffset: null
  });
  const result = await runExactDiscoverySmoke({
    env: ENV,
    qdrantProvider: data.provider
  });
  assert.equal(result.status, "BLOCKED_SYNTHETIC_POINT_SET_MISMATCH");
  assert.equal(data.calls.some((call) => call.method === "queryPoints"), false);
});

test("smoke output is sanitized and contains no endpoint, user, payload or vector", async () => {
  const data = transport();
  const result = await runExactDiscoverySmoke({
    env: {
      ...ENV,
      HIPPOCAMPUS_QDRANT_API_KEY: "BC8_PRIVATE_KEY"
    },
    qdrantProvider: data.provider
  });
  const serialized = JSON.stringify(result);
  assert.equal(result.status, "PASS");
  for (const forbidden of [
    ENV.HIPPOCAMPUS_QDRANT_URL, "BC8_PRIVATE_KEY", SYNTHETIC_USER_ID,
    "payload", "vector", "endpoint"
  ]) assert.equal(serialized.includes(forbidden), false, forbidden);
});
