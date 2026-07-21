"use strict";

const { createHash } = require("node:crypto");
const { normalizeMemory } = require("../MemoryContractNormalizer");
const { validateClusterRecord } = require("../clustering/ClusterRecord");
const {
  buildSynthesisRequest,
  validateSynthesisOutput,
  buildSynthesisResult
} = require("./SynthesisContract");

const DEFAULT_SYNTHESIS_LIMITS = Object.freeze({
  timeoutMs: 120000,
  maxInputChars: 120000,
  maxOutputChars: 30000,
  maxTitleChars: 300,
  maxSynthesisChars: 12000,
  maxFactItems: 200,
  maxUncertaintyItems: 100,
  maxContradictionItems: 100
});
const DEFAULT_CONSTRAINTS = Object.freeze({
  language: "it",
  preserveUncertainty: true,
  preserveContradictions: true
});
const LIMIT_KEYS = Object.keys(DEFAULT_SYNTHESIS_LIMITS);

class SynthesisEngineError extends Error {
  constructor(code, phase, message, details = {}) {
    super(message);
    this.name = "SynthesisEngineError";
    this.code = code;
    this.phase = phase;
    Object.assign(this, details);
  }
}

function fail(code, phase, message, details) {
  throw new SynthesisEngineError(code, phase, message, details);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value, expected, label, code = "INVALID_INPUT") {
  if (!isPlainObject(value)) fail(code, "input", `${label} must be a plain object`);
  const allowed = new Set(expected);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(code, "input", `${label} contains an unsupported property`);
  }
}

function validateProvider(provider) {
  if (!isPlainObject(provider)) fail("INVALID_PROVIDER", "provider", "modelProvider is required");
  const expected = ["schemaVersion", "providerId", "model", "version", "generate"];
  if (Object.keys(provider).sort().join(",") !== expected.sort().join(",")) {
    fail("INVALID_PROVIDER", "provider", "modelProvider must contain exactly the V1 fields");
  }
  if (provider.schemaVersion !== 1) fail("INVALID_PROVIDER", "provider", "modelProvider schemaVersion must be 1");
  for (const key of ["providerId", "model", "version"]) {
    if (typeof provider[key] !== "string" || provider[key].trim().length === 0) {
      fail("INVALID_PROVIDER", "provider", `modelProvider.${key} must be non-empty`);
    }
  }
  if (typeof provider.generate !== "function") fail("INVALID_PROVIDER", "provider", "modelProvider.generate must be callable");
}

function mergeLimits(limits) {
  if (limits === undefined) return { ...DEFAULT_SYNTHESIS_LIMITS };
  assertExactKeys(limits, LIMIT_KEYS, "limits", "INVALID_LIMITS");
  const merged = { ...DEFAULT_SYNTHESIS_LIMITS, ...limits };
  for (const key of LIMIT_KEYS) {
    if (!Number.isInteger(merged[key]) || merged[key] <= 0) {
      fail("INVALID_LIMITS", "input", `limits.${key} must be a positive integer`);
    }
  }
  return merged;
}

function normalizeConstraints(constraints) {
  if (constraints === undefined) return { ...DEFAULT_CONSTRAINTS };
  assertExactKeys(constraints, Object.keys(DEFAULT_CONSTRAINTS), "constraints", "INVALID_CONSTRAINTS");
  const merged = { ...DEFAULT_CONSTRAINTS, ...constraints };
  if (typeof merged.language !== "string" || !/^[a-z]{2}(?:-[A-Z]{2})?$/.test(merged.language) ||
      merged.preserveUncertainty !== true || merged.preserveContradictions !== true) {
    fail("INVALID_CONSTRAINTS", "input", "constraints cannot disable required synthesis safeguards");
  }
  return merged;
}

function collectionValues(memories) {
  if (Array.isArray(memories)) return memories;
  if (isPlainObject(memories)) return Object.keys(memories).sort().map((key) => memories[key]);
  fail("INVALID_MEMORIES", "source-resolution", "memories must be an array or plain object map");
}

function sourceDescriptor(memory) {
  let normalized;
  try {
    normalized = normalizeMemory(memory);
  } catch {
    fail("INVALID_SOURCE_MEMORY", "normalization", "a source memory is invalid");
  }
  if (typeof normalized.id !== "string" || normalized.id.trim().length === 0) {
    fail("INVALID_SOURCE_MEMORY", "normalization", "a source memory has an invalid ID");
  }
  if (typeof normalized.content.text !== "string") {
    fail("INVALID_SOURCE_MEMORY", "normalization", "a source memory has no string text", { invalidIds: [normalized.id] });
  }
  return {
    id: normalized.id,
    text: normalized.content.text,
    timestamp: normalized.timestamps.createdAt,
    type: typeof normalized.type === "string" ? normalized.type : null,
    content_hash: createHash("sha256").update(normalized.content.text, "utf8").digest("hex")
  };
}

