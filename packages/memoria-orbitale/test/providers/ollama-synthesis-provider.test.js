"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { fingerprintEmbedding } = require("../../core/clustering/ClusterMath");
const { createClusterRecord } = require("../../core/clustering/ClusterRecord");
const { createSuperMemoryRecord } = require("../../core/consolidation/SuperMemoryRecord");
const { createSynthesisEngine } = require("../../core/synthesis/SynthesisEngine");
const {
  DEFAULT_MODEL,
  OllamaSynthesisProviderError,
  createOllamaSynthesisProvider
} = require("../../core/providers/ollama/OllamaSynthesisProvider");

const MODEL = "qwen3.5:27b";
const SENTINEL = "PRIVATE_RAW_SENTINEL_42";
const IDS = ["synthetic_a", "synthetic_b", "synthetic_c"];

function synthesisOutput(overrides = {}) {
  return {
    schema_version: 1,
    title: "Sintesi temporanea",
    synthesis: "I tre eventi sintetici descrivono la stessa prova controllata.",
    facts: [{ text: "La prova usa tre eventi sintetici.", source_memory_ids: [IDS[0]] }],
    uncertainties: [{ text: "L'esito oltre la prova non è definito.", source_memory_ids: [IDS[1]] }],
    contradictions: [],
    source_memory_ids: [...IDS],
    confidence: 0.75,
    rejected_source_ids: [],
    ...overrides
  };
}

