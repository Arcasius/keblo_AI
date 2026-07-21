"use strict";

const QDRANT_PROVIDER_SCHEMA_VERSION = 1;
const MIN_TIMEOUT_MS = 1;
const MAX_TIMEOUT_MS = 300000;
const MIN_RESPONSE_BYTES = 1;
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const OPTION_KEYS = Object.freeze([
  "endpoint", "apiKey", "timeoutMs", "maxResponseBytes", "providerId"
]);
const RETRYABLE_HTTP_STATUS = new Set([408, 429, 502, 504]);
// Deterministic per-request transport trades connection setup cost for avoiding
// shared keep-alive socket lifecycle coupling across sequential cache reads.
const CONNECTION_POLICY = "PER_REQUEST_CONNECTION_CLOSE";
let globalRequestSequence = 0;

class QdrantEmbeddingCacheProviderError extends Error {
  constructor(code, phase, retryable, details = {}) {
    super("Qdrant embedding cache provider request failed");
    this.name = "QdrantEmbeddingCacheProviderError";
    this.code = code;
    this.phase = phase;
    this.retryable = retryable;
    if (Number.isInteger(details.status)) this.status = details.status;
    if (details.transportDiagnostic) {
      this.transportDiagnostic = Object.freeze({
        ...details.transportDiagnostic
      });
    }
  }
}

function fail(code, phase, retryable = false, details) {
  throw new QdrantEmbeddingCacheProviderError(code, phase, retryable, details);
}

function transportDiagnostic(requestSequence, stage, responseCompleted = false) {
  return {
    requestSequence,
    socketReused: null,
    connectionPolicy: CONNECTION_POLICY,
    responseCompleted,
    resetBeforeHeaders: stage === "before_headers",
    resetDuringBody: stage === "during_body",
    resetAfterComplete: stage === "after_complete"
  };
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
  return actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index]);
}

function hasOnlyKeys(value, allowed, required) {
  return isPlainObject(value) &&
    Object.keys(value).every((key) => allowed.includes(key)) &&
    required.every((key) => Object.hasOwn(value, key));
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)]));
  }
  return value;
}

function deepFreeze(value) {
  Object.freeze(value);
  for (const child of Object.values(value)) {
    if (child && typeof child === "object" && !Object.isFrozen(child)) deepFreeze(child);
  }
  return value;
}

function assertJsonLike(value, ancestors = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (!Array.isArray(value) && !isPlainObject(value)) fail("INVALID_REQUEST", "request");
  if (ancestors.has(value)) fail("INVALID_REQUEST", "request");
  ancestors.add(value);
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    assertJsonLike(child, ancestors);
  }
  ancestors.delete(value);
}

function assertSignal(signal) {
  if (!signal || typeof signal.aborted !== "boolean" ||
      typeof signal.addEventListener !== "function") {
    fail("INVALID_REQUEST", "request");
  }
}

function validateCollection(collection) {
  if (typeof collection !== "string" || collection.length === 0 ||
      collection.trim() !== collection || collection.length > 255 ||
      collection === "." || collection === ".." ||
      /[\/\\?#\u0000-\u001f\u007f]/.test(collection)) {
    fail("INVALID_REQUEST", "request");
  }
  return encodeURIComponent(collection);
}

function validateOptions(options) {
  if (!hasOnlyKeys(options, OPTION_KEYS, [
    "endpoint", "timeoutMs", "maxResponseBytes", "providerId"
  ]) ||
      typeof options.endpoint !== "string" || options.endpoint.trim().length === 0 ||
      typeof options.providerId !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(options.providerId) ||
      !Number.isInteger(options.timeoutMs) || options.timeoutMs < MIN_TIMEOUT_MS ||
      options.timeoutMs > MAX_TIMEOUT_MS ||
      !Number.isInteger(options.maxResponseBytes) || options.maxResponseBytes < MIN_RESPONSE_BYTES ||
      options.maxResponseBytes > MAX_RESPONSE_BYTES ||
      options.apiKey !== undefined &&
        (typeof options.apiKey !== "string" || options.apiKey.length === 0 || /[\r\n]/.test(options.apiKey))) {
    fail("INVALID_CONFIGURATION", "configuration");
  }
  let endpoint;
  try {
    endpoint = new URL(options.endpoint);
  } catch {
    fail("INVALID_CONFIGURATION", "configuration");
  }
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password ||
      endpoint.search || endpoint.hash) {
    fail("INVALID_CONFIGURATION", "configuration");
  }
  const basePath = endpoint.pathname.replace(/\/+$/, "");
  endpoint.pathname = basePath || "/";
  return {
    endpoint,
    basePath,
    apiKey: options.apiKey,
    timeoutMs: options.timeoutMs,
    maxResponseBytes: options.maxResponseBytes,
    providerId: options.providerId.trim()
  };
}

