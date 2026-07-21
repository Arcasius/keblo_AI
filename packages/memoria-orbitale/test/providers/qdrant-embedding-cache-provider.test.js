"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const test = require("node:test");

const {
  QDRANT_PROVIDER_SCHEMA_VERSION,
  MAX_TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
  QdrantEmbeddingCacheProviderError,
  createQdrantEmbeddingCacheProvider
} = require("../../core/providers/vector/QdrantEmbeddingCacheProvider");

const API_KEY = "synthetic-qdrant-api-key";
const PRIVATE_SENTINEL = "PRIVATE_VECTOR_PAYLOAD_SENTINEL";
const COLLECTION = "synthetic-cache";

function envelope(result, overrides = {}) {
  return { result, status: "ok", time: 0.001, ...overrides };
}

function sendJson(response, value, status = 200, headers = {}) {
  response.writeHead(status, { "Content-Type": "application/json", ...headers });
  response.end(JSON.stringify(value));
}

async function startServer(t, handler) {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString("utf8");
    requests.push({ method: request.method, url: request.url, headers: request.headers, body });
    await handler(request, response, body, requests);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections?.();
    server.close();
  });
  return { endpoint: `http://127.0.0.1:${server.address().port}`, requests, server };
}

function provider(endpoint, overrides = {}) {
  return createQdrantEmbeddingCacheProvider({
    endpoint,
    timeoutMs: 1000,
    maxResponseBytes: 1024 * 1024,
    providerId: "synthetic-qdrant-cache",
    ...overrides
  });
}

function signal() {
  return new AbortController().signal;
}

function collectionResult(overrides = {}) {
  return {
    status: "green",
    config: { params: { vectors: { size: 1024, distance: "Cosine" } } },
    payload_schema: { user_id_hash: { data_type: "keyword" } },
    ...overrides
  };
}

function point(id = "point-1") {
  return { id, vector: [1, 0], payload: { marker: PRIVATE_SENTINEL } };
}

test("configuration is explicit, bounded and provider API is closed", () => {
  for (const options of [
    {},
    { endpoint: "ftp://localhost", timeoutMs: 1, maxResponseBytes: 1, providerId: "p" },
    { endpoint: "http://user:pass@localhost", timeoutMs: 1, maxResponseBytes: 1, providerId: "p" },
    { endpoint: "http://localhost?q=1", timeoutMs: 1, maxResponseBytes: 1, providerId: "p" },
    { endpoint: "http://localhost#fragment", timeoutMs: 1, maxResponseBytes: 1, providerId: "p" },
    { endpoint: "http://localhost", timeoutMs: 0, maxResponseBytes: 1, providerId: "p" },
    { endpoint: "http://localhost", timeoutMs: MAX_TIMEOUT_MS + 1, maxResponseBytes: 1, providerId: "p" },
    { endpoint: "http://localhost", timeoutMs: 1, maxResponseBytes: MAX_RESPONSE_BYTES + 1, providerId: "p" },
    { endpoint: "http://localhost", timeoutMs: 1, maxResponseBytes: 1, providerId: "bad id" },
    { endpoint: "http://localhost", timeoutMs: 1, maxResponseBytes: 1, providerId: "p", fallback: "x" },
    { endpoint: "http://localhost", timeoutMs: 1, maxResponseBytes: 1, providerId: "p", apiKey: "bad\nkey" }
  ]) assert.throws(() => createQdrantEmbeddingCacheProvider(options), { code: "INVALID_CONFIGURATION" });

  const value = provider("http://127.0.0.1:6333///");
  assert.equal(value.schemaVersion, QDRANT_PROVIDER_SCHEMA_VERSION);
  assert.deepEqual(Object.keys(value).sort(), [
    "createCollection", "createPayloadIndex", "getCollectionInfo", "health",
    "maxResponseBytes", "providerId", "queryPoints", "retrievePoints",
    "schemaVersion", "scrollPayload", "searchPoints", "timeoutMs", "upsertPoints"
  ]);
  assert.equal(value.timeoutMs, 1000);
  assert.equal(value.maxResponseBytes, 1024 * 1024);
  assert.equal(Object.isFrozen(value), true);
  assert.equal("deleteCollection" in value, false);
  assert.equal("deletePoints" in value, false);
  assert.equal("clear" in value || "recreate" in value || "migrate" in value, false);
});