function ollamaEnvelope(output = synthesisOutput(), overrides = {}) {
  return {
    model: MODEL,
    created_at: "2026-07-14T00:00:00Z",
    message: { role: "assistant", content: JSON.stringify(output), thinking: SENTINEL },
    done: true,
    debug: SENTINEL,
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
  return { url: `http://127.0.0.1:${server.address().port}/api/chat`, requests, server };
}

function sendJson(response, value, status = 200, headers = {}) {
  response.writeHead(status, { "Content-Type": "application/json", ...headers });
  response.end(JSON.stringify(value));
}

function provider(url, overrides = {}) {
  return createOllamaSynthesisProvider({
    baseUrl: url,
    model: MODEL,
    timeoutMs: 1000,
    maxResponseBytes: 65536,
    keepAlive: "2m",
    fetchImpl: fetch,
    ...overrides
  });
}

function generateInput(overrides = {}) {
  return {
    requestId: "a".repeat(64),
    messages: [
      { role: "system", content: "Synthetic system instruction" },
      { role: "user", content: "Synthetic source payload" }
    ],
    signal: new AbortController().signal,
    responseFormat: { type: "json_object", schemaVersion: 1 },
    maxOutputChars: 30000,
    ...overrides
  };
}

function clusterRecord() {
  const centroid = [1, 0.5];
  return createClusterRecord({
    userId: "synthetic_user",
    planId: "a".repeat(64),
    createdAt: 1780000000000,
    embedding: { providerId: "synthetic-embedding", model: "none", version: "test-v1" },
    clusterCandidate: {
      schemaVersion: 1,
      algorithmVersion: "complete-link-greedy-v1",
      clusterId: "b".repeat(64),
      memberIds: IDS,
      embeddingDimension: 2,
      centroid,
      centroidFingerprint: fingerprintEmbedding(centroid),
      density: { averageSimilarity: 0.9, minimumSimilarity: 0.8, maximumSimilarity: 1, memberCount: IDS.length },
      policy: { similarityThreshold: 0.7, minClusterSize: 3, maxClusterSize: null },
      reasonCodes: ["CLUSTERED"],
      persisted: false
    }
  });
}

function memories() {
  return IDS.map((id, index) => ({
    id,
    type: "synthetic",
    content: { text: `Evento sintetico correlato numero ${index + 1}` },
    timestamp: 1780000000000 + index,
    preserved: { index, marker: "raw-preserved" }
  }));
}

test("configuration is explicit and provider shape matches SynthesisEngine exactly", () => {
  assert.equal(DEFAULT_MODEL, process.env.PRIMARY_MODEL || MODEL);
  assert.throws(() => createOllamaSynthesisProvider({ baseUrl: "http://user:pass@127.0.0.1:11434/api/chat" }), {
    code: "INVALID_CONFIGURATION"
  });
  assert.throws(() => createOllamaSynthesisProvider({ baseUrl: "http://127.0.0.1:11434/api/generate" }), {
    code: "INVALID_CONFIGURATION"
  });
  assert.throws(() => createOllamaSynthesisProvider({
    baseUrl: "http://127.0.0.1:11434/api/chat", fallbackUrl: "http://127.0.0.1:1/api/chat"
  }), { code: "INVALID_CONFIGURATION" });
  const value = createOllamaSynthesisProvider({ baseUrl: "http://127.0.0.1:11434/api/chat" });
  assert.deepEqual(Object.keys(value).sort(), ["generate", "model", "providerId", "schemaVersion", "version"]);
  assert.equal(value.model, process.env.PRIMARY_MODEL || MODEL);
  assert.match(value.version, new RegExp(`${value.model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
  assert.doesNotThrow(() => createSynthesisEngine({ modelProvider: value }));
});

test("payload uses /api/chat, explicit Qwen, non-stream JSON, think false and keep_alive without fallback", async (t) => {
  const local = await startServer(t, (_request, response) => sendJson(response, ollamaEnvelope()));
  const input = generateInput();
  const result = await provider(local.url).generate(input);
  assert.equal(result.status, 200);
  assert.equal(local.requests.length, 1);
  const request = local.requests[0];
  const body = JSON.parse(request.body);
  assert.equal(request.method, "POST");
  assert.equal(request.url, "/api/chat");
  assert.equal(request.headers["content-type"], "application/json");
  assert.deepEqual(Object.keys(body).sort(), ["format", "keep_alive", "messages", "model", "stream", "think"]);
  assert.equal(body.model, MODEL);
  assert.equal(body.stream, false);
  assert.equal(body.format, "json");
  assert.equal(body.think, false);
  assert.equal(body.keep_alive, "2m");
  assert.deepEqual(body.messages, input.messages);
  assert.doesNotMatch(request.body, /fallback/i);
});

test("valid Ollama response returns only the final synthesis content", async (t) => {
  const local = await startServer(t, (_request, response) => sendJson(response, ollamaEnvelope()));
  const result = await provider(local.url).generate(generateInput());
  assert.deepEqual(Object.keys(result).sort(), ["ok", "status", "text"]);
  assert.deepEqual(JSON.parse(result.text), synthesisOutput());
  assert.doesNotMatch(JSON.stringify(result), new RegExp(SENTINEL));
});

test("different response model is rejected without preserving provider body", async (t) => {
  const local = await startServer(t, (_request, response) => sendJson(response, ollamaEnvelope(undefined, { model: "gemma4:e2b" })));
  await assert.rejects(provider(local.url).generate(generateInput()), (error) => {
    assert.equal(error.code, "MODEL_MISMATCH");
    assert.equal(error.retryable, false);
    assert.doesNotMatch(JSON.stringify(error), /gemma|qwen|PRIVATE/);
    return true;
  });
});

test("provider timeout aborts transport and is retryable", async (t) => {
  const local = await startServer(t, async (_request, response) => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (!response.destroyed) sendJson(response, ollamaEnvelope());
  });
  await assert.rejects(provider(local.url, { timeoutMs: 15 }).generate(generateInput()), {
    code: "SYNTHESIS_TIMEOUT", retryable: true
  });
});

test("external abort is forwarded and sanitized", async (t) => {
  const local = await startServer(t, async (_request, response) => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (!response.destroyed) sendJson(response, ollamaEnvelope());
  });
  const controller = new AbortController();
  const pending = provider(local.url).generate(generateInput({ signal: controller.signal }));
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(pending, { code: "SYNTHESIS_ABORTED", retryable: true });
});

test("connection refused is retryable and sanitized", async () => {
  const socket = http.createServer();
  await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  await assert.rejects(provider(`http://127.0.0.1:${port}/api/chat`).generate(generateInput()), (error) => {
    assert.equal(error.code, "CONNECTION_REFUSED");
    assert.equal(error.retryable, true);
    assert.equal(error.message, "Ollama synthesis provider request failed");
    return true;
  });
});

test("retryable HTTP statuses are classified without consuming raw error body", async (t) => {
  for (const status of [429, 502, 503, 504]) {
    const local = await startServer(t, (_request, response) => sendJson(response, { error: SENTINEL }, status));
    await assert.rejects(provider(local.url).generate(generateInput()), (error) => {
      assert.equal(error.code, "HTTP_RETRYABLE");
      assert.equal(error.status, status);
      assert.equal(error.retryable, true);
      assert.doesNotMatch(JSON.stringify(error), new RegExp(SENTINEL));
      return true;
    });
  }
});

test("non-retryable HTTP status is classified and sanitized", async (t) => {
  const local = await startServer(t, (_request, response) => sendJson(response, { error: SENTINEL }, 400));
  await assert.rejects(provider(local.url).generate(generateInput()), {
    code: "HTTP_ERROR", status: 400, retryable: false
  });
});

test("invalid HTTP JSON is rejected without repair", async (t) => {
  const local = await startServer(t, (_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(`{invalid ${SENTINEL}`);
  });
  await assert.rejects(provider(local.url).generate(generateInput()), (error) => {
    assert.equal(error.code, "INVALID_HTTP_JSON");
    assert.doesNotMatch(JSON.stringify(error), new RegExp(SENTINEL));
    return true;
  });
});

test("invalid synthesis JSON schema remains an SynthesisEngine validation failure", async (t) => {
  const invalid = synthesisOutput({ confidence: 2 });
  const local = await startServer(t, (_request, response) => sendJson(response, ollamaEnvelope(invalid)));
  const engine = createSynthesisEngine({ modelProvider: provider(local.url) });
  await assert.rejects(engine.synthesize({ clusterRecord: clusterRecord(), memories: memories() }), {
    code: "INVALID_SYNTHESIS_OUTPUT", phase: "validation"
  });
});

test("body larger than configured byte limit is rejected", async (t) => {
  const local = await startServer(t, (_request, response) => sendJson(response, ollamaEnvelope(), 200, { "X-Pad": "x" }));
  await assert.rejects(provider(local.url, { maxResponseBytes: 32 }).generate(generateInput()), {
    code: "RESPONSE_TOO_LARGE"
  });
});

test("redirect is rejected and target is never called", async (t) => {
  let targetHits = 0;
  const local = await startServer(t, (request, response) => {
    if (request.url === "/target") {
      targetHits += 1;
      sendJson(response, ollamaEnvelope());
      return;
    }
    response.writeHead(302, { Location: "/target" });
    response.end();
  });
  await assert.rejects(provider(local.url).generate(generateInput()), { code: "REDIRECT_FORBIDDEN" });
  assert.equal(targetHits, 0);
});

test("content type, complete done marker and final content are mandatory", async (t) => {
  const wrongType = await startServer(t, (_request, response) => {
    response.writeHead(200, { "Content-Type": "text/plain" });
    response.end(JSON.stringify(ollamaEnvelope()));
  });
  await assert.rejects(provider(wrongType.url).generate(generateInput()), { code: "INVALID_CONTENT_TYPE" });
  const partial = await startServer(t, (_request, response) => sendJson(response, ollamaEnvelope(undefined, { done: false })));
  await assert.rejects(provider(partial.url).generate(generateInput()), { code: "INVALID_OLLAMA_RESPONSE" });
  const empty = await startServer(t, (_request, response) => sendJson(response, ollamaEnvelope(undefined, {
    message: { role: "assistant", content: "" }
  })));
  await assert.rejects(provider(empty.url).generate(generateInput()), { code: "EMPTY_RESPONSE" });
});

test("errors never expose request messages or raw response sentinels", async (t) => {
  const local = await startServer(t, (_request, response) => sendJson(response, { error: SENTINEL }, 500));
  const input = generateInput({ messages: [{ role: "user", content: SENTINEL }] });
  await assert.rejects(provider(local.url).generate(input), (error) => {
    assert.equal(error instanceof OllamaSynthesisProviderError, true);
    assert.doesNotMatch(error.message, new RegExp(SENTINEL));
    assert.doesNotMatch(JSON.stringify(error), new RegExp(SENTINEL));
    return true;
  });
});

test("end-to-end SynthesisEngine records exact Qwen provenance", async (t) => {
  const local = await startServer(t, (_request, response) => sendJson(response, ollamaEnvelope()));
  const result = await createSynthesisEngine({ modelProvider: provider(local.url) }).synthesize({
    clusterRecord: clusterRecord(), memories: memories()
  });
  assert.equal(result.provider.model, MODEL);
  assert.equal(result.provider.version, `ollama-http-chat-v1+${MODEL}`);
  assert.match(result.requestId, /^[a-f0-9]{64}$/);
  assert.deepEqual(result.output.source_memory_ids, IDS);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(SENTINEL));
});