function networkFailure(error) {
  const code = error?.cause?.code || error?.code;
  if (code === "ECONNREFUSED") return "CONNECTION_REFUSED";
  if (["ECONNRESET", "EPIPE", "UND_ERR_SOCKET", "UND_ERR_HEADERS_TIMEOUT"].includes(code)) {
    return "CONNECTION_RESET";
  }
  return "QDRANT_UNAVAILABLE";
}

async function readLimitedBody(response, maximum, stopAtDeclaredLength = false) {
  const transferEncoding = response.headers.get("transfer-encoding") || "";
  const chunked = transferEncoding.split(",").some((value) =>
    value.trim().toLowerCase() === "chunked");
  const declared = chunked ? null : response.headers.get("content-length");
  let declaredLength = null;
  if (declared !== null) {
    const parsed = Number(declared);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) {
      fail("RESPONSE_TOO_LARGE", "response");
    }
    declaredLength = parsed;
  }
  if (!response.body || typeof response.body.getReader !== "function") {
    fail("INVALID_HTTP_BODY", "response");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  if (stopAtDeclaredLength && declaredLength === 0) {
    await reader.cancel().catch(() => {});
    return "";
  }
  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      if (stopAtDeclaredLength && declaredLength !== null && total !== declaredLength) {
        fail("INVALID_HTTP_BODY", "response");
      }
      break;
    }
    total += value.byteLength;
    if (total > maximum) {
      await reader.cancel().catch(() => {});
      fail("RESPONSE_TOO_LARGE", "response");
    }
    chunks.push(value);
    if (stopAtDeclaredLength && declaredLength !== null) {
      if (total > declaredLength) {
        await reader.cancel().catch(() => {});
        fail("INVALID_HTTP_BODY", "response");
      }
      if (total === declaredLength) {
        await reader.cancel().catch(() => {});
        break;
      }
    }
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

function parseJson(body) {
  try {
    return JSON.parse(body);
  } catch {
    fail("INVALID_HTTP_JSON", "response");
  }
}

function validateSuccessEnvelope(envelope) {
  if (!isPlainObject(envelope) || envelope.status !== "ok" ||
      !Object.hasOwn(envelope, "result") || typeof envelope.time !== "number" ||
      !Number.isFinite(envelope.time) || envelope.time < 0) {
    fail("INVALID_QDRANT_ENVELOPE", "response");
  }
  return envelope.result;
}

function isExpectedMissingCollection(envelope) {
  if (!isPlainObject(envelope) || !isPlainObject(envelope.status) ||
      typeof envelope.status.error !== "string") return false;
  const message = envelope.status.error.toLowerCase();
  return message.includes("collection") &&
    (message.includes("doesn't exist") || message.includes("does not exist") ||
     message.includes("not found"));
}

function classifyHttp(status) {
  if (status === 503) fail("QDRANT_UNAVAILABLE", "response", true, { status });
  if (RETRYABLE_HTTP_STATUS.has(status)) {
    fail("HTTP_RETRYABLE", "response", true, { status });
  }
  fail("HTTP_ERROR", "response", false, { status });
}

function validatePointId(id) {
  return typeof id === "string" && id.length > 0 || Number.isSafeInteger(id) && id >= 0;
}

function normalizePoint(point, withScore = false) {
  if (!isPlainObject(point) || !validatePointId(point.id) ||
      withScore && (typeof point.score !== "number" || !Number.isFinite(point.score)) ||
      Object.hasOwn(point, "payload") && point.payload !== null && !isPlainObject(point.payload) ||
      Object.hasOwn(point, "vector") && point.vector !== null &&
        !Array.isArray(point.vector) && !isPlainObject(point.vector)) {
    fail("INVALID_QDRANT_RESULT", "response");
  }
  if (Object.hasOwn(point, "payload")) assertJsonLike(point.payload);
  if (Object.hasOwn(point, "vector")) assertJsonLike(point.vector);
  const normalized = {
    id: point.id,
    vector: Object.hasOwn(point, "vector") ? clone(point.vector) : null,
    payload: Object.hasOwn(point, "payload") ? clone(point.payload) : null
  };
  if (withScore) normalized.score = point.score;
  return normalized;
}

