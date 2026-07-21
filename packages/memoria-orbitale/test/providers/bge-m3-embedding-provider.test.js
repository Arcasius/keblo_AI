"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const http = require("node:http");
const test = require("node:test");

const {
  EXPECTED_MODEL,
  EXPECTED_REVISION,
  EXPECTED_DIMENSION,
  EXPECTED_NORMALIZED,
  NORMALIZED_NORM_TOLERANCE,
  BgeM3EmbeddingProviderError,
  createBgeM3EmbeddingProvider
} = require("../../core/providers/embedding/BgeM3EmbeddingProvider");

const API_KEY = "synthetic-test-api-key";
const SENTINEL = "PRIVATE_TEXT_OR_EMBEDDING_SENTINEL";
const INPUTS = [
  { id: "synthetic-a", text: "Primo testo interamente sintetico." },
  { id: "synthetic-b", text: "Secondo testo interamente sintetico." }
];

function hash(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function vector(position = 0) {
  const value = new Array(EXPECTED_DIMENSION).fill(0);
  value[position] = 1;
  return value;
}

function embedding(item, position = 0, overrides = {}) {
  return { id: item.id, contentHash: hash(item.text), embedding: vector(position), ...overrides };
}

function envelope(overrides = {}) {
  return {
    model: EXPECTED_MODEL,
    revision: EXPECTED_REVISION,
    dimension: EXPECTED_DIMENSION,
    normalized: EXPECTED_NORMALIZED,
    latency_ms: 1.25,
    items: INPUTS.map((item, index) => embedding(item, index)),
    ...overrides
  };
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
  return { url: `http://127.0.0.1:${server.address().port}/api/v1/embed`, requests, server };
}

function sendJson(response, value, status = 200, headers = {}) {
  response.writeHead(status, { "Content-Type": "application/json", ...headers });
  response.end(JSON.stringify(value));
}

function provider(url, overrides = {}) {
  return createBgeM3EmbeddingProvider({
    baseUrl: url,
    apiKey: API_KEY,
    timeoutMs: 1000,
    maxResponseBytes: 1024 * 1024,
    fetchImpl: fetch,
    ...overrides
  });
}

function request(items = INPUTS, overrides = {}) {
  return { items, signal: new AbortController().signal, ...overrides };
}

test("configuration is explicit, fixed to BGE-M3 provenance and has no fallback", () => {
  const credentialUrl = new URL("http://example.test/api/v1/embed");
  credentialUrl.username = "synthetic-user";
  credentialUrl.password = "synthetic-password";
  for (const options of [
    {},
    { baseUrl: "ftp://example.test/api/v1/embed", apiKey: API_KEY },
    { baseUrl: credentialUrl.toString(), apiKey: API_KEY },
    { baseUrl: "http://example.test/api/v1/embed", apiKey: "" },
    { baseUrl: "http://example.test/api/v1/embed", apiKey: API_KEY, fallbackUrl: "http://example.test" }
  ]) {
    assert.throws(() => createBgeM3EmbeddingProvider(options), { code: "INVALID_CONFIGURATION" });
  }
  const value = provider("http://127.0.0.1:8001/api/v1/embed");
  assert.deepEqual(Object.keys(value).sort(), [
    "dimension", "embedBatch", "model", "normalized", "providerId", "revision", "schemaVersion", "version"
  ]);
  assert.equal(value.model, EXPECTED_MODEL);
  assert.equal(value.revision, EXPECTED_REVISION);
  assert.equal(value.dimension, 1024);
  assert.equal(value.normalized, true);
  assert.doesNotMatch(JSON.stringify(value), /fallback|api-key/i);
});

test("successful batch sends API key and exact UTF-8 hashes, then restores request order", async (t) => {
  const local = await startServer(t, (_request, response) => sendJson(response, {
    ...envelope(), items: [...envelope().items].reverse()
  }));
  const result = await provider(local.url).embedBatch(request());
  assert.equal(local.requests.length, 1);
  const received = local.requests[0];
  const body = JSON.parse(received.body);
  assert.equal(received.method, "POST");
  assert.equal(received.url, "/api/v1/embed");
  assert.equal(received.headers["x-api-key"], API_KEY);
  assert.deepEqual(Object.keys(body), ["items"]);
  assert.deepEqual(body.items.map(({ id, text }) => ({ id, text })), INPUTS);
  assert.deepEqual(body.items.map((item) => item.contentHash), INPUTS.map((item) => hash(item.text)));
  assert.deepEqual(result.map((item) => item.id), INPUTS.map((item) => item.id));
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result[0].embedding), true);
});