test("SuperMemoryRecord is built only under os.tmpdir and raw synthetic bytes remain exact", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-provider-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(path.relative(os.tmpdir(), root).startsWith(".."), false);
  const rawPath = path.join(root, "raw-synthetic.json");
  const original = JSON.stringify(memories(), null, 2);
  fs.writeFileSync(rawPath, original, { mode: 0o600 });
  const local = await startServer(t, (_request, response) => sendJson(response, ollamaEnvelope()));
  const record = clusterRecord();
  const result = await createSynthesisEngine({ modelProvider: provider(local.url) }).synthesize({
    clusterRecord: record, memories: JSON.parse(fs.readFileSync(rawPath, "utf8"))
  });
  const superMemory = createSuperMemoryRecord({
    userId: "synthetic_user",
    clusterRecord: record,
    synthesisResult: result,
    committedAt: 1780000001000,
    processingAttemptId: "synthetic-attempt"
  });
  fs.writeFileSync(path.join(root, "super-memory.json"), JSON.stringify(superMemory), { mode: 0o600 });
  assert.equal(superMemory.synthesis.model, MODEL);
  assert.equal(superMemory.source_memory_ids.length, 3);
  assert.equal(fs.readFileSync(rawPath, "utf8"), original);
  assert.doesNotMatch(JSON.stringify(superMemory), new RegExp(SENTINEL));
});

test("one configured endpoint receives every request and no fallback call is possible", async (t) => {
  const primary = await startServer(t, (_request, response) => sendJson(response, ollamaEnvelope()));
  const fallback = await startServer(t, (_request, response) => sendJson(response, ollamaEnvelope()));
  const value = provider(primary.url);
  await value.generate(generateInput());
  assert.equal(primary.requests.length, 1);
  assert.equal(fallback.requests.length, 0);
  assert.doesNotMatch(JSON.stringify(value), /fallback/i);
});
