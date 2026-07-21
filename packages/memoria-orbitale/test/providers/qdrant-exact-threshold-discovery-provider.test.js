"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  DEFAULT_BOUNDED_CLUSTERING_POLICY,
  DISCOVERY_COMPLETENESS,
  createGlobalIdentitySnapshot
} = require("../../core/clustering/HippocampusBoundedClusteringPlan");
const {
  createHippocampusCandidateGraphBuilder
} = require("../../core/clustering/HippocampusCandidateGraphBuilder");
const {
  THRESHOLD_DISCOVERY_MODE,
  evaluateThresholdDiscoveryCertificate
} = require("../../core/clustering/HippocampusDiscoveryCompleteness");
const {
  EMBEDDING_CACHE_MODEL,
  EMBEDDING_CACHE_REVISION,
  EMBEDDING_CACHE_DIMENSION,
  createIdentity,
  createPointId,
  createPayload
} = require("../../core/hippocampus/embedding-cache/EmbeddingCacheRecord");
const {
  createCurrentEmbeddingIdentityIndex
} = require("../../core/hippocampus/embedding-cache/CurrentEmbeddingIdentityIndex");
const {
  MAX_MAX_HITS_PER_QUERY,
  QdrantExactThresholdDiscoveryProviderError,
  createQdrantExactThresholdDiscoveryProvider
} = require("../../core/providers/vector/QdrantExactThresholdDiscoveryProvider");

const USER_ID = "bc8-synthetic-user";
const TIMEOUT_MS = 1000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const PRIVATE = "PRIVATE_TEXT_VECTOR_ENDPOINT_API_KEY";

function hash(character) {
  return character.repeat(64);
}

function vector(position) {
  const value = new Array(EMBEDDING_CACHE_DIMENSION).fill(0);
  value[position] = 1;
  return value;
}

function current(memoryId, character) {
  return {
    memoryId,
    contentHash: hash(character),
    model: EMBEDDING_CACHE_MODEL,
    revision: EMBEDDING_CACHE_REVISION
  };
}

function identity(value) {
  return createIdentity({ userId: USER_ID, ...value });
}

function queryIdentity(value) {
  return { ...value, pointId: createPointId(identity(value)) };
}

function point(value, score = 0.8, position = 0) {
  const recordIdentity = identity(value);
  const embedding = vector(position);
  return {
    id: createPointId(recordIdentity),
    vector: null,
    payload: { ...createPayload(recordIdentity, embedding) },
    score
  };
}

function setup(options = {}) {
  const items = options.items || [
    current("query", "a"),
    current("neighbor-b", "b"),
    current("neighbor-c", "c"),
    current("neighbor-d", "d")
  ];
  const validIdentityIndex = createCurrentEmbeddingIdentityIndex({
    userId: USER_ID,
    items
  });
  const identities = items.map((item) => queryIdentity(item));
  const identitySnapshot = createGlobalIdentitySnapshot({
    userIdHash: identity(items[0]).userIdHash,
    identities
  });
  const calls = [];
  const qdrantProvider = {
    schemaVersion: 1,
    providerId: "bc8-qdrant-double",
    timeoutMs: TIMEOUT_MS,
    maxResponseBytes: MAX_RESPONSE_BYTES,
    async queryPoints(request) {
      calls.push(structuredClone({
        ...request,
        signal: "AbortSignal"
      }));
      if (options.failure) throw Object.assign(new Error(PRIVATE), options.failure);
      if (options.response) return options.response(request, items);
      return {
        exact: true,
        points: items.slice(1, 3).map((item, index) => point(item, 0.9 - index / 10, index))
      };
    },
    async upsertPoints() { throw new Error("not authorized"); },
    async createCollection() { throw new Error("not authorized"); }
  };
  const provider = createQdrantExactThresholdDiscoveryProvider({
    qdrantProvider,
    userId: USER_ID,
    validIdentityIndex,
    identitySnapshotFingerprint: identitySnapshot.snapshotFingerprint,
    maxHitsPerQuery: options.maxHitsPerQuery || 3,
    timeoutMs: TIMEOUT_MS,
    maxResponseBytes: MAX_RESPONSE_BYTES
  });
  return {
    calls,
    identitySnapshot,
    items,
    provider,
    qdrantProvider,
    request(overrides = {}) {
      return {
        queryIdentity: queryIdentity(items[0]),
        identitySnapshotFingerprint: identitySnapshot.snapshotFingerprint,
        clusterThreshold: DEFAULT_BOUNDED_CLUSTERING_POLICY.clusterThreshold,
        signal: new AbortController().signal,
        ...overrides
      };
    }
  };
}

