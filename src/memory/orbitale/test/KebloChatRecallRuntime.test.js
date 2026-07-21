import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  createKebloChatRecallRuntime,
  parseKebloChatRecallEnvironment
} from "../KebloChatRecallRuntime.js";

function warm(id, text, activation = 0.4, userId = undefined) {
  return { id, type: "episodic", content: { text }, activation, timestamp: 1,
    lastAccess: 1, accessCount: 0, memoryKind: "raw", storageTier: "warm",
    processingState: "raw", userId };
}

function core(id, text) {
  return { id, type: "super_memory", content: { text }, timestamp: 1,
    memoryKind: "super_memory", storageTier: "core", processing: { state: "consolidated" },
    source_memory_ids: [] };
}

async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kint4-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function call(runtime, id, rawText = "ricordi il progetto orbitale?", overrides = {}) {
  return runtime.recallForChat({ session: { user: { id } }, rawText, primaryIntent: "recall",
    memoryCanAssist: true, ...overrides });
}

test("feature parsing is explicit and defaults absolutely off", async () => {
  for (const value of [undefined, "", "TRUE", "1", "yes", true]) {
    const config = parseKebloChatRecallEnvironment({ KEBLO_ORBITAL_RECALL_ENABLED: value });
    assert.equal(config.enabled, false);
    const runtime = createKebloChatRecallRuntime(config);
    assert.deepEqual((await runtime.recallForChat()).context, "");
  }
  assert.throws(() => parseKebloChatRecallEnvironment({ KEBLO_ORBITAL_RECALL_ENABLED: "true" }),
    /allowlist/);
  assert.throws(() => parseKebloChatRecallEnvironment({ KEBLO_ORBITAL_RECALL_ENABLED: "true",
    KEBLO_ORBITAL_RECALL_USER_IDS: "alice", KEBLO_ORBITAL_MEMORY_DATA_DIR: "relative" }), /baseDir/);
});

test("enabled but unauthorized user bypasses before filesystem access", async (t) => {
  const dir = path.join(await tempDir(t), "does-not-exist");
  const runtime = createKebloChatRecallRuntime({ enabled: true, allowedUserIds: ["alice"],
    baseDir: dir, maxItems: 3, maxContextChars: 1000 });
  const result = await call(runtime, "bob");
  assert.equal(result.context, "");
  assert.equal(result.metrics.reasonCode, "USER_NOT_ALLOWED");
  assert.equal(result.metrics.bypassed, true);
});

test("identity comes only from session and two users remain isolated", async (t) => {
  const dir = await tempDir(t);
  await writeFile(path.join(dir, "alice_memories.json"), JSON.stringify([warm("a", "alice project", 0.5, "alice")]));
  await writeFile(path.join(dir, "bob_memories.json"), JSON.stringify([warm("b", "bob project", 0.5, "bob")]));
  const runtime = createKebloChatRecallRuntime({ enabled: true, allowedUserIds: ["alice", "bob"],
    baseDir: dir, maxItems: 3, maxContextChars: 1000 });
  const alice = await runtime.recallForChat({ session: { user: { id: "alice" } },
    body: { userId: "bob" }, query: { userId: "bob" }, headers: { "x-user-id": "bob" },
    rawText: "project", primaryIntent: "recall", memoryCanAssist: true });
  const bob = await call(runtime, "bob", "project");
  assert.match(alice.context, /alice project/);
  assert.doesNotMatch(alice.context, /bob project/);
  assert.match(bob.context, /bob project/);
  assert.doesNotMatch(bob.context, /alice project/);
});

test("full read-only chain separates tiers, recognizes deep command and preserves fixture bytes", async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, "alice_memories.json");
  const fixture = JSON.stringify([core("summary", "orbital summary"), warm("raw", "orbital raw")], null, 2);
  await writeFile(file, fixture);
  const runtime = createKebloChatRecallRuntime({ enabled: true, allowedUserIds: ["alice"],
    baseDir: dir, maxItems: 4, maxContextChars: 1200 });
  const result = await call(runtime, "alice", "cerca nello storico completo: orbital");
  assert.match(result.context, /CORE SUPERMEMORY:/);
  assert.match(result.context, /WARM RAW MEMORY:/);
  assert.equal(result.metrics.coreCount, 1);
  assert.equal(result.metrics.warmCount, 1);
  assert.equal(result.metrics.bypassed, false);
  assert.equal(await readFile(file, "utf8"), fixture);
});