test("api-key is sent only when explicitly configured", async (t) => {
  const local = await startServer(t, (_request, response) => {
    response.writeHead(200, { "Content-Type": "text/plain" });
    response.end("healthz check passed");
  });
  await provider(local.endpoint, { apiKey: API_KEY }).health({ signal: signal() });
  await provider(local.endpoint).health({ signal: signal() });
  assert.equal(local.requests[0].headers["api-key"], API_KEY);
  assert.equal(Object.hasOwn(local.requests[1].headers, "api-key"), false);
});

test("health accepts bounded text/plain at validated content-length without waiting for EOF", async (t) => {
  const originalFetch = globalThis.fetch;
  let cancelled = false;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("healthz check passed"));
    },
    cancel() {
      cancelled = true;
    }
  }), {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Length": "20"
    }
  });

  assert.deepEqual(await provider("http://127.0.0.1:6333", {
    timeoutMs: 50,
    maxResponseBytes: 20
  }).health({ signal: signal() }), {
    ok: true,
    providerId: "synthetic-qdrant-cache"
  });
  assert.equal(cancelled, true);
});

test("health rejects a streamed text/plain body over its bound", async (t) => {
  const local = await startServer(t, (_request, response) => {
    response.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Transfer-Encoding": "chunked"
    });
    response.write("x".repeat(24));
    response.end("x".repeat(24));
  });
  await assert.rejects(provider(local.endpoint, {
    maxResponseBytes: 32
  }).health({ signal: signal() }), {
    code: "RESPONSE_TOO_LARGE",
    retryable: false
  });
});

test("getCollectionInfo completes at exact JSON Content-Length without waiting for keep-alive EOF", async (t) => {
  const originalFetch = globalThis.fetch;
  let cancelled = false;
  t.after(() => { globalThis.fetch = originalFetch; });
  const value = envelope(collectionResult());
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
    },
    cancel() {
      cancelled = true;
    }
  }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Content-Length": String(bytes.byteLength),
      "Connection": "keep-alive"
    }
  });

  const result = await provider("http://127.0.0.1:6333", {
    timeoutMs: 50
  }).getCollectionInfo({ collection: COLLECTION, signal: signal() });
  assert.equal(result.collectionStatus, "green");
  assert.equal(result.config.params.vectors.size, 1024);
  assert.equal(result.config.params.vectors.distance, "Cosine");
  assert.equal(cancelled, true);
});

test("JSON Content-Length rejects short, long and invalid byte declarations", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const bytes = new TextEncoder().encode(JSON.stringify(envelope(collectionResult())));
  const cases = [
    { declared: String(bytes.byteLength + 1), payload: bytes, code: "INVALID_HTTP_BODY" },
    { declared: String(bytes.byteLength - 1), payload: bytes, code: "INVALID_HTTP_BODY" },
    { declared: "-1", payload: bytes, code: "RESPONSE_TOO_LARGE" },
    { declared: "invalid", payload: bytes, code: "RESPONSE_TOO_LARGE" },
    { declared: String(bytes.byteLength + 1), payload: bytes,
      maxResponseBytes: bytes.byteLength, code: "RESPONSE_TOO_LARGE" }
  ];
  for (const item of cases) {
    globalThis.fetch = async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(item.payload);
        controller.close();
      }
    }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": item.declared
      }
    });
    await assert.rejects(provider("http://127.0.0.1:6333", {
      maxResponseBytes: item.maxResponseBytes || bytes.byteLength + 10
    }).getCollectionInfo({ collection: COLLECTION, signal: signal() }), {
      code: item.code
    });
  }
});