test("request rejects missing fields, duplicate IDs and caller-provided hashes", async () => {
  const value = provider("http://127.0.0.1:8001/api/v1/embed", { fetchImpl: () => { throw new Error("not called"); } });
  await assert.rejects(value.embedBatch({ items: [], signal: new AbortController().signal }), { code: "INVALID_REQUEST" });
  await assert.rejects(value.embedBatch(request([INPUTS[0], INPUTS[0]])), { code: "INVALID_REQUEST" });
  await assert.rejects(value.embedBatch(request([{ ...INPUTS[0], contentHash: hash(INPUTS[0].text) }])), { code: "INVALID_REQUEST" });
});

test("timeout and external abort are retryable and sanitized", async (t) => {
  const local = await startServer(t, async (_request, response) => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (!response.destroyed) sendJson(response, envelope());
  });
  await assert.rejects(provider(local.url, { timeoutMs: 10 }).embedBatch(request()), {
    code: "EMBEDDING_TIMEOUT", retryable: true
  });
  const controller = new AbortController();
  const pending = provider(local.url).embedBatch(request(INPUTS, { signal: controller.signal }));
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(pending, { code: "EMBEDDING_ABORTED", retryable: true });
});

test("connection refused and reset are retryable", async (t) => {
  const closed = http.createServer();
  await new Promise((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const closedPort = closed.address().port;
  await new Promise((resolve) => closed.close(resolve));
  await assert.rejects(provider(`http://127.0.0.1:${closedPort}/api/v1/embed`).embedBatch(request()), {
    code: "CONNECTION_REFUSED", retryable: true
  });
  const reset = await startServer(t, (incoming) => incoming.socket.destroy());
  await assert.rejects(provider(reset.url).embedBatch(request()), (error) => {
    assert.equal(error.retryable, true);
    assert.ok(["CONNECTION_RESET", "NETWORK_UNAVAILABLE"].includes(error.code));
    return true;
  });
});

test("401 and 403 are non-retryable authentication failures", async (t) => {
  for (const status of [401, 403]) {
    const local = await startServer(t, (_request, response) => sendJson(response, { detail: SENTINEL }, status));
    await assert.rejects(provider(local.url).embedBatch(request()), {
      code: "AUTHENTICATION_FAILED", status, retryable: false
    });
  }
});

test("429, 502, 503 and 504 are retryable without automatic retry", async (t) => {
  for (const status of [429, 502, 503, 504]) {
    const local = await startServer(t, (_request, response) => sendJson(response, { detail: SENTINEL }, status));
    await assert.rejects(provider(local.url).embedBatch(request()), {
      code: "HTTP_RETRYABLE", status, retryable: true
    });
    assert.equal(local.requests.length, 1);
  }
});

test("redirect is forbidden and its target is never requested", async (t) => {
  let targetCalls = 0;
  const local = await startServer(t, (incoming, response) => {
    if (incoming.url === "/target") targetCalls += 1;
    response.writeHead(302, { Location: "/target" });
    response.end();
  });
  await assert.rejects(provider(local.url).embedBatch(request()), { code: "REDIRECT_FORBIDDEN", retryable: false });
  assert.equal(targetCalls, 0);
});

test("content type, declared size and streamed body limit are enforced", async (t) => {
  const wrongType = await startServer(t, (_request, response) => {
    response.writeHead(200, { "Content-Type": "text/plain" });
    response.end(JSON.stringify(envelope()));
  });
  await assert.rejects(provider(wrongType.url).embedBatch(request()), { code: "INVALID_CONTENT_TYPE" });
  const tooLarge = await startServer(t, (_request, response) => sendJson(response, envelope()));
  await assert.rejects(provider(tooLarge.url, { maxResponseBytes: 32 }).embedBatch(request()), {
    code: "RESPONSE_TOO_LARGE"
  });
});

test("invalid JSON including NaN is rejected without repair", async (t) => {
  const local = await startServer(t, (_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(`{"model":"${EXPECTED_MODEL}","items":[NaN]}`);
  });
  await assert.rejects(provider(local.url).embedBatch(request()), { code: "INVALID_HTTP_JSON", retryable: false });
});

test("model, revision, dimension and normalized provenance must match exactly", async (t) => {
  const cases = [
    [{ model: "other/model" }, "MODEL_MISMATCH"],
    [{ revision: "0".repeat(40) }, "REVISION_MISMATCH"],
    [{ dimension: 768 }, "DIMENSION_MISMATCH"],
    [{ normalized: false }, "NORMALIZATION_MISMATCH"]
  ];
  for (const [override, code] of cases) {
    const local = await startServer(t, (_request, response) => sendJson(response, envelope(override)));
    await assert.rejects(provider(local.url).embedBatch(request()), { code, retryable: false });
  }
});

test("response count and IDs reject missing, duplicate and unexpected elements", async (t) => {
  const cases = [
    [[embedding(INPUTS[0])], "ITEM_COUNT_MISMATCH"],
    [[embedding(INPUTS[0]), embedding(INPUTS[0])], "DUPLICATE_RESPONSE_ID"],
    [[embedding(INPUTS[0]), { ...embedding(INPUTS[1]), id: "unexpected" }], "UNEXPECTED_RESPONSE_ID"],
    [[embedding(INPUTS[0]), { contentHash: hash(INPUTS[1].text), vector: vector(1) }], "INVALID_RESPONSE_ITEM"]
  ];
  for (const [items, code] of cases) {
    const local = await startServer(t, (_request, response) => sendJson(response, envelope({ items })));
    await assert.rejects(provider(local.url).embedBatch(request()), { code, retryable: false });
  }
});

test("response content hash must match exact request text", async (t) => {
  const items = envelope().items;
  items[0] = { ...items[0], contentHash: "0".repeat(64) };
  const local = await startServer(t, (_request, response) => sendJson(response, envelope({ items })));
  await assert.rejects(provider(local.url).embedBatch(request()), { code: "CONTENT_HASH_MISMATCH" });
});

test("vectors must have exactly 1024 finite numeric values", async (t) => {
  const cases = [
    [[1], "VECTOR_LENGTH_MISMATCH"],
    [[...vector().slice(0, -1), "not-a-number"], "INVALID_VECTOR_VALUE"],
    [[...vector().slice(0, -1), null], "INVALID_VECTOR_VALUE"]
  ];
  for (const [invalidVector, code] of cases) {
    const items = envelope().items;
    items[0] = { ...items[0], embedding: invalidVector };
    const local = await startServer(t, (_request, response) => sendJson(response, envelope({ items })));
    await assert.rejects(provider(local.url).embedBatch(request()), { code });
  }
});

test("JSON numeric overflow to Infinity is rejected as a non-finite vector value", async (t) => {
  const valid = JSON.stringify(envelope());
  const overflowing = valid.replace('"embedding":[1,', '"embedding":[1e400,');
  const local = await startServer(t, (_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(overflowing);
  });
  await assert.rejects(provider(local.url).embedBatch(request()), { code: "INVALID_VECTOR_VALUE" });
});

test("normalized vector norm uses the documented absolute tolerance", async (t) => {
  assert.equal(NORMALIZED_NORM_TOLERANCE, 1e-3);
  const accepted = vector();
  accepted[0] = 1 + NORMALIZED_NORM_TOLERANCE / 2;
  const okItems = envelope().items;
  okItems[0] = { ...okItems[0], embedding: accepted };
  const ok = await startServer(t, (_request, response) => sendJson(response, envelope({ items: okItems })));
  await assert.doesNotReject(provider(ok.url).embedBatch(request()));
  const rejected = vector();
  rejected[0] = 1 + NORMALIZED_NORM_TOLERANCE * 2;
  const badItems = envelope().items;
  badItems[0] = { ...badItems[0], embedding: rejected };
  const bad = await startServer(t, (_request, response) => sendJson(response, envelope({ items: badItems })));
  await assert.rejects(provider(bad.url).embedBatch(request()), { code: "INVALID_VECTOR_NORM" });
});

test("errors expose no API key, text, embedding or server body", async (t) => {
  const local = await startServer(t, (_request, response) => sendJson(response, { detail: SENTINEL }, 500));
  await assert.rejects(provider(local.url).embedBatch(request()), (error) => {
    assert.equal(error instanceof BgeM3EmbeddingProviderError, true);
    const serialized = JSON.stringify(error);
    assert.equal(error.message, "BGE-M3 embedding provider request failed");
    assert.doesNotMatch(serialized, new RegExp(API_KEY));
    assert.doesNotMatch(serialized, new RegExp(SENTINEL));
    assert.doesNotMatch(serialized, /Primo testo|\[1,0,0/);
    return true;
  });
});

test("one configured endpoint receives one batch and fallback receives zero calls", async (t) => {
  const primary = await startServer(t, (_request, response) => sendJson(response, envelope()));
  const fallback = await startServer(t, (_request, response) => sendJson(response, envelope()));
  const value = provider(primary.url);
  await value.embedBatch(request());
  assert.equal(primary.requests.length, 1);
  assert.equal(fallback.requests.length, 0);
  assert.doesNotMatch(JSON.stringify(value), /fallback/i);
});