test("configuration is closed, bounded and the dedicated API is read-only", () => {
  const data = setup();
  assert.deepEqual(Object.keys(data.provider), [
    "schemaVersion", "providerId", "maxHitsPerQuery", "timeoutMs",
    "maxResponseBytes", "discoverNeighbors"
  ]);
  assert.equal(data.provider.deletePoints, undefined);
  assert.equal(data.provider.upsertPoints, undefined);
  assert.equal(data.provider.createCollection, undefined);
  assert.equal(Object.isFrozen(data.provider), true);
  assert.equal(MAX_MAX_HITS_PER_QUERY, 4096);

  for (const override of [
    { maxHitsPerQuery: 0 },
    { maxHitsPerQuery: MAX_MAX_HITS_PER_QUERY + 1 },
    { timeoutMs: 999 },
    { maxResponseBytes: 1 }
  ]) {
    const options = {
      qdrantProvider: data.qdrantProvider,
      userId: USER_ID,
      validIdentityIndex: createCurrentEmbeddingIdentityIndex({
        userId: USER_ID, items: data.items
      }),
      identitySnapshotFingerprint: data.identitySnapshot.snapshotFingerprint,
      maxHitsPerQuery: 3,
      timeoutMs: TIMEOUT_MS,
      maxResponseBytes: MAX_RESPONSE_BYTES,
      ...override
    };
    assert.throws(() => createQdrantExactThresholdDiscoveryProvider(options), {
      code: "INVALID_EXACT_DISCOVERY_CONFIGURATION"
    });
  }
});

test("one exact Query API request carries threshold, cap and mandatory filters", async () => {
  const data = setup();
  const result = await data.provider.discoverNeighbors(data.request());
  assert.equal(data.calls.length, 1);
  const request = data.calls[0];
  assert.equal(request.exact, true);
  assert.equal(request.scoreThreshold, 0.70);
  assert.equal(request.limit, 4);
  assert.equal(request.queryPointId, data.request().queryIdentity.pointId);
  assert.equal(request.withPayload, true);
  assert.equal(request.withVector, false);
  assert.deepEqual(request.filter.must.map((condition) => condition.key), [
    "schema_version", "user_id_hash", "embedding_model",
    "embedding_revision", "normalized"
  ]);
  assert.deepEqual(request.filter.must_not, [{
    has_id: [data.request().queryIdentity.pointId]
  }]);
  assert.equal(result.discoveryCompleteness,
    DISCOVERY_COMPLETENESS.COMPLETE_ABOVE_THRESHOLD);
});

test("fewer than the cap produces a BC-3 certificate bound to exact counters", async () => {
  const data = setup();
  const result = await data.provider.discoverNeighbors(data.request());
  assert.equal(result.certificate.mode, THRESHOLD_DISCOVERY_MODE);
  assert.equal(result.certificate.identityIndexFingerprint,
    data.identitySnapshot.snapshotFingerprint);
  assert.equal(result.certificate.queryPointId, data.request().queryIdentity.pointId);
  assert.equal(result.certificate.clusterThreshold, 0.70);
  assert.equal(result.certificate.eligibleIdentityCount, 3);
  assert.equal(result.certificate.enumeratedAboveThresholdCount, 2);
  assert.equal(result.certificate.exhausted, true);
  assert.equal(result.certificate.truncated, false);
  assert.equal(result.certificate.continuation, null);
  const evaluation = evaluateThresholdDiscoveryCertificate({
    identitySnapshot: data.identitySnapshot,
    queryPointId: data.request().queryIdentity.pointId,
    providerCompleteness: result.discoveryCompleteness,
    certificate: result.certificate,
    observedAboveThresholdCount: result.hits.length
  });
  assert.equal(evaluation.discoveryCompleteness,
    DISCOVERY_COMPLETENESS.COMPLETE_ABOVE_THRESHOLD);
});