test("non-memory turn and empty recall add no context", async (t) => {
  const dir = await tempDir(t);
  const runtime = createKebloChatRecallRuntime({ enabled: true, allowedUserIds: ["alice"],
    baseDir: dir, maxItems: 3, maxContextChars: 1000 });
  const bypass = await call(runtime, "alice", "hello", { primaryIntent: "social", memoryCanAssist: false });
  assert.equal(bypass.context, "");
  assert.equal(bypass.metrics.reasonCode, "NOT_MEMORY_RELEVANT");
  const empty = await call(runtime, "alice");
  assert.equal(empty.context, "");
  assert.equal(empty.metrics.reasonCode, "EMPTY");
});

test("reader failure is sanitized and never interrupts chat", async (t) => {
  const dir = await tempDir(t);
  await writeFile(path.join(dir, "alice_memories.json"), "{private-corrupt");
  const runtime = createKebloChatRecallRuntime({ enabled: true, allowedUserIds: ["alice"],
    baseDir: dir, maxItems: 3, maxContextChars: 1000 });
  const result = await call(runtime, "alice");
  assert.equal(result.context, "");
  assert.equal(result.metrics.reasonCode, "RETRIEVER_FAILURE");
  assert.deepEqual(Object.keys(result.metrics).sort(), ["bypassed", "coreCount", "durationMs",
    "enabled", "reasonCode", "totalCount", "truncated", "warmCount"]);
  assert.equal(JSON.stringify(result).includes("private"), false);
});

test("ranker and router failures also fail open in isolated compositions", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
  const runtimeUrl = pathToFileURL(path.join(root, "src/memory/orbitale/KebloChatRecallRuntime.js")).href;
  const rankerPath = path.join(root, "packages/memoria-orbitale/core/recall/OrbitalReadOnlyRanker.js");
  const routerPath = path.join(root, "packages/memoria-orbitale/core/recall/RecallRouter.js");
  const probe = `
    import { createRequire } from "node:module";
    import { mkdtemp, writeFile, rm } from "node:fs/promises";
    import os from "node:os";
    import path from "node:path";
    const require = createRequire(import.meta.url);
    const target = process.argv[1] === "ranker" ? require(process.argv[3]) : require(process.argv[4]);
    if (process.argv[1] === "ranker") target.rankReadOnly = () => { const e = new Error("private"); e.code = "RANKER_SYNTHETIC"; throw e; };
    else target.createRecallRouter = () => ({ recall() { const e = new Error("private"); e.code = "ROUTER_SYNTHETIC"; throw e; } });
    const { createKebloChatRecallRuntime } = await import(process.argv[2] + "?failure=" + process.argv[1]);
    const dir = await mkdtemp(path.join(os.tmpdir(), "kint4-failure-"));
    try {
      await writeFile(path.join(dir, "alice_memories.json"), JSON.stringify([{ id: "m", type: "episodic",
        content: { text: "project" }, activation: 0.4, timestamp: 1, memoryKind: "raw",
        storageTier: "warm", processingState: "raw" }]));
      const runtime = createKebloChatRecallRuntime({ enabled: true, allowedUserIds: ["alice"],
        baseDir: dir, maxItems: 2, maxContextChars: 600 });
      const result = await runtime.recallForChat({ session: { user: { id: "alice" } }, rawText: "project",
        primaryIntent: "recall", memoryCanAssist: true });
      if (result.context !== "" || result.metrics.bypassed !== true || JSON.stringify(result).includes("private")) process.exit(2);
    } finally { await rm(dir, { recursive: true, force: true }); }
  `;
  for (const failure of ["ranker", "router"]) {
    execFileSync(process.execPath, ["--input-type=module", "-e", probe, failure,
      runtimeUrl, rankerPath, routerPath], { stdio: "pipe" });
  }
});