test("valid chunked JSON ignores false length and waits for HTTP message completion", async (t) => {
  const local = await startServer(t, (_request, response) => {
    const body = JSON.stringify(envelope(collectionResult()));
    response.writeHead(200, {
      "Content-Type": "application/json",
      "Transfer-Encoding": "chunked"
    });
    response.write(body.slice(0, 17));
    response.end(body.slice(17));
  });
  const result = await provider(local.endpoint).getCollectionInfo({
    collection: COLLECTION,
    signal: signal()
  });
  assert.equal(result.collectionStatus, "green");
});

test("getCollectionInfo distinguishes abort before and during JSON response", async (t) => {
  const before = new AbortController();
  before.abort();
  await assert.rejects(provider("http://127.0.0.1:6333").getCollectionInfo({
    collection: COLLECTION,
    signal: before.signal
  }), { code: "QDRANT_ABORTED", retryable: false });

  const local = await startServer(t, (_request, response) => {
    const body = JSON.stringify(envelope(collectionResult()));
    response.writeHead(200, {
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(body) + 10)
    });
    response.write(body.slice(0, 10));
  });
  const during = new AbortController();
  const pending = provider(local.endpoint).getCollectionInfo({
    collection: COLLECTION,
    signal: during.signal
  });
  setTimeout(() => during.abort(), 10);
  await assert.rejects(pending, { code: "QDRANT_ABORTED", retryable: false });
});

test("all methods use internally constructed REST methods, paths and bodies", async (t) => {
  const local = await startServer(t, (request, response) => {
    if (request.url === "/healthz") {
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.end("ok");
      return;
    }
    if (request.method === "GET") return sendJson(response, envelope(collectionResult()));
    if (request.url.endsWith("/points") && request.method === "POST") {
      return sendJson(response, envelope([point()]));
    }
    if (request.url.endsWith("/points/search")) {
      return sendJson(response, envelope([{ ...point(), score: 0.75 }]));
    }
    if (request.url.endsWith("/points/query")) {
      return sendJson(response, envelope({ points: [{ ...point(), score: 0.8 }] }));
    }
    if (request.url.endsWith("/points/scroll")) {
      return sendJson(response, envelope({ points: [point()], next_page_offset: "next" }));
    }
    return sendJson(response, envelope({ operation_id: 7, status: "completed" }));
  });
  const value = provider(`${local.endpoint}/`);
  await value.health({ signal: signal() });
  assert.equal((await value.getCollectionInfo({ collection: COLLECTION, signal: signal() })).exists, true);
  await value.createCollection({ collection: COLLECTION, configuration: { vectors: {} }, signal: signal() });
  await value.createPayloadIndex({ collection: COLLECTION, fieldName: "field", fieldSchema: "keyword", signal: signal() });
  const retrieved = await value.retrievePoints({ collection: COLLECTION, pointIds: ["point-1"], withPayload: true, withVector: true, signal: signal() });
  await value.upsertPoints({ collection: COLLECTION, points: [point()], signal: signal() });
  const searched = await value.searchPoints({ collection: COLLECTION, vector: [1, 0], filter: {}, limit: 3, withPayload: true, withVector: true, scoreThreshold: 0.5, signal: signal() });
  const queried = await value.queryPoints({ collection: COLLECTION, queryPointId: "point-1", filter: { must: [] }, exact: true, limit: 4, withPayload: true, withVector: false, scoreThreshold: 0.7, signal: signal() });
  const scrolled = await value.scrollPayload({ collection: COLLECTION, filter: {}, limit: 3, offset: null, withPayload: true, withVector: false, signal: signal() });

  assert.deepEqual(local.requests.map(({ method, url }) => [method, url]), [
    ["GET", "/healthz"],
    ["GET", `/collections/${COLLECTION}`],
    ["PUT", `/collections/${COLLECTION}`],
    ["PUT", `/collections/${COLLECTION}/index`],
    ["POST", `/collections/${COLLECTION}/points`],
    ["PUT", `/collections/${COLLECTION}/points?wait=true`],
    ["POST", `/collections/${COLLECTION}/points/search`],
    ["POST", `/collections/${COLLECTION}/points/query`],
    ["POST", `/collections/${COLLECTION}/points/scroll`]
  ]);
  assert.equal(local.requests.every(({ headers }) => headers.connection === "close"), true);
  assert.deepEqual(JSON.parse(local.requests[2].body), { vectors: {} });
  assert.deepEqual(JSON.parse(local.requests[3].body), { field_name: "field", field_schema: "keyword" });
  assert.deepEqual(JSON.parse(local.requests[4].body), { ids: ["point-1"], with_payload: true, with_vector: true });
  assert.deepEqual(JSON.parse(local.requests[5].body), { points: [point()] });
  assert.deepEqual(JSON.parse(local.requests[6].body), { vector: [1, 0], filter: {}, limit: 3, with_payload: true, with_vector: true, score_threshold: 0.5 });
  assert.deepEqual(JSON.parse(local.requests[7].body), {
    query: "point-1", filter: { must: [] }, params: { exact: true },
    score_threshold: 0.7, limit: 4, with_payload: true, with_vector: false
  });
  assert.deepEqual(JSON.parse(local.requests[8].body), { filter: {}, limit: 3, offset: null, with_payload: true, with_vector: false });
  assert.deepEqual(retrieved.points[0], point());
  assert.equal(searched.points[0].score, 0.75);
  assert.equal(queried.points[0].score, 0.8);
  assert.equal(queried.exact, true);
  assert.equal(scrolled.nextPageOffset, "next");
  assert.equal(Object.isFrozen(retrieved.points[0].payload), true);
});