test("the dedicated provider closes a BC-2 component through valid BC-3 certificates", async () => {
  const items = [
    current("query", "a"),
    current("neighbor-b", "b"),
    current("neighbor-c", "c")
  ];
  const data = setup({
    items,
    response: (request) => ({
      exact: true,
      points: items
        .filter((item) => createPointId(identity(item)) !== request.queryPointId)
        .map((item, index) => point(item, 0.9 - index / 20, index))
    })
  });
  const graph = await createHippocampusCandidateGraphBuilder({
    discoveryProvider: data.provider,
    maxNeighborQueries: items.length,
    maxCandidateEdges: 3,
    timeoutMs: 1000
  }).build({
    identitySnapshot: data.identitySnapshot,
    signal: new AbortController().signal
  });
  assert.equal(graph.components.length, 1);
  assert.equal(graph.components[0].finalizationAuthorized, true);
  assert.equal(graph.queryDiscoveries.every((item) =>
    item.discoveryCompleteness ===
      DISCOVERY_COMPLETENESS.COMPLETE_ABOVE_THRESHOLD), true);
});

test("cap plus one is incomplete truncated and emits no certificate", async () => {
  const data = setup({
    maxHitsPerQuery: 2,
    response: (_request, items) => ({
      exact: true,
      points: items.slice(1, 4).map((item, index) => point(item, 0.9 - index / 20, index))
    })
  });
  const result = await data.provider.discoverNeighbors(data.request());
  assert.equal(result.discoveryCompleteness, DISCOVERY_COMPLETENESS.INCOMPLETE_TRUNCATED);
  assert.equal(result.hits.length, 2);
  assert.equal(Object.hasOwn(result, "certificate"), false);
});

test("self-hit is removed and does not enter certificate counters", async () => {
  const data = setup({
    response: (_request, items) => ({
      exact: true,
      points: [point(items[0], 1), point(items[1], 0.8, 1)]
    })
  });
  const result = await data.provider.discoverNeighbors(data.request());
  assert.equal(result.discoveryCompleteness,
    DISCOVERY_COMPLETENESS.COMPLETE_ABOVE_THRESHOLD);
  assert.deepEqual(result.hits.map((hit) => hit.memoryId), ["neighbor-b"]);
  assert.equal(result.certificate.enumeratedAboveThresholdCount, 1);
});

test("stale, foreign, provenance and point mismatches fail closed without certificate", async () => {
  const cases = [
    (value) => {
      value.payload.content_hash = hash("f");
    },
    (value) => {
      value.payload.memory_id = "foreign";
    },
    (value) => {
      value.payload.embedding_revision = "foreign-revision";
    },
    (value) => {
      value.id = queryIdentity(current("other", "e")).pointId;
    }
  ];
  for (const mutate of cases) {
    const data = setup({
      response: (_request, items) => {
        const value = point(items[1], 0.8, 1);
        mutate(value);
        return { exact: true, points: [value] };
      }
    });
    const result = await data.provider.discoverNeighbors(data.request());
    assert.deepEqual(result, {
      discoveryCompleteness: DISCOVERY_COMPLETENESS.FAILED,
      hits: []
    });
  }
});

test("snapshot and current-query mismatches fail before Qdrant access", async () => {
  const data = setup();
  const wrongSnapshot = await data.provider.discoverNeighbors(data.request({
    identitySnapshotFingerprint: hash("f")
  }));
  const wrongQuery = await data.provider.discoverNeighbors(data.request({
    queryIdentity: {
      ...data.request().queryIdentity,
      contentHash: hash("f")
    }
  }));
  assert.equal(wrongSnapshot.discoveryCompleteness, DISCOVERY_COMPLETENESS.FAILED);
  assert.equal(wrongQuery.discoveryCompleteness, DISCOVERY_COMPLETENESS.FAILED);
  assert.equal(data.calls.length, 0);
});

