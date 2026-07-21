"use strict";

const DEFAULT_MODEL = process.env.PRIMARY_MODEL || "qwen3.5:27b";
const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_KEEP_ALIVE = "5m";
const PROVIDER_ID = "ollama-qwen-synthesis";
const TRANSPORT_VERSION = "ollama-http-chat-v1";
const OPTION_KEYS = new Set([
  "baseUrl", "model", "timeoutMs", "maxResponseBytes", "keepAlive", "fetchImpl"
]);
const GENERATE_KEYS = [
  "requestId", "messages", "signal", "responseFormat", "maxOutputChars"
];
const RETRYABLE_HTTP_STATUS = new Set([429, 502, 503, 504]);

class OllamaSynthesisProviderError extends Error {
  constructor(code, phase, retryable, details = {}) {
    super("Ollama synthesis provider request failed");
    this.name = "OllamaSynthesisProviderError";
    this.code = code;
    this.phase = phase;
    this.retryable = retryable;
    if (Number.isInteger(details.status)) this.status = details.status;
  }
}

function fail(code, phase, retryable = false, details) {
  throw new OllamaSynthesisProviderError(code, phase, retryable, details);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateOptions(options) {
  if (!isPlainObject(options)) fail("INVALID_CONFIGURATION", "configuration");
  for (const key of Object.keys(options)) {
    if (!OPTION_KEYS.has(key)) fail("INVALID_CONFIGURATION", "configuration");
  }
  if (typeof options.baseUrl !== "string" || options.baseUrl.trim().length === 0) {
    fail("INVALID_CONFIGURATION", "configuration");
  }
  let endpoint;
  try {
    endpoint = new URL(options.baseUrl);
  } catch {
    fail("INVALID_CONFIGURATION", "configuration");
  }
  if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password ||
      endpoint.hash || endpoint.search || endpoint.pathname !== "/api/chat") {
    fail("INVALID_CONFIGURATION", "configuration");
  }
  const model = options.model === undefined ? DEFAULT_MODEL : options.model;
  const timeoutMs = options.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : options.timeoutMs;
  const maxResponseBytes = options.maxResponseBytes === undefined
    ? DEFAULT_MAX_RESPONSE_BYTES
    : options.maxResponseBytes;
  const keepAlive = options.keepAlive === undefined ? DEFAULT_KEEP_ALIVE : options.keepAlive;
  const fetchImpl = options.fetchImpl === undefined ? globalThis.fetch : options.fetchImpl;
  if (typeof model !== "string" || model.trim().length === 0 ||
      !Number.isInteger(timeoutMs) || timeoutMs <= 0 ||
      !Number.isInteger(maxResponseBytes) || maxResponseBytes <= 0 ||
      !(typeof keepAlive === "string" && keepAlive.trim().length > 0 || Number.isFinite(keepAlive)) ||
      typeof fetchImpl !== "function") {
    fail("INVALID_CONFIGURATION", "configuration");
  }
  return { endpoint: endpoint.toString(), model, timeoutMs, maxResponseBytes, keepAlive, fetchImpl };
}

function validateGenerateInput(input) {
  if (!isPlainObject(input) || Object.keys(input).sort().join(",") !== [...GENERATE_KEYS].sort().join(",")) {
    fail("INVALID_REQUEST", "request");
  }
  if (typeof input.requestId !== "string" || !/^[a-f0-9]{64}$/.test(input.requestId) ||
      !Array.isArray(input.messages) || input.messages.length === 0 ||
      input.messages.some((message) => !isPlainObject(message) ||
        !["system", "user", "assistant"].includes(message.role) || typeof message.content !== "string") ||
      !isPlainObject(input.responseFormat) || input.responseFormat.type !== "json_object" ||
      input.responseFormat.schemaVersion !== 1 || Object.keys(input.responseFormat).length !== 2 ||
      !Number.isInteger(input.maxOutputChars) || input.maxOutputChars <= 0 ||
      !input.signal || typeof input.signal.addEventListener !== "function" ||
      typeof input.signal.aborted !== "boolean") {
    fail("INVALID_REQUEST", "request");
  }
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

function createOllamaSynthesisProvider(options) {
  const config = validateOptions(options);

  const provider = {
    schemaVersion: 1,
    providerId: PROVIDER_ID,
    model: config.model,
    version: `${TRANSPORT_VERSION}+${config.model}`,
    async generate(input) {
      validateGenerateInput(input);
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
            headers: { "Content-Type": "application/json", "Accept": "application/json" },
            redirect: "manual",
            signal: controller.signal,
            body: JSON.stringify({
              model: config.model,
              messages: input.messages,
              stream: false,
              format: "json",
              think: false,
              keep_alive: config.keepAlive
            })
          });
        } catch (error) {
          if (controller.signal.aborted) {
            fail(timedOut ? "SYNTHESIS_TIMEOUT" : "SYNTHESIS_ABORTED", "transport", true);
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
          if (error instanceof OllamaSynthesisProviderError) throw error;
          if (controller.signal.aborted) {
            fail(timedOut ? "SYNTHESIS_TIMEOUT" : "SYNTHESIS_ABORTED", "transport", true);
          }
          fail("CONNECTION_RESET", "response", true);
        }
        let envelope;
        try {
          envelope = JSON.parse(body);
        } catch {
          fail("INVALID_HTTP_JSON", "response");
        }
        if (!isPlainObject(envelope) || envelope.done !== true || !isPlainObject(envelope.message) ||
            typeof envelope.message.content !== "string") {
          fail("INVALID_OLLAMA_RESPONSE", "response");
        }
        if (envelope.model !== config.model) fail("MODEL_MISMATCH", "provenance");
        if (envelope.message.content.trim().length === 0) fail("EMPTY_RESPONSE", "response");
        return { ok: true, status: response.status, text: envelope.message.content };
      } finally {
        clearTimeout(timer);
        input.signal.removeEventListener?.("abort", abortFromCaller);
      }
    }
  };
  return Object.freeze(provider);
}

module.exports = {
  DEFAULT_MODEL,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_KEEP_ALIVE,
  OllamaSynthesisProviderError,
  createOllamaSynthesisProvider
};
