"use strict";

const { createHash } = require("node:crypto");

const EXPECTED_MODEL = "BAAI/bge-m3";
const EXPECTED_REVISION = "5617a9f61b028005a4858fdac845db406aefb181";
const EXPECTED_DIMENSION = 1024;
const EXPECTED_NORMALIZED = true;
const NORMALIZED_NORM_TOLERANCE = 1e-3;
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const PROVIDER_ID = "bge-m3-http-embedding";
const TRANSPORT_VERSION = "bge-m3-http-embed-v1";
const OPTION_KEYS = new Set([
  "baseUrl", "apiKey", "timeoutMs", "maxResponseBytes", "fetchImpl"
]);
const REQUEST_KEYS = ["items", "signal"];
const ITEM_KEYS = ["id", "text"];
const RESPONSE_KEYS = ["model", "revision", "dimension", "normalized", "latency_ms", "items"];
const RESPONSE_ITEM_KEYS = ["id", "contentHash", "embedding"];
const RETRYABLE_HTTP_STATUS = new Set([429, 502, 503, 504]);
const HEX_64 = /^[a-f0-9]{64}$/;

class BgeM3EmbeddingProviderError extends Error {
  constructor(code, phase, retryable, details = {}) {
    super("BGE-M3 embedding provider request failed");
    this.name = "BgeM3EmbeddingProviderError";
    this.code = code;
    this.phase = phase;
    this.retryable = retryable;
    if (Number.isInteger(details.status)) this.status = details.status;
  }
}

function fail(code, phase, retryable = false, details) {
  throw new BgeM3EmbeddingProviderError(code, phase, retryable, details);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, expected) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function deepFreeze(value) {
  Object.freeze(value);
  for (const child of Object.values(value)) {
    if (child && typeof child === "object" && !Object.isFrozen(child)) deepFreeze(child);
  }
  return value;
}

function contentHash(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function validateOptions(options) {
  if (!isPlainObject(options) || Object.keys(options).some((key) => !OPTION_KEYS.has(key))) {
    fail("INVALID_CONFIGURATION", "configuration");
  }
  if (typeof options.baseUrl !== "string" || options.baseUrl.trim().length === 0 ||
      typeof options.apiKey !== "string" || options.apiKey.trim().length === 0 ||
      /[\r\n]/.test(options.apiKey)) {
    fail("INVALID_CONFIGURATION", "configuration");
  }
  let endpoint;
  try {
    endpoint = new URL(options.baseUrl);
  } catch {
    fail("INVALID_CONFIGURATION", "configuration");
  }
  if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password ||
      endpoint.hash || endpoint.search || endpoint.pathname !== "/api/v1/embed") {
    fail("INVALID_CONFIGURATION", "configuration");
  }
  const timeoutMs = options.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : options.timeoutMs;
  const maxResponseBytes = options.maxResponseBytes === undefined
    ? DEFAULT_MAX_RESPONSE_BYTES
    : options.maxResponseBytes;
  const fetchImpl = options.fetchImpl === undefined ? globalThis.fetch : options.fetchImpl;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 ||
      !Number.isInteger(maxResponseBytes) || maxResponseBytes <= 0 ||
      typeof fetchImpl !== "function") {
    fail("INVALID_CONFIGURATION", "configuration");
  }
  return {
    endpoint: endpoint.toString(), apiKey: options.apiKey, timeoutMs, maxResponseBytes, fetchImpl
  };
}

function validateRequest(input) {
  if (!hasExactKeys(input, REQUEST_KEYS) || !Array.isArray(input.items) || input.items.length === 0 ||
      !input.signal || typeof input.signal.addEventListener !== "function" ||
      typeof input.signal.aborted !== "boolean") {
    fail("INVALID_REQUEST", "request");
  }
  const ids = new Set();
  const items = input.items.map((item) => {
    if (!hasExactKeys(item, ITEM_KEYS) || typeof item.id !== "string" || item.id.trim().length === 0 ||
        typeof item.text !== "string" || item.text.length === 0 || ids.has(item.id)) {
      fail("INVALID_REQUEST", "request");
    }
    ids.add(item.id);
    return { id: item.id, text: item.text, contentHash: contentHash(item.text) };
  });
  return items;
}

function networkFailure(error) {
  const code = error?.cause?.code || error?.code;
  if (code === "ECONNREFUSED") return "CONNECTION_REFUSED";
  if (["ECONNRESET", "EPIPE", "UND_ERR_SOCKET"].includes(code)) return "CONNECTION_RESET";
  return "NETWORK_UNAVAILABLE";
}

async function readLimitedBody(response, maxResponseBytes) {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsed = Number(declaredLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maxResponseBytes) {
      fail("RESPONSE_TOO_LARGE", "response");
    }
  }
  if (!response.body || typeof response.body.getReader !== "function") {
    fail("INVALID_HTTP_BODY", "response");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxResponseBytes) {
      await reader.cancel().catch(() => {});
      fail("RESPONSE_TOO_LARGE", "response");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    fail("INVALID_HTTP_BODY", "response");
  }
}