test("collection names are validated and URL encoded", async (t) => {
  const local = await startServer(t, (_request, response) => sendJson(response, envelope(collectionResult())));
  const value = provider(local.endpoint);
  await value.getCollectionInfo({ collection: "cache name+v1", signal: signal() });
  assert.equal(local.requests[0].url, "/collections/cache%20name%2Bv1");
  for (const collection of ["", " cache", "cache ", ".", "..", "a/b", "a\\b", "a?b", "a#b", "x".repeat(256)]) {
    await assert.rejects(value.getCollectionInfo({ collection, signal: signal() }), { code: "INVALID_REQUEST" });
  }
  assert.equal(local.requests.length, 1);
});

test("requests are closed and require AbortSignal before network", async (t) => {
  const local = await startServer(t, (_request, response) => sendJson(response, envelope(collectionResult())));
  const value = provider(local.endpoint);
  const invalid = [
    () => value.health({}),
    () => value.health({ signal: signal(), endpoint: local.endpoint }),
    () => value.getCollectionInfo({ collection: COLLECTION, signal: signal(), apiKey: API_KEY }),
    () => value.createCollection({ collection: COLLECTION, configuration: { bad: undefined }, signal: signal() }),
    () => value.retrievePoints({ collection: COLLECTION, pointIds: [], withPayload: true, withVector: true, signal: signal() }),
    () => value.searchPoints({ collection: COLLECTION, vector: [NaN], filter: {}, limit: 1, withPayload: true, withVector: true, signal: signal() }),
    () => value.queryPoints({ collection: COLLECTION, queryPointId: "p", filter: {}, exact: false, limit: 1, withPayload: true, withVector: false, scoreThreshold: 0.7, signal: signal() })
  ];
  for (const invoke of invalid) await assert.rejects(invoke(), { code: "INVALID_REQUEST" });
  assert.equal(local.requests.length, 0);
});

test("success results are normalized and contain only fields needed by later fixes", async (t) => {
  const local = await startServer(t, (request, response) => {
    if (request.method === "GET") return sendJson(response, envelope(collectionResult({ private_debug: PRIVATE_SENTINEL })));
    return sendJson(response, envelope(true, { debug: PRIVATE_SENTINEL }));
  });
  const value = provider(local.endpoint);
  assert.deepEqual(await value.getCollectionInfo({ collection: COLLECTION, signal: signal() }), {
    exists: true,
    collectionStatus: "green",
    config: { params: { vectors: { size: 1024, distance: "Cosine" } } },
    payloadSchema: { user_id_hash: { data_type: "keyword" } }
  });
  assert.deepEqual(await value.createCollection({ collection: COLLECTION, configuration: {}, signal: signal() }), {
    acknowledged: true, operationId: null, status: null
  });
});