function resolveSources(memories, requiredIds) {
  const byId = new Map();
  const required = new Set(requiredIds);
  for (const memory of collectionValues(memories)) {
    if (!isPlainObject(memory)) continue;
    if (typeof memory.id !== "string" || !required.has(memory.id)) continue;
    const normalized = sourceDescriptor(memory);
    if (byId.has(normalized.id)) fail("DUPLICATE_SOURCE_MEMORY", "source-resolution", "source memory IDs must be unique", { invalidIds: [normalized.id] });
    byId.set(normalized.id, normalized);
  }
  const missingIds = requiredIds.filter((id) => !byId.has(id));
  if (missingIds.length > 0) {
    fail("SOURCE_MEMORY_MISSING", "source-resolution", "required source memories are missing", { missingIds });
  }
  return requiredIds.map((id) => byId.get(id)).sort((left, right) => left.id.localeCompare(right.id));
}

async function invokeWithTimeout(provider, payload, timeoutMs, context) {
  const controller = new AbortController();
  let timer;
  const providerPromise = Promise.resolve().then(() => provider.generate({
    ...payload,
    signal: controller.signal
  }));
  providerPromise.catch(() => {});
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new SynthesisEngineError(
        "SYNTHESIS_TIMEOUT", "provider", "synthesis provider timed out", context
      ));
    }, timeoutMs);
  });
  try {
    return await Promise.race([providerPromise, timeoutPromise]);
  } catch (error) {
    if (error instanceof SynthesisEngineError) throw error;
    fail("PROVIDER_FAILED", "provider", "synthesis provider failed", context);
  } finally {
    clearTimeout(timer);
  }
}

function validateResponse(response, limits, context) {
  if (!isPlainObject(response)) fail("INVALID_PROVIDER_RESPONSE", "response", "provider response must be a plain object", context);
  if (response.ok !== true) {
    fail("PROVIDER_NOT_OK", "response", "provider returned a non-success response", { ...context, providerStatus: response.status });
  }
  if (!Number.isInteger(response.status) || response.status < 200 || response.status > 299) {
    fail("INVALID_PROVIDER_STATUS", "response", "provider status must be successful", { ...context, providerStatus: response.status });
  }
  if (typeof response.text !== "string") fail("INVALID_PROVIDER_TEXT", "response", "provider text must be a string", context);
  if (response.text.length > limits.maxOutputChars) fail("OUTPUT_LIMIT_EXCEEDED", "response", "provider output exceeds maxOutputChars", context);
  return response.text;
}

function createSynthesisEngine(options) {
  assertExactKeys(options, ["modelProvider", "limits"], "engine options", "INVALID_OPTIONS");
  validateProvider(options.modelProvider);
  const limits = mergeLimits(options.limits);
  const provider = options.modelProvider;
  const providerMetadata = {
    providerId: provider.providerId,
    model: provider.model,
    version: provider.version
  };

  return Object.freeze({
    async synthesize(input) {
      assertExactKeys(input, ["clusterRecord", "memories", "constraints"], "synthesis input");
      let clusterRecord;
      try {
        clusterRecord = validateClusterRecord(input.clusterRecord);
      } catch {
        fail("INVALID_CLUSTER_RECORD", "input", "a valid cluster record V1 is required");
      }
      const constraints = normalizeConstraints(input.constraints);
      const sources = resolveSources(input.memories, clusterRecord.source_memory_ids);
      const request = buildSynthesisRequest({
        clusterRecord,
        sources,
        provider: providerMetadata,
        constraints,
        limits
      });
      const context = { requestId: request.requestId, clusterId: request.clusterId };
      const serializedMessages = JSON.stringify(request.messages);
      if (serializedMessages.length > limits.maxInputChars) {
        fail("INPUT_LIMIT_EXCEEDED", "request", "serialized messages exceed maxInputChars", context);
      }
      const response = await invokeWithTimeout(provider, {
        requestId: request.requestId,
        messages: request.messages,
        responseFormat: Object.freeze({ type: "json_object", schemaVersion: 1 }),
        maxOutputChars: limits.maxOutputChars
      }, limits.timeoutMs, context);
      const text = validateResponse(response, limits, context);
      let output;
      try {
        output = JSON.parse(text);
      } catch {
        fail("INVALID_JSON_OUTPUT", "parse", "provider output is not strict JSON", context);
      }
      try {
        const validated = validateSynthesisOutput(output, request);
        return buildSynthesisResult(request, validated, providerMetadata);
      } catch (error) {
        if (error instanceof SynthesisEngineError) throw error;
        fail("INVALID_SYNTHESIS_OUTPUT", "validation", "provider output violates the synthesis contract", context);
      }
    }
  });
}

module.exports = {
  DEFAULT_SYNTHESIS_LIMITS,
  SynthesisEngineError,
  createSynthesisEngine
};