function validateEnvelope(envelope, requestedItems) {
  if (!hasExactKeys(envelope, RESPONSE_KEYS) || envelope.model !== EXPECTED_MODEL ||
      envelope.revision !== EXPECTED_REVISION || envelope.dimension !== EXPECTED_DIMENSION ||
      envelope.normalized !== EXPECTED_NORMALIZED || typeof envelope.latency_ms !== "number" ||
      !Number.isFinite(envelope.latency_ms) || envelope.latency_ms < 0 || !Array.isArray(envelope.items)) {
    if (isPlainObject(envelope) && envelope.model !== EXPECTED_MODEL) fail("MODEL_MISMATCH", "provenance");
    if (isPlainObject(envelope) && envelope.revision !== EXPECTED_REVISION) fail("REVISION_MISMATCH", "provenance");
    if (isPlainObject(envelope) && envelope.dimension !== EXPECTED_DIMENSION) fail("DIMENSION_MISMATCH", "provenance");
    if (isPlainObject(envelope) && envelope.normalized !== EXPECTED_NORMALIZED) fail("NORMALIZATION_MISMATCH", "provenance");
    fail("INVALID_RESPONSE_CONTRACT", "response");
  }
  if (envelope.items.length !== requestedItems.length) {
    fail("ITEM_COUNT_MISMATCH", "response");
  }
  const expected = new Map(requestedItems.map((item) => [item.id, item]));
  const received = new Map();
  for (const item of envelope.items) {
    if (!hasExactKeys(item, RESPONSE_ITEM_KEYS) || typeof item.id !== "string" ||
        !HEX_64.test(item.contentHash || "") || !Array.isArray(item.embedding)) {
      fail("INVALID_RESPONSE_ITEM", "response");
    }
    if (received.has(item.id)) fail("DUPLICATE_RESPONSE_ID", "response");
    const requestItem = expected.get(item.id);
    if (!requestItem) fail("UNEXPECTED_RESPONSE_ID", "response");
    if (item.contentHash !== requestItem.contentHash) fail("CONTENT_HASH_MISMATCH", "provenance");
    if (item.embedding.length !== EXPECTED_DIMENSION) fail("VECTOR_LENGTH_MISMATCH", "response");
    let normSquared = 0;
    for (const value of item.embedding) {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        fail("INVALID_VECTOR_VALUE", "response");
      }
      normSquared += value * value;
    }
    const norm = Math.sqrt(normSquared);
    if (!Number.isFinite(norm) || Math.abs(norm - 1) > NORMALIZED_NORM_TOLERANCE) {
      fail("INVALID_VECTOR_NORM", "response");
    }
    received.set(item.id, deepFreeze({
      id: item.id, contentHash: item.contentHash, embedding: [...item.embedding]
    }));
  }
  for (const item of requestedItems) {
    if (!received.has(item.id)) fail("MISSING_RESPONSE_ID", "response");
  }
  return deepFreeze(requestedItems.map((item) => received.get(item.id)));
}

function createBgeM3EmbeddingProvider(options) {
  const config = validateOptions(options);
  const provider = {
    schemaVersion: 1,
    providerId: PROVIDER_ID,
    model: EXPECTED_MODEL,
    revision: EXPECTED_REVISION,
    dimension: EXPECTED_DIMENSION,
    normalized: EXPECTED_NORMALIZED,
    version: `${TRANSPORT_VERSION}+${EXPECTED_REVISION}`,
    async embedBatch(input) {
      const items = validateRequest(input);
      const controller = new AbortController();
      let timedOut = false;
      const abortFromCaller = () => controller.abort();
      if (input.signal.aborted) controller.abort();
      else input.signal.addEventListener("abort", abortFromCaller, { once: true });
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, config.timeoutMs);
      let response;
      try {
        try {
          response = await config.fetchImpl(config.endpoint, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Accept": "application/json",
              "X-API-Key": config.apiKey
            },
            redirect: "manual",
            signal: controller.signal,
            body: JSON.stringify({ items })
          });
        } catch (error) {
          if (controller.signal.aborted) {
            fail(timedOut ? "EMBEDDING_TIMEOUT" : "EMBEDDING_ABORTED", "transport", true);
          }
          fail(networkFailure(error), "transport", true);
        }
        if (!response || typeof response.status !== "number" || !response.headers) {
          fail("INVALID_HTTP_RESPONSE", "response");
        }
        if (response.status >= 300 && response.status <= 399) {
          if (response.body) await response.body.cancel().catch(() => {});
          fail("REDIRECT_FORBIDDEN", "response", false, { status: response.status });
        }
        if (!response.ok) {
          if (response.body) await response.body.cancel().catch(() => {});
          if ([401, 403].includes(response.status)) {
            fail("AUTHENTICATION_FAILED", "response", false, { status: response.status });
          }
          fail(
            RETRYABLE_HTTP_STATUS.has(response.status) ? "HTTP_RETRYABLE" : "HTTP_ERROR",
            "response",
            RETRYABLE_HTTP_STATUS.has(response.status),
            { status: response.status }
          );
        }
        const contentType = response.headers.get("content-type") || "";
        if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
          if (response.body) await response.body.cancel().catch(() => {});
          fail("INVALID_CONTENT_TYPE", "response");
        }
        let body;
        try {
          body = await readLimitedBody(response, config.maxResponseBytes);
        } catch (error) {
          if (error instanceof BgeM3EmbeddingProviderError) throw error;
          if (controller.signal.aborted) {
            fail(timedOut ? "EMBEDDING_TIMEOUT" : "EMBEDDING_ABORTED", "transport", true);
          }
          fail("CONNECTION_RESET", "response", true);
        }
        let envelope;
        try {
          envelope = JSON.parse(body);
        } catch {
          fail("INVALID_HTTP_JSON", "response");
        }
        return validateEnvelope(envelope, items);
      } finally {
        clearTimeout(timer);
        input.signal.removeEventListener?.("abort", abortFromCaller);
      }
    }
  };
  return Object.freeze(provider);
}

module.exports = {
  EXPECTED_MODEL,
  EXPECTED_REVISION,
  EXPECTED_DIMENSION,
  EXPECTED_NORMALIZED,
  NORMALIZED_NORM_TOLERANCE,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_RESPONSE_BYTES,
  BgeM3EmbeddingProviderError,
  createBgeM3EmbeddingProvider
};