test("only the Qdrant missing-collection 404 is normalized", async (t) => {
  let expected = true;
  const local = await startServer(t, (_request, response) => {
    if (expected) return sendJson(response, {
      status: { error: "Not found: Collection `synthetic-cache` doesn't exist!" }, time: 0
    }, 404);
    return sendJson(response, { status: { error: "Not found: route" }, time: 0 }, 404);
  });
  const value = provider(local.endpoint);
  assert.deepEqual(await value.getCollectionInfo({ collection: COLLECTION, signal: signal() }), { exists: false });
  expected = false;
  await assert.rejects(value.getCollectionInfo({ collection: COLLECTION, signal: signal() }), {
    code: "HTTP_ERROR", status: 404, retryable: false
  });
});

test("400, 401, 403 and ordinary 404 are non-retryable", async (t) => {
  for (const status of [400, 401, 403, 404]) {
    const local = await startServer(t, (_request, response) => sendJson(response, { error: PRIVATE_SENTINEL }, status));
    await assert.rejects(provider(local.endpoint).health({ signal: signal() }), {
      code: "HTTP_ERROR", status, retryable: false
    });
  }
});

test("408, 429, 502, 504 and unavailable 503 are retryable with zero retry", async (t) => {
  for (const status of [408, 429, 502, 503, 504]) {
    const local = await startServer(t, (_request, response) => sendJson(response, { error: PRIVATE_SENTINEL }, status));
    await assert.rejects(provider(local.endpoint).health({ signal: signal() }), (error) => {
      assert.equal(error.code, status === 503 ? "QDRANT_UNAVAILABLE" : "HTTP_RETRYABLE");
      assert.equal(error.retryable, true);
      assert.equal(error.status, status);
      return true;
    });
    assert.equal(local.requests.length, 1);
  }
});