test("malformed, oversized, timeout and transport failure become sanitized FAILED", async () => {
  const malformed = setup({ response: () => ({ exact: true, results: [] }) });
  assert.equal((await malformed.provider.discoverNeighbors(malformed.request()))
    .discoveryCompleteness, DISCOVERY_COMPLETENESS.FAILED);

  for (const failure of [
    { code: "RESPONSE_TOO_LARGE", endpoint: PRIVATE },
    { code: "QDRANT_TIMEOUT", retryable: true, vector: PRIVATE },
    { code: "INVALID_QDRANT_RESULT", payload: PRIVATE }
  ]) {
    const data = setup({ failure });
    const result = await data.provider.discoverNeighbors(data.request());
    assert.deepEqual(result, {
      discoveryCompleteness: DISCOVERY_COMPLETENESS.FAILED,
      hits: []
    });
    assert.doesNotMatch(JSON.stringify(result), new RegExp(PRIVATE));
  }
});

test("caller abort fails closed without transport access", async () => {
  const data = setup();
  const controller = new AbortController();
  controller.abort();
  const result = await data.provider.discoverNeighbors(data.request({
    signal: controller.signal
  }));
  assert.equal(result.discoveryCompleteness, DISCOVERY_COMPLETENESS.FAILED);
  assert.equal(data.calls.length, 0);
});

test("variable Qdrant order produces one deterministic output", async () => {
  const direct = setup({
    response: (_request, items) => ({
      exact: true,
      points: [point(items[2], 0.8, 2), point(items[1], 0.9, 1)]
    })
  });
  const inverse = setup({
    response: (_request, items) => ({
      exact: true,
      points: [point(items[1], 0.9, 1), point(items[2], 0.8, 2)]
    })
  });
  assert.deepEqual(
    await direct.provider.discoverNeighbors(direct.request()),
    await inverse.provider.discoverNeighbors(inverse.request())
  );
});

test("an approximate transport result can never emit a certificate", async () => {
  const data = setup({
    response: (_request, items) => ({
      exact: false,
      points: [point(items[1], 0.9, 1)]
    })
  });
  const result = await data.provider.discoverNeighbors(data.request());
  assert.equal(result.discoveryCompleteness, DISCOVERY_COMPLETENESS.FAILED);
  assert.equal(Object.hasOwn(result, "certificate"), false);
});

test("output and errors contain no text, vector, endpoint, key or raw payload", async () => {
  const data = setup();
  const result = await data.provider.discoverNeighbors(data.request());
  const serialized = JSON.stringify(result);
  for (const forbidden of [
    PRIVATE, "vector", "payload", "endpoint", "apiKey", USER_ID
  ]) assert.equal(serialized.includes(forbidden), false, forbidden);

  assert.throws(() => createQdrantExactThresholdDiscoveryProvider({}), (error) => {
    assert.equal(error instanceof QdrantExactThresholdDiscoveryProviderError, true);
    assert.equal(error.message,
      "Qdrant exact threshold discovery provider validation failed");
    assert.doesNotMatch(JSON.stringify(error), /PRIVATE|endpoint|apiKey|vector|payload/);
    return true;
  });
});

test("module has no environment, daemon, storage, synthesis or destructive dependency", () => {
  const source = fs.readFileSync(path.join(
    __dirname,
    "../../core/providers/vector/QdrantExactThresholdDiscoveryProvider.js"
  ), "utf8");
  assert.doesNotMatch(source,
    /process\.env|JsonMemoryStorage|HippocampusDaemon|RecallRouter|Synthesis|SuperMemory|deletePoints|upsertPoints\s*\(|createCollection\s*\(|fetch\s*\(/);
  assert.doesNotMatch(source, /retry\s*\(|fallback|Promise\.all/);
});
