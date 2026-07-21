#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { cosineSimilarity } = require("../core/clustering/ClusterMath");
const {
  EXPECTED_MODEL,
  EXPECTED_REVISION,
  EXPECTED_DIMENSION,
  EXPECTED_NORMALIZED,
  createBgeM3EmbeddingProvider
} = require("../core/providers/embedding/BgeM3EmbeddingProvider");

const TIMEOUT_MS = 120000;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const SYNTHETIC_ITEMS = Object.freeze([
  Object.freeze({ id: "bge_live_synthetic_affine_a", text: "Un satellite sintetico percorre un'orbita ellittica controllata." }),
  Object.freeze({ id: "bge_live_synthetic_affine_b", text: "Il satellite artificiale segue una traiettoria orbitale ellittica." }),
  Object.freeze({ id: "bge_live_synthetic_unrelated", text: "Una ricetta sintetica descrive la cottura del pane in forno." })
]);

function report(status, details = {}) {
  process.stdout.write(`${JSON.stringify({
    status,
    endpoint: "http://<LAN_HOST>:8001/api/v1/embed",
    model: EXPECTED_MODEL,
    revision: EXPECTED_REVISION,
    dimension: EXPECTED_DIMENSION,
    normalized: EXPECTED_NORMALIZED,
    health: details.health || "NOT_RUN",
    batchSize: details.batchSize || 0,
    affineSimilarity: details.affineSimilarity ?? null,
    unrelatedSimilarity: details.unrelatedSimilarity ?? null,
    fallbackCalls: 0,
    daemonStarted: false,
    commitCalls: 0,
    realDataModified: false
  })}\n`);
}

function chatLanHost() {
  const source = fs.readFileSync(path.join(__dirname, "..", "chat_orbitale_ollama.js"), "utf8");
  const match = source.match(/https?:\/\/[^\s'"`]+/);
  if (!match) return null;
  try {
    return new URL(match[0]).hostname;
  } catch {
    return null;
  }
}

function configuration() {
  const rawUrl = process.env.HIPPOCAMPUS_EMBEDDING_URL;
  const apiKey = process.env.HIPPOCAMPUS_EMBEDDING_API_KEY;
  if (typeof rawUrl !== "string" || rawUrl.trim().length === 0 ||
      typeof apiKey !== "string" || apiKey.trim().length === 0 || /[\r\n]/.test(apiKey)) return null;
  let endpoint;
  try {
    endpoint = new URL(rawUrl);
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password ||
      endpoint.search || endpoint.hash || endpoint.pathname !== "/api/v1/embed" ||
      endpoint.port !== "8001" || endpoint.hostname !== chatLanHost()) return null;
  const health = new URL(endpoint);
  health.pathname = "/health";
  return { endpoint: endpoint.toString(), health: health.toString(), apiKey };
}

async function readLimitedJson(response) {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!Number.isSafeInteger(Number(declared)) || Number(declared) < 0 ||
      Number(declared) > MAX_RESPONSE_BYTES)) throw new Error("invalid health response");
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") || "") ||
      !response.body || typeof response.body.getReader !== "function") throw new Error("invalid health response");
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error("invalid health response");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

async function qualifiedHealth(config) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(config.health, {
      method: "GET",
      headers: { "Accept": "application/json", "X-API-Key": config.apiKey },
      redirect: "manual",
      signal: controller.signal
    });
    if (!response.ok || response.status >= 300 && response.status <= 399) return false;
    const body = await readLimitedJson(response);
    const cuda = body?.cuda === true || body?.cuda_available === true ||
      typeof body?.device === "string" && /^cuda(?::\d+)?$/i.test(body.device);
    return body && typeof body === "object" && !Array.isArray(body) &&
      body.model === EXPECTED_MODEL && body.revision === EXPECTED_REVISION &&
      body.dimension === EXPECTED_DIMENSION && body.model_loaded === true && cuda;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const config = configuration();
  if (!config) {
    report("DEFERRED_INVALID_CONFIGURATION");
    return;
  }
  if (!await qualifiedHealth(config)) {
    report("DEFERRED_HEALTH_UNQUALIFIED", { health: "FAIL" });
    return;
  }
  const provider = createBgeM3EmbeddingProvider({
    baseUrl: config.endpoint,
    apiKey: config.apiKey,
    timeoutMs: TIMEOUT_MS,
    maxResponseBytes: MAX_RESPONSE_BYTES,
    fetchImpl: fetch
  });
  const result = await provider.embedBatch({
    items: SYNTHETIC_ITEMS,
    signal: new AbortController().signal
  });
  const affineSimilarity = cosineSimilarity(result[0].embedding, result[1].embedding);
  const unrelatedSimilarity = cosineSimilarity(result[0].embedding, result[2].embedding);
  if (!(affineSimilarity > unrelatedSimilarity)) throw new Error("synthetic similarity ordering failed");
  report("PASS", {
    health: "PASS",
    batchSize: result.length,
    affineSimilarity,
    unrelatedSimilarity
  });
}

main().catch(() => {
  report("FAIL");
  process.exitCode = 1;
});
