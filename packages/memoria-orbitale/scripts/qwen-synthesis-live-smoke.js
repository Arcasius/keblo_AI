#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { fingerprintEmbedding } = require("../core/clustering/ClusterMath");
const { createClusterRecord } = require("../core/clustering/ClusterRecord");
const { createSuperMemoryRecord, validateSuperMemoryRecord } = require("../core/consolidation/SuperMemoryRecord");
const { createSynthesisEngine } = require("../core/synthesis/SynthesisEngine");
const { validateSynthesisResult } = require("../core/synthesis/SynthesisContract");
const { createOllamaSynthesisProvider } = require("../core/providers/ollama/OllamaSynthesisProvider");

const EXPECTED_MODEL = "qwen3.5:27b";
const PRIMARY_MODEL = process.env.PRIMARY_MODEL || EXPECTED_MODEL;
const PRIMARY_OLLAMA_URL = process.env.PRIMARY_OLLAMA_URL || "http://100.127.150.67:11434/api/chat";
const PRESERVE_TEMP = process.argv.includes("--preserve-temp");
const IDS = ["live_synthetic_a", "live_synthetic_b", "live_synthetic_c"];

function report(status, details = {}) {
  process.stdout.write(`${JSON.stringify({
    status,
    model: PRIMARY_MODEL,
    requestId: details.requestId || null,
    sourceCount: details.sourceCount || 0,
    confidence: details.confidence ?? null,
    schemaValidation: details.schemaValidation || "NOT_RUN",
    superMemoryId: details.superMemoryId || null,
    temporaryDirectory: details.temporaryDirectory || "NOT_CREATED"
  })}\n`);
}

async function modelAvailable() {
  if (PRIMARY_MODEL !== EXPECTED_MODEL) return false;
  let endpoint;
  try {
    endpoint = new URL(PRIMARY_OLLAMA_URL);
  } catch {
    return false;
  }
  if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password ||
      endpoint.pathname !== "/api/chat" || endpoint.search || endpoint.hash) return false;
  endpoint.pathname = "/api/tags";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(endpoint, { method: "GET", redirect: "manual", signal: controller.signal });
    if (!response.ok || response.status >= 300 && response.status <= 399 ||
        !/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") || "")) return false;
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > 1024 * 1024) return false;
    const body = JSON.parse(text);
    return Array.isArray(body.models) && body.models.some((entry) =>
      entry && typeof entry === "object" && (entry.name === EXPECTED_MODEL || entry.model === EXPECTED_MODEL));
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function syntheticMemories() {
  return IDS.map((id, index) => ({
    id,
    type: "synthetic",
    content: {
      text: [
        "Nel laboratorio sintetico viene osservata una luce blu controllata.",
        "La seconda osservazione sintetica registra la stessa luce blu nel laboratorio.",
        "La terza nota sintetica conferma la luce blu, senza dati sul fenomeno esterno."
      ][index]
    },
    timestamp: 1780000000000 + index,
    preserved: { marker: "live-smoke-raw", index }
  }));
}

function syntheticCluster() {
  const centroid = [1, 0.5];
  return createClusterRecord({
    userId: "qwen_live_synthetic_user",
    planId: "a".repeat(64),
    createdAt: 1780000000000,
    embedding: { providerId: "synthetic-only", model: "not-invoked", version: "smoke-v1" },
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

async function main() {
  if (!await modelAvailable()) {
    report("DEFERRED_QWEN_UNAVAILABLE");
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-synthesis-live-"));
  fs.chmodSync(root, 0o700);
  let details = { sourceCount: IDS.length };
  try {
    const rawPath = path.join(root, "raw-synthetic.json");
    const rawBytes = JSON.stringify(syntheticMemories(), null, 2);
    fs.writeFileSync(rawPath, rawBytes, { mode: 0o600 });
    const clusterRecord = syntheticCluster();
    const provider = createOllamaSynthesisProvider({
      baseUrl: PRIMARY_OLLAMA_URL,
      model: PRIMARY_MODEL,
      timeoutMs: 120000,
      maxResponseBytes: 1024 * 1024,
      keepAlive: "5m",
      fetchImpl: fetch
    });
    const synthesis = await createSynthesisEngine({ modelProvider: provider }).synthesize({
      clusterRecord,
      memories: JSON.parse(fs.readFileSync(rawPath, "utf8"))
    });
    validateSynthesisResult(synthesis);
    const superMemory = createSuperMemoryRecord({
      userId: "qwen_live_synthetic_user",
      clusterRecord,
      synthesisResult: synthesis,
      committedAt: 1780000001000,
      processingAttemptId: "qwen-live-smoke-attempt"
    });
    validateSuperMemoryRecord(superMemory);
    fs.writeFileSync(path.join(root, "super-memory.json"), JSON.stringify(superMemory), { mode: 0o600 });
    if (fs.readFileSync(rawPath, "utf8") !== rawBytes) throw new Error("raw preservation failed");
    details = {
      requestId: synthesis.requestId,
      sourceCount: synthesis.output.source_memory_ids.length + synthesis.output.rejected_source_ids.length,
      confidence: synthesis.output.confidence,
      schemaValidation: "PASS",
      superMemoryId: superMemory.id
    };
    if (PRESERVE_TEMP) {
      details.temporaryDirectory = `PRESERVED:${root}`;
      report("PASS", details);
      return;
    }
    fs.rmSync(root, { recursive: true, force: true });
    details.temporaryDirectory = "DELETED";
    report("PASS", details);
  } catch {
    if (!PRESERVE_TEMP) fs.rmSync(root, { recursive: true, force: true });
    details.temporaryDirectory = PRESERVE_TEMP ? `PRESERVED:${root}` : "DELETED";
    report("FAIL", details);
    process.exitCode = 1;
  }
}

main().catch(() => {
  report("FAIL");
  process.exitCode = 1;
});
