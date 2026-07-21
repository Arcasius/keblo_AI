#!/usr/bin/env node
"use strict";

const {
  createQdrantEmbeddingCacheProvider
} = require("../core/providers/vector/QdrantEmbeddingCacheProvider");
const {
  createHippocampusEmbeddingCacheAdapter
} = require("../core/hippocampus/embedding-cache/HippocampusEmbeddingCacheAdapter");
const {
  EMBEDDING_CACHE_COLLECTION,
  EMBEDDING_CACHE_DIMENSION
} = require("../core/hippocampus/embedding-cache/EmbeddingCacheRecord");

const CREATE_CONFIRMATION = "CREATE_HIPPOCAMPUS_EMBEDDING_CACHE_V1";
const QDRANT_TIMEOUT_MS = 30000;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

function parseArguments(args) {
  if (!Array.isArray(args)) return { authorized: false, valid: false };
  let allowCreate = false;
  let confirmation = null;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--allow-create" && !allowCreate) {
      allowCreate = true;
      continue;
    }
    if (args[index] === "--confirm" && confirmation === null && index + 1 < args.length) {
      confirmation = args[index + 1];
      index += 1;
      continue;
    }
    return { authorized: false, valid: false };
  }
  return {
    authorized: allowCreate && confirmation === CREATE_CONFIRMATION,
    valid: args.length === 0 || allowCreate || confirmation !== null
  };
}

function qdrantConfiguration(env) {
  const rawUrl = env?.HIPPOCAMPUS_QDRANT_URL;
  const apiKey = env?.HIPPOCAMPUS_QDRANT_API_KEY;
  if (typeof rawUrl !== "string" || rawUrl.trim().length === 0 ||
      apiKey !== undefined && (typeof apiKey !== "string" || apiKey.length === 0 || /[\r\n]/.test(apiKey))) {
    return null;
  }
  let endpoint;
  try {
    endpoint = new URL(rawUrl);
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password ||
      endpoint.search || endpoint.hash) return null;
  return { endpoint: endpoint.toString(), apiKey };
}

function isPrivateQdrantEndpoint(rawUrl) {
  let hostname;
  try {
    hostname = new URL(rawUrl).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return false;
  }
  if (hostname === "localhost" || hostname.endsWith(".localhost") ||
      hostname.endsWith(".local") || hostname.endsWith(".lan") ||
      hostname.endsWith(".ts.net") || !hostname.includes(".")) return true;
  if (hostname === "::1" || /^f[cd][0-9a-f]:/i.test(hostname) || /^fe[89ab][0-9a-f]:/i.test(hostname)) {
    return true;
  }
  const octets = hostname.split(".").map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    return false;
  }
  return octets[0] === 10 || octets[0] === 127 ||
    octets[0] === 192 && octets[1] === 168 ||
    octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31 ||
    octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127 ||
    octets[0] === 169 && octets[1] === 254;
}

function sanitizedBase(apiKey) {
  return {
    collection: EMBEDDING_CACHE_COLLECTION,
    dimension: EMBEDDING_CACHE_DIMENSION,
    distance: "Cosine",
    qdrantAuth: apiKey === undefined ? "absent-private-network" : "present",
    existingCollectionsModified: false,
    deleteCleanup: "none"
  };
}

function sanitizedErrorCode(error, fallback) {
  return typeof error?.code === "string" && /^[A-Z][A-Z0-9_]*$/.test(error.code)
    ? error.code
    : fallback;
}

function controlledProvider(provider, counters) {
  const wrapped = {};
  for (const [name, value] of Object.entries(provider)) {
    if (typeof value !== "function") {
      wrapped[name] = value;
      continue;
    }
    wrapped[name] = async (request) => {
      if (["createCollection", "createPayloadIndex", "upsertPoints"].includes(name)) {
        if (request?.collection !== EMBEDDING_CACHE_COLLECTION) {
          const error = new Error("controlled Qdrant scope violation");
          error.code = "QDRANT_SCOPE_VIOLATION";
          error.retryable = false;
          throw error;
        }
        counters.writes += 1;
      }
      return value(request);
    };
  }
  return Object.freeze(wrapped);
}