test("connection refused and reset are retryable and sanitized", async (t) => {
  const closed = http.createServer();
  await new Promise((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const port = closed.address().port;
  await new Promise((resolve) => closed.close(resolve));
  await assert.rejects(provider(`http://127.0.0.1:${port}`).health({ signal: signal() }), {
    code: "CONNECTION_REFUSED", retryable: true
  });
  const reset = await startServer(t, (request) => request.socket.destroy());
  await assert.rejects(provider(reset.endpoint).health({ signal: signal() }), (error) => {
    assert.equal(error.retryable, true);
    assert.ok(["CONNECTION_RESET", "QDRANT_UNAVAILABLE"].includes(error.code));
    assert.equal(Number.isSafeInteger(error.transportDiagnostic?.requestSequence), true);
    assert.equal(error.transportDiagnostic?.socketReused, null);
    assert.equal(error.transportDiagnostic?.connectionPolicy,
      "PER_REQUEST_CONNECTION_CLOSE");
    assert.equal(error.transportDiagnostic?.responseCompleted, false);
    assert.equal(error.transportDiagnostic?.resetBeforeHeaders, true);
    assert.equal(error.transportDiagnostic?.resetDuringBody, false);
    assert.equal(error.transportDiagnostic?.resetAfterComplete, false);
    return true;
  });
});

test("per-request connections survive a server that destroys reused keep-alive sockets", async (t) => {
  let oldPolicyAttempts = 0;
  const oldSocketRequestCounts = new WeakMap();
  const oldPolicy = await startServer(t, (request, response) => {
    const count = (oldSocketRequestCounts.get(request.socket) || 0) + 1;
    oldSocketRequestCounts.set(request.socket, count);
    oldPolicyAttempts += 1;
    if (count >= 2) {
      request.socket.destroy();
      return;
    }
    sendJson(response, envelope(collectionResult()));
  });

  let oldPolicyReset = false;
  for (let index = 0; index < 20 && !oldPolicyReset; index += 1) {
    try {
      const response = await fetch(`${oldPolicy.endpoint}/collections/${COLLECTION}`);
      await response.text();
    } catch {
      oldPolicyReset = true;
    }
  }
  assert.equal(oldPolicyReset, true);
  assert.ok(oldPolicyAttempts >= 2);

  const fixedSocketRequestCounts = new WeakMap();
  const activeFixedSockets = new Set();
  let fixedPolicyAttempts = 0;
  let maximumFixedRequestsPerSocket = 0;
  const fixedPolicy = await startServer(t, (request, response) => {
    const count = (fixedSocketRequestCounts.get(request.socket) || 0) + 1;
    fixedSocketRequestCounts.set(request.socket, count);
    fixedPolicyAttempts += 1;
    maximumFixedRequestsPerSocket = Math.max(maximumFixedRequestsPerSocket, count);
    sendJson(response, envelope(collectionResult()));
  });
  fixedPolicy.server.on("connection", (socket) => {
    activeFixedSockets.add(socket);
    socket.once("close", () => activeFixedSockets.delete(socket));
  });

  const value = provider(fixedPolicy.endpoint);
  for (let index = 0; index < 250; index += 1) {
    const result = await value.getCollectionInfo({
      collection: COLLECTION,
      signal: signal()
    });
    assert.equal(result.collectionStatus, "green");
  }
  assert.equal(fixedPolicyAttempts, 250);
  assert.equal(maximumFixedRequestsPerSocket, 1);

  for (let index = 0; index < 40 && activeFixedSockets.size > 0; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(activeFixedSockets.size, 0);
});

test("internal timeout and caller abort are distinct and clear pending transport", async (t) => {
  const local = await startServer(t, async (_request, response) => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (!response.destroyed) {
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.end("ok");
    }
  });
  await assert.rejects(provider(local.endpoint, { timeoutMs: 10 }).health({ signal: signal() }), {
    code: "QDRANT_TIMEOUT", retryable: true
  });
  const controller = new AbortController();
  const pending = provider(local.endpoint).health({ signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(pending, { code: "QDRANT_ABORTED", retryable: false });
  const already = new AbortController();
  already.abort();
  await assert.rejects(provider(local.endpoint).health({ signal: already.signal }), {
    code: "QDRANT_ABORTED", retryable: false
  });
});

test("redirects are forbidden and never followed", async (t) => {
  let targetCalls = 0;
  const local = await startServer(t, (request, response) => {
    if (request.url === "/target") targetCalls += 1;
    response.writeHead(302, { Location: "/target" });
    response.end();
  });
  await assert.rejects(provider(local.endpoint).health({ signal: signal() }), {
    code: "REDIRECT_FORBIDDEN", retryable: false
  });
  assert.equal(targetCalls, 0);
});

test("JSON methods enforce content type", async (t) => {
  const local = await startServer(t, (_request, response) => {
    response.writeHead(200, { "Content-Type": "text/plain" });
    response.end(JSON.stringify(envelope(collectionResult())));
  });
  await assert.rejects(provider(local.endpoint).getCollectionInfo({ collection: COLLECTION, signal: signal() }), {
    code: "INVALID_CONTENT_TYPE", retryable: false
  });
});

test("declared and streamed response body limits are enforced", async (t) => {
  const declared = await startServer(t, (_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json", "Content-Length": "1000" });
    response.end("{}");
  });
  await assert.rejects(provider(declared.endpoint, { maxResponseBytes: 32 }).getCollectionInfo({ collection: COLLECTION, signal: signal() }), {
    code: "RESPONSE_TOO_LARGE"
  });
  const streamed = await startServer(t, (_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json", "Transfer-Encoding": "chunked" });
    response.write("x".repeat(24));
    response.end("x".repeat(24));
  });
  await assert.rejects(provider(streamed.endpoint, { maxResponseBytes: 32 }).getCollectionInfo({ collection: COLLECTION, signal: signal() }), {
    code: "RESPONSE_TOO_LARGE"
  });
});

test("invalid JSON, envelope and partial results fail closed", async (t) => {
  const bodies = [
    "{invalid",
    JSON.stringify({ result: collectionResult(), status: "wrong", time: 0 }),
    JSON.stringify(envelope({ status: "green", config: {}, payload_schema: null }))
  ];
  const codes = ["INVALID_HTTP_JSON", "INVALID_QDRANT_ENVELOPE", "INVALID_QDRANT_RESULT"];
  for (let index = 0; index < bodies.length; index += 1) {
    const local = await startServer(t, (_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(bodies[index]);
    });
    await assert.rejects(provider(local.endpoint).getCollectionInfo({ collection: COLLECTION, signal: signal() }), {
      code: codes[index]
    });
  }
});

test("malformed point, search and scroll results are rejected", async (t) => {
  const results = [
    ["invalid-point"],
    [{ id: "p", score: "high" }],
    [{ id: "p", score: "high" }],
    { points: [], next_page_offset: undefined }
  ];
  const local = await startServer(t, (_request, response, _body, requests) => sendJson(response, envelope(results[requests.length - 1])));
  const value = provider(local.endpoint);
  await assert.rejects(value.retrievePoints({ collection: COLLECTION, pointIds: ["p"], withPayload: true, withVector: true, signal: signal() }), { code: "INVALID_QDRANT_RESULT" });
  await assert.rejects(value.searchPoints({ collection: COLLECTION, vector: [1], filter: {}, limit: 1, withPayload: true, withVector: true, signal: signal() }), { code: "INVALID_QDRANT_RESULT" });
  await assert.rejects(value.queryPoints({ collection: COLLECTION, queryPointId: "p", filter: {}, exact: true, limit: 1, withPayload: true, withVector: false, scoreThreshold: 0.7, signal: signal() }), { code: "INVALID_QDRANT_RESULT" });
  await assert.rejects(value.scrollPayload({ collection: COLLECTION, filter: {}, limit: 1, offset: null, withPayload: true, withVector: true, signal: signal() }), { code: "INVALID_QDRANT_RESULT" });
});

test("errors expose no api key, endpoint, raw body, vector or payload", async (t) => {
  const local = await startServer(t, (_request, response) => sendJson(response, { error: PRIVATE_SENTINEL }, 500));
  const value = provider(local.endpoint, { apiKey: API_KEY });
  await assert.rejects(value.upsertPoints({
    collection: COLLECTION,
    points: [{ id: "p", vector: [0.123456789], payload: { secret: PRIVATE_SENTINEL } }],
    signal: signal()
  }), (error) => {
    assert.equal(error instanceof QdrantEmbeddingCacheProviderError, true);
    const serialized = JSON.stringify(error);
    assert.equal(error.message, "Qdrant embedding cache provider request failed");
    assert.doesNotMatch(serialized, new RegExp(API_KEY));
    assert.doesNotMatch(serialized, new RegExp(PRIVATE_SENTINEL));
    assert.doesNotMatch(serialized, /0\.123456789|127\.0\.0\.1/);
    return true;
  });
});

test("provider has zero fallback, zero retry and no delete request implementation", async (t) => {
  const local = await startServer(t, (_request, response) => sendJson(response, { error: PRIVATE_SENTINEL }, 503));
  const value = provider(local.endpoint);
  await assert.rejects(value.health({ signal: signal() }), { code: "QDRANT_UNAVAILABLE" });
  assert.equal(local.requests.length, 1);
  assert.equal(Object.keys(value).some((key) => /fallback|delete|clear|recreate|migrate/i.test(key)), false);
});

test("module reads no environment, storage, cache record, daemon or historic vector path", () => {
  const source = fs.readFileSync(path.join(
    __dirname, "../../core/providers/vector/QdrantEmbeddingCacheProvider.js"
  ), "utf8");
  assert.doesNotMatch(source, /process\.env|JsonMemoryStorage|EmbeddingCacheRecord|VectorIndexAdapter|VectorIndexRecord|HippocampusDaemon|ClusterEngineAdapter|RecallRouter|deleteCollection|deletePoints/);
  assert.doesNotMatch(source, /console\.|logger|fallback|retry\s*\(/i);
});