function normalizeOperation(result) {
  if (result === true) return deepFreeze({ acknowledged: true, operationId: null, status: null });
  if (!isPlainObject(result)) fail("INVALID_QDRANT_RESULT", "response");
  const operationId = result.operation_id ?? null;
  const status = result.status ?? null;
  if (operationId !== null && !Number.isSafeInteger(operationId) ||
      status !== null && typeof status !== "string") {
    fail("INVALID_QDRANT_RESULT", "response");
  }
  return deepFreeze({ acknowledged: true, operationId, status });
}

function createQdrantEmbeddingCacheProvider(options) {
  const config = validateOptions(options);

  function buildUrl(path, query) {
    const url = new URL(config.endpoint.toString());
    url.pathname = `${config.basePath}${path}` || "/";
    url.search = "";
    for (const [key, value] of Object.entries(query || {})) url.searchParams.set(key, String(value));
    return url.toString();
  }

  async function send({ method, path, query, body, signal, phase, health = false, missingCollection = false }) {
    const requestSequence = ++globalRequestSequence;
    assertSignal(signal);
    if (signal.aborted) fail("QDRANT_ABORTED", "transport", false);
    if (body !== undefined) assertJsonLike(body);
    const controller = new AbortController();
    let timedOut = false;
    let callerAborted = false;
    const abortFromCaller = () => {
      callerAborted = true;
      controller.abort();
    };
    signal.addEventListener("abort", abortFromCaller, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, config.timeoutMs);
    try {
      let response;
      try {
        const headers = {
          Accept: health ? "text/plain, application/json" : "application/json",
          Connection: "close"
        };
        if (body !== undefined) headers["Content-Type"] = "application/json";
        if (config.apiKey !== undefined) headers["api-key"] = config.apiKey;
        response = await fetch(buildUrl(path, query), {
          method,
          headers,
          redirect: "manual",
          signal: controller.signal,
          body: body === undefined ? undefined : JSON.stringify(body)
        });
      } catch (error) {
        if (controller.signal.aborted) {
          if (timedOut) fail("QDRANT_TIMEOUT", "transport", true);
          if (callerAborted) fail("QDRANT_ABORTED", "transport", false);
          fail("QDRANT_UNAVAILABLE", "transport", true);
        }
        fail(networkFailure(error), "transport", true, {
          transportDiagnostic: transportDiagnostic(
            requestSequence, "before_headers"
          )
        });
      }
      if (!response || typeof response.status !== "number" || !response.headers) {
        fail("INVALID_HTTP_RESPONSE", "response");
      }
      if (response.status >= 300 && response.status <= 399) {
        if (response.body) await response.body.cancel().catch(() => {});
        fail("REDIRECT_FORBIDDEN", "response", false, { status: response.status });
      }
      if (!response.ok && !(missingCollection && response.status === 404)) {
        if (response.body) await response.body.cancel().catch(() => {});
        classifyHttp(response.status);
      }
      if (health && response.ok) {
        try {
          await readLimitedBody(response, config.maxResponseBytes, true);
        } catch (error) {
          if (error instanceof QdrantEmbeddingCacheProviderError) throw error;
          if (controller.signal.aborted) {
            fail(timedOut ? "QDRANT_TIMEOUT" : "QDRANT_ABORTED", "transport", timedOut);
          }
          fail("CONNECTION_RESET", "response", true, {
            transportDiagnostic: transportDiagnostic(
              requestSequence, "during_body"
            )
          });
        }
        return null;
      }
      const contentType = response.headers.get("content-type") || "";
      if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
        if (response.body) await response.body.cancel().catch(() => {});
        fail("INVALID_CONTENT_TYPE", "response");
      }
      let text;
      try {
        text = await readLimitedBody(response, config.maxResponseBytes, true);
      } catch (error) {
        if (error instanceof QdrantEmbeddingCacheProviderError) throw error;
        if (controller.signal.aborted) {
          fail(timedOut ? "QDRANT_TIMEOUT" : "QDRANT_ABORTED", "transport", timedOut);
        }
        fail("CONNECTION_RESET", "response", true, {
          transportDiagnostic: transportDiagnostic(
            requestSequence, "during_body"
          )
        });
      }
      const envelope = parseJson(text);
      if (missingCollection && response.status === 404) {
        if (!isExpectedMissingCollection(envelope)) classifyHttp(response.status);
        return { missing: true };
      }
      return { result: validateSuccessEnvelope(envelope) };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener?.("abort", abortFromCaller);
    }
  }

  const provider = {
    schemaVersion: QDRANT_PROVIDER_SCHEMA_VERSION,
    providerId: config.providerId,
    timeoutMs: config.timeoutMs,
    maxResponseBytes: config.maxResponseBytes,

    async health(request) {
      if (!hasExactKeys(request, ["signal"])) fail("INVALID_REQUEST", "request");
      await send({ method: "GET", path: "/healthz", signal: request.signal, phase: "health", health: true });
      return deepFreeze({ ok: true, providerId: config.providerId });
    },

    async getCollectionInfo(request) {
      if (!hasExactKeys(request, ["collection", "signal"])) fail("INVALID_REQUEST", "request");
      const collection = validateCollection(request.collection);
      const response = await send({
        method: "GET", path: `/collections/${collection}`, signal: request.signal,
        phase: "collection", missingCollection: true
      });
      if (response.missing) return deepFreeze({ exists: false });
      const result = response.result;
      if (!isPlainObject(result) || !isPlainObject(result.config) ||
          !isPlainObject(result.payload_schema) || typeof result.status !== "string") {
        fail("INVALID_QDRANT_RESULT", "response");
      }
      return deepFreeze({
        exists: true,
        collectionStatus: result.status,
        config: clone(result.config),
        payloadSchema: clone(result.payload_schema)
      });
    },

    async createCollection(request) {
      if (!hasExactKeys(request, ["collection", "configuration", "signal"]) ||
          !isPlainObject(request.configuration)) fail("INVALID_REQUEST", "request");
      assertJsonLike(request.configuration);
      const collection = validateCollection(request.collection);
      const response = await send({
        method: "PUT", path: `/collections/${collection}`, body: request.configuration,
        signal: request.signal, phase: "collection"
      });
      return normalizeOperation(response.result);
    },

    async createPayloadIndex(request) {
      if (!hasExactKeys(request, ["collection", "fieldName", "fieldSchema", "signal"]) ||
          typeof request.fieldName !== "string" || request.fieldName.trim().length === 0) {
        fail("INVALID_REQUEST", "request");
      }
      assertJsonLike(request.fieldSchema);
      const collection = validateCollection(request.collection);
      const response = await send({
        method: "PUT", path: `/collections/${collection}/index`,
        body: { field_name: request.fieldName, field_schema: clone(request.fieldSchema) },
        signal: request.signal, phase: "index"
      });
      return normalizeOperation(response.result);
    },

    async retrievePoints(request) {
      if (!hasExactKeys(request, ["collection", "pointIds", "withPayload", "withVector", "signal"]) ||
          !Array.isArray(request.pointIds) || request.pointIds.length === 0 ||
          request.pointIds.some((id) => !validatePointId(id)) ||
          new Set(request.pointIds.map(String)).size !== request.pointIds.length ||
          typeof request.withPayload !== "boolean" || typeof request.withVector !== "boolean") {
        fail("INVALID_REQUEST", "request");
      }
      const collection = validateCollection(request.collection);
      const response = await send({
        method: "POST", path: `/collections/${collection}/points`,
        body: { ids: [...request.pointIds], with_payload: request.withPayload, with_vector: request.withVector },
        signal: request.signal, phase: "retrieve"
      });
      if (!Array.isArray(response.result)) fail("INVALID_QDRANT_RESULT", "response");
      return deepFreeze({ points: response.result.map((point) => normalizePoint(point)) });
    },

    async upsertPoints(request) {
      if (!hasExactKeys(request, ["collection", "points", "signal"]) ||
          !Array.isArray(request.points) || request.points.length === 0 ||
          request.points.some((point) => !isPlainObject(point))) {
        fail("INVALID_REQUEST", "request");
      }
      assertJsonLike(request.points);
      const collection = validateCollection(request.collection);
      const response = await send({
        method: "PUT", path: `/collections/${collection}/points`, query: { wait: true },
        body: { points: clone(request.points) }, signal: request.signal, phase: "upsert"
      });
      return normalizeOperation(response.result);
    },

    async searchPoints(request) {
      const allowed = [
        "collection", "vector", "filter", "limit", "withPayload", "withVector",
        "scoreThreshold", "signal"
      ];
      const required = ["collection", "vector", "filter", "limit", "withPayload", "withVector", "signal"];
      if (!hasOnlyKeys(request, allowed, required) || !Array.isArray(request.vector) ||
          request.vector.length === 0 || request.vector.some((value) =>
            typeof value !== "number" || !Number.isFinite(value)) ||
          request.filter !== null && !isPlainObject(request.filter) ||
          !Number.isInteger(request.limit) || request.limit <= 0 ||
          typeof request.withPayload !== "boolean" || typeof request.withVector !== "boolean" ||
          request.scoreThreshold !== undefined &&
            (typeof request.scoreThreshold !== "number" || !Number.isFinite(request.scoreThreshold))) {
        fail("INVALID_REQUEST", "request");
      }
      assertJsonLike(request.filter);
      const collection = validateCollection(request.collection);
      const body = {
        vector: [...request.vector], filter: clone(request.filter), limit: request.limit,
        with_payload: request.withPayload, with_vector: request.withVector
      };
      if (request.scoreThreshold !== undefined) body.score_threshold = request.scoreThreshold;
      const response = await send({
        method: "POST", path: `/collections/${collection}/points/search`, body,
        signal: request.signal, phase: "search"
      });
      if (!Array.isArray(response.result)) fail("INVALID_QDRANT_RESULT", "response");
      return deepFreeze({ points: response.result.map((point) => normalizePoint(point, true)) });
    },

    async queryPoints(request) {
      if (!hasExactKeys(request, [
        "collection", "queryPointId", "filter", "exact", "limit",
        "withPayload", "withVector", "scoreThreshold", "signal"
      ]) || !validatePointId(request.queryPointId) ||
          request.filter !== null && !isPlainObject(request.filter) ||
          request.exact !== true ||
          !Number.isInteger(request.limit) || request.limit <= 0 ||
          typeof request.withPayload !== "boolean" || typeof request.withVector !== "boolean" ||
          typeof request.scoreThreshold !== "number" ||
          !Number.isFinite(request.scoreThreshold)) {
        fail("INVALID_REQUEST", "request");
      }
      assertJsonLike(request.filter);
      const collection = validateCollection(request.collection);
      const response = await send({
        method: "POST", path: `/collections/${collection}/points/query`,
        body: {
          query: request.queryPointId,
          filter: clone(request.filter),
          params: { exact: true },
          score_threshold: request.scoreThreshold,
          limit: request.limit,
          with_payload: request.withPayload,
          with_vector: request.withVector
        },
        signal: request.signal,
        phase: "query"
      });
      if (!isPlainObject(response.result) || !hasExactKeys(response.result, ["points"]) ||
          !Array.isArray(response.result.points)) {
        fail("INVALID_QDRANT_RESULT", "response");
      }
      return deepFreeze({
        points: response.result.points.map((point) => normalizePoint(point, true)),
        exact: true
      });
    },

    async scrollPayload(request) {
      if (!hasExactKeys(request, [
        "collection", "filter", "limit", "offset", "withPayload", "withVector", "signal"
      ]) || request.filter !== null && !isPlainObject(request.filter) ||
          !Number.isInteger(request.limit) || request.limit <= 0 ||
          typeof request.withPayload !== "boolean" || typeof request.withVector !== "boolean") {
        fail("INVALID_REQUEST", "request");
      }
      assertJsonLike(request.filter);
      assertJsonLike(request.offset);
      const collection = validateCollection(request.collection);
      const response = await send({
        method: "POST", path: `/collections/${collection}/points/scroll`,
        body: {
          filter: clone(request.filter), limit: request.limit, offset: clone(request.offset),
          with_payload: request.withPayload, with_vector: request.withVector
        },
        signal: request.signal, phase: "scroll"
      });
      const result = response.result;
      if (!isPlainObject(result) || !Array.isArray(result.points) ||
          !Object.hasOwn(result, "next_page_offset")) {
        fail("INVALID_QDRANT_RESULT", "response");
      }
      assertJsonLike(result.next_page_offset);
      return deepFreeze({
        points: result.points.map((point) => normalizePoint(point)),
        nextPageOffset: clone(result.next_page_offset)
      });
    }
  };

  return Object.freeze(provider);
}

module.exports = {
  QDRANT_PROVIDER_SCHEMA_VERSION,
  MIN_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  MIN_RESPONSE_BYTES,
  MAX_RESPONSE_BYTES,
  QdrantEmbeddingCacheProviderError,
  createQdrantEmbeddingCacheProvider
};