async function listQdrantCollections(config, fetchImpl = globalThis.fetch) {
  const endpoint = new URL(config.endpoint);
  endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, "")}/collections`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), QDRANT_TIMEOUT_MS);
  try {
    const headers = { Accept: "application/json" };
    if (config.apiKey !== undefined) headers["api-key"] = config.apiKey;
    const response = await fetchImpl(endpoint.toString(), {
      method: "GET", headers, redirect: "manual", signal: controller.signal
    });
    if (!response.ok || response.status >= 300 && response.status <= 399 ||
        !/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") || "")) {
      throw Object.assign(new Error("invalid Qdrant collection response"), {
        code: "INVALID_QDRANT_COLLECTIONS", retryable: false
      });
    }
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
      throw Object.assign(new Error("Qdrant collection response too large"), {
        code: "RESPONSE_TOO_LARGE", retryable: false
      });
    }
    let envelope;
    try {
      envelope = JSON.parse(text);
    } catch {
      throw Object.assign(new Error("invalid Qdrant collection JSON"), {
        code: "INVALID_HTTP_JSON", retryable: false
      });
    }
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope) ||
        envelope.status !== "ok" || typeof envelope.time !== "number" ||
        !Number.isFinite(envelope.time) || !envelope.result ||
        !Array.isArray(envelope.result.collections)) {
      throw Object.assign(new Error("invalid Qdrant collection envelope"), {
        code: "INVALID_QDRANT_ENVELOPE", retryable: false
      });
    }
    const names = envelope.result.collections.map((entry) => entry?.name);
    if (names.some((name) => typeof name !== "string" || name.length === 0) ||
        new Set(names).size !== names.length) {
      throw Object.assign(new Error("invalid Qdrant collection result"), {
        code: "INVALID_QDRANT_RESULT", retryable: false
      });
    }
    return Object.freeze([...names].sort());
  } finally {
    clearTimeout(timer);
  }
}

function collectionsPreserved(before, after) {
  const afterSet = new Set(after);
  return before.every((name) => afterSet.has(name)) &&
    after.every((name) => before.includes(name) || name === EMBEDDING_CACHE_COLLECTION);
}

async function runProvisioning(options) {
  const parsed = parseArguments(options?.args || []);
  const config = qdrantConfiguration(options?.env || {});
  if (!config) return { status: "DEFERRED_INVALID_CONFIGURATION", ...sanitizedBase(undefined) };
  const base = sanitizedBase(config.apiKey);
  if (config.apiKey === undefined && !isPrivateQdrantEndpoint(config.endpoint)) {
    return { status: "DEFERRED_PUBLIC_ENDPOINT_WITHOUT_AUTH", ...base };
  }
  if (!parsed.valid) return { status: "DEFERRED_CREATE_NOT_AUTHORIZED", ...base };

  const providerFactory = options?.providerFactory || createQdrantEmbeddingCacheProvider;
  const provider = providerFactory({
    endpoint: config.endpoint,
    apiKey: config.apiKey,
    timeoutMs: QDRANT_TIMEOUT_MS,
    maxResponseBytes: MAX_RESPONSE_BYTES,
    providerId: "hippocampus-embedding-cache-ec7"
  });
  const counters = { writes: 0 };
  const guardedProvider = controlledProvider(provider, counters);
  const adapter = (options?.adapterFactory || createHippocampusEmbeddingCacheAdapter)({
    provider: guardedProvider
  });
  let phase = "health";
  try {
    await guardedProvider.health({ signal: new AbortController().signal });
    const listCollections = options?.listCollections ||
      (() => listQdrantCollections(config, options?.fetchImpl || globalThis.fetch));
    phase = "snapshot-before";
    const collectionsBefore = await listCollections();
    phase = parsed.authorized ? "provision" : "inspect";
    const lifecycle = await adapter.ensureCollection(parsed.authorized ? {
      allowCreate: true,
      confirmCreate: CREATE_CONFIRMATION,
      signal: new AbortController().signal
    } : {
      allowCreate: false,
      signal: new AbortController().signal
    });
    phase = "verify";
    const verified = await adapter.ensureCollection({
      allowCreate: false,
      signal: new AbortController().signal
    });
    if (parsed.authorized && !verified.ready) {
      const error = new Error("collection postcondition failed");
      error.code = "COLLECTION_POSTCONDITION_FAILED";
      throw error;
    }
    phase = "snapshot-after";
    const collectionsAfter = await listCollections();
    if (!collectionsPreserved(collectionsBefore, collectionsAfter)) {
      const error = new Error("collection set changed outside controlled scope");
      error.code = "EXISTING_COLLECTIONS_NOT_PRESERVED";
      throw error;
    }
    return {
      status: parsed.authorized
        ? "PROVISIONED_AND_VERIFIED"
        : "DEFERRED_CREATE_NOT_AUTHORIZED",
      ...base,
      ready: verified.ready,
      created: lifecycle.created,
      payloadIndexesReady: verified.payloadIndexesReady,
      missingPayloadIndexes: [...verified.missingPayloadIndexes],
      writes: counters.writes,
      verifiedPhase: "complete"
    };
  } catch (error) {
    return {
      status: "FAILED",
      ...base,
      ready: false,
      writes: counters.writes,
      verifiedPhase: phase,
      errorCode: sanitizedErrorCode(error, "EC7_PROVISIONING_FAILURE"),
      retryable: error?.retryable === true
    };
  }
}

function writeReport(result) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (require.main === module) {
  runProvisioning({ env: process.env, args: process.argv.slice(2) })
    .then((result) => {
      writeReport(result);
      if (result.status === "FAILED") process.exitCode = 1;
    })
    .catch(() => {
      writeReport({ status: "FAILED", errorCode: "EC7_PROVISIONING_FAILURE" });
      process.exitCode = 1;
    });
}

module.exports = {
  CREATE_CONFIRMATION,
  QDRANT_TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
  parseArguments,
  qdrantConfiguration,
  isPrivateQdrantEndpoint,
  controlledProvider,
  listQdrantCollections,
  collectionsPreserved,
  runProvisioning
};
