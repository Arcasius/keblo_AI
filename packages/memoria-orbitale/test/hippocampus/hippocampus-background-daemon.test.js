"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { EventEmitter } = require("node:events");

const { KebloMemory, MemoryStorage } = require("../../core/Keblomemory.js");
const { createRecallRouter } = require("../../core/recall/RecallRouter.js");
const { createLegacyRecallAdapter } = require("../../core/recall/LegacyRecallAdapter.js");
const { buildRecallRequest } = require("../../core/recall/RecallRequestBuilder.js");
const { SHADOW_CONFIRMATION } = require(
  "../../core/hippocampus/HippocampusRuntimeComposition"
);
const {
  DAEMON_OPERATIONS,
  parseDaemonArguments,
  createHippocampusBackgroundSupervisor,
  executeDaemonCli
} = require("../../scripts/hippocampus-daemon");

const USER = "hact8-fake-user";

function shadowArgs(extra) {
  return [
    "--mode", "SHADOW",
    "--confirm", SHADOW_CONFIRMATION,
    "--user-id", USER,
    "--max-candidates", "7",
    ...extra
  ];
}

function shadowConfiguration(operation = DAEMON_OPERATIONS.RUN_ONCE) {
  return {
    mode: "SHADOW",
    operation,
    confirmation: SHADOW_CONFIRMATION,
    userId: USER,
    maxCandidates: 7,
    intervalMs: operation === DAEMON_OPERATIONS.INTERVAL ? 250 : null
  };
}

function shadowReport(overrides = {}) {
  return {
    status: "SHADOW_SUCCEEDED",
    mode: "SHADOW",
    reasonCode: "SHADOW_SUCCEEDED",
    authoritativeMemoryReads: 1,
    authoritativeMemoryWrites: 0,
    processingStateWrites: 0,
    commitCalls: 0,
    clusterCount: 1,
    simulatedSuperMemoryCount: 1,
    realDataModified: false,
    ...overrides
  };
}

function outputCapture() {
  let value = "";
  return {
    stream: { write(chunk) { value += chunk; } },
    value: () => value
  };
}

function fakeScheduler() {
  let nextId = 1;
  const scheduled = [];
  return {
    scheduled,
    setTimeout(callback, delay) {
      const item = { id: nextId++, callback, delay, cleared: false };
      scheduled.push(item);
      return item.id;
    },
    clearTimeout(id) {
      const item = scheduled.find((entry) => entry.id === id);
      if (item) item.cleared = true;
    },
    fireNext() {
      const item = scheduled.find((entry) => !entry.cleared && !entry.fired);
      assert.ok(item);
      item.fired = true;
      item.callback();
      return item;
    }
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function waitFor(predicate) {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("condition not reached");
}

test("default startup is absolute OFF with zero factory, provider, read, write or signal side effect", async () => {
  const stdout = outputCapture();
  const signals = new EventEmitter();
  let supervisorCalls = 0;
  const exitCode = await executeDaemonCli({
    args: [],
    stdout: stdout.stream,
    signalSource: signals,
    supervisorFactory() {
      supervisorCalls += 1;
      throw new Error("must remain lazy");
    }
  });
  const report = JSON.parse(stdout.value());
  assert.equal(exitCode, 0);
  assert.equal(report.status, "OFF");
  assert.equal(report.mode, "OFF");
  assert.equal(report.authoritativeMemoryReads, 0);
  assert.equal(report.authoritativeMemoryWrites, 0);
  assert.equal(report.commitCalls, 0);
  assert.equal(supervisorCalls, 0);
  assert.equal(signals.listenerCount("SIGINT"), 0);
  assert.equal(signals.listenerCount("SIGTERM"), 0);
});

test("SHADOW run-once succeeds without HACT-7 commit and LIVE is always rejected", async () => {
  let runtimeCreations = 0;
  let runCalls = 0;
  let commitBridgeCalls = 0;
  const stdout = outputCapture();
  const exitCode = await executeDaemonCli({
    args: shadowArgs(["--run-once"]),
    stdout: stdout.stream,
    signalSource: new EventEmitter(),
    runtimeFactory() {
      runtimeCreations += 1;
      return {
        async runOnce() { runCalls += 1; return shadowReport(); },
        async stop() {}
      };
    },
    injections: {
      commitBridge: { commit() { commitBridgeCalls += 1; } }
    }
  });
  const report = JSON.parse(stdout.value());
  assert.equal(exitCode, 0);
  assert.equal(report.status, "SHADOW_CYCLE_SUCCEEDED");
  assert.equal(report.cycleCount, 1);
  assert.equal(report.commitCalls, 0);
  assert.equal(runtimeCreations, 1);
  assert.equal(runCalls, 1);
  assert.equal(commitBridgeCalls, 0);
  assert.throws(() => parseDaemonArguments(["--mode", "LIVE"]), {
    code: "LIVE_RUNTIME_NOT_AUTHORIZED"
  });
  assert.throws(() => parseDaemonArguments([
    "--mode", "SHADOW", "--confirm", "wrong",
    "--user-id", USER, "--max-candidates", "7", "--run-once"
  ]), {
    code: "SHADOW_CONFIRMATION_REQUIRED"
  });
});

test("single-cycle guard prevents overlap", async () => {
  const gate = deferred();
  let entered = 0;
  const supervisor = createHippocampusBackgroundSupervisor({
    configuration: shadowConfiguration(),
    runtimeFactory() {
      return {
        async runOnce() { entered += 1; return gate.promise; },
        async stop() {}
      };
    },
    scheduler: fakeScheduler()
  });
  const running = supervisor.start();
  await waitFor(() => entered === 1);
  const overlap = await supervisor.runCycle();
  assert.equal(overlap.status, "SHADOW_CYCLE_SKIPPED");
  assert.equal(overlap.reasonCode, "RUN_ALREADY_ACTIVE");
  assert.equal(entered, 1);
  gate.resolve(shadowReport());
  assert.equal((await running).successfulCycleCount, 1);
});

test("explicit interval is deterministic, has no implicit default and schedules only after completion", async () => {
  assert.throws(() => parseDaemonArguments(shadowArgs([])), {
    code: "INVALID_DAEMON_ARGUMENTS"
  });
  const parsed = parseDaemonArguments(shadowArgs(["--interval-ms", "250"]));
  assert.equal(parsed.intervalMs, 250);
  const scheduler = fakeScheduler();
  let calls = 0;
  const reports = [];
  const supervisor = createHippocampusBackgroundSupervisor({
    configuration: parsed,
    runtimeFactory() {
      return {
        async runOnce() { calls += 1; return shadowReport(); },
        async stop() {}
      };
    },
    scheduler,
    onReport(value) { reports.push(value); }
  });
  await supervisor.start();
  assert.equal(calls, 1);
  assert.equal(scheduler.scheduled.length, 1);
  assert.equal(scheduler.scheduled[0].delay, 250);
  scheduler.fireNext();
  await waitFor(() => calls === 2 && scheduler.scheduled.length === 2);
  assert.equal(Math.max(...reports.map((item) => item.cycleCount)), 2);
  await supervisor.requestStop();
});

for (const signalName of ["SIGINT", "SIGTERM"]) {
  test(`${signalName} aborts cooperatively and waits for the active cycle`, async () => {
    const signalSource = new EventEmitter();
    const active = deferred();
    let entered = false;
    let stopCalls = 0;
    const stdout = outputCapture();
    const execution = executeDaemonCli({
      args: shadowArgs(["--interval-ms", "100"]),
      stdout: stdout.stream,
      signalSource,
      scheduler: fakeScheduler(),
      runtimeFactory() {
        return {
          async runOnce() { entered = true; return active.promise; },
          async stop() {
            stopCalls += 1;
            active.resolve(shadowReport({ status: "SHADOW_ABORTED", reasonCode: "RUN_ABORTED" }));
          }
        };
      }
    });
    await waitFor(() => entered);
    signalSource.emit(signalName);
    const exitCode = await execution;
    const report = JSON.parse(stdout.value());
    assert.equal(exitCode, 0);
    assert.equal(stopCalls, 1);
    assert.equal(report.status, "STOPPED");
    assert.equal(report.stopRequested, true);
    assert.equal(report.reasonCode, `${signalName}_STOP_REQUESTED`);
    assert.equal(signalSource.listenerCount(signalName), 0);
  });
}

test("a failed cycle is sanitized and does not terminate the interval supervisor", async () => {
  const scheduler = fakeScheduler();
  let calls = 0;
  const serialized = [];
  const supervisor = createHippocampusBackgroundSupervisor({
    configuration: shadowConfiguration(DAEMON_OPERATIONS.INTERVAL),
    runtimeFactory() {
      return {
        async runOnce() {
          calls += 1;
          if (calls === 1) throw new Error("PRIVATE_TEXT source-a endpoint secret");
          return shadowReport();
        },
        async stop() {}
      };
    },
    scheduler,
    onReport(value) { serialized.push(JSON.stringify(value)); }
  });
  const first = await supervisor.start();
  assert.equal(first.status, "SHADOW_CYCLE_FAILED");
  assert.doesNotMatch(serialized.join(""), /PRIVATE_TEXT|source-a|endpoint|secret/i);
  scheduler.fireNext();
  await waitFor(() => calls === 2);
  assert.equal(supervisor.getStatus().successfulCycleCount, 1);
  assert.equal(supervisor.getStatus().failedCycleCount, 1);
  await supervisor.requestStop();
});

async function recallFixture(memories) {
  const storage = new MemoryStorage();
  await storage.saveMemories(USER, memories);
  const memory = new KebloMemory({ storage });
  const router = createRecallRouter(createLegacyRecallAdapter({
    kebloMemory: memory,
    userId: USER
  }));
  memory.setRecallRouter(router);
  return { storage, memory, router };
}

function rawMemory() {
  return {
    id: "raw-1",
    type: "episodic",
    content: { text: "topic hact8 raw" },
    activation: 0.4,
    orbitalState: 0.4,
    orbitalLevel: "medium",
    memoryDepth: "normal",
    timestamp: 1000,
    lastAccess: 1000,
    accessCount: 0,
    tags: []
  };
}

function persistedSuperMemory() {
  return {
    schemaVersion: 1,
    id: "sm_hact7_fake",
    userId: USER,
    type: "super_memory",
    memoryKind: "super_memory",
    storageTier: "core",
    content: { text: "topic hact8 synthesis" },
    source_memory_ids: ["covered-raw"],
    timestamp: 1000
  };
}

test("shared fake storage lets RecallRouter retrieve persisted SuperMemory and raw distinctly", async () => {
  const state = await recallFixture([persistedSuperMemory(), rawMemory()]);
  const output = await state.router.recall(buildRecallRequest({
    query: "topic hact8",
    limit: 10
  }));
  assert.deepEqual(output.results.map((item) => item.memoryKind).sort(), ["episodic", "super_memory"]);
  assert.deepEqual(output.results.map((item) => item.retrievalTier).sort(), ["core", "warm"]);
  assert.equal(output.results.find((item) => item.memoryKind === "super_memory").id,
    "sm_hact7_fake");
});

test("daemon absence or failure does not alter chat recall behavior", async () => {
  const state = await recallFixture([rawMemory()]);
  const request = buildRecallRequest({ query: "topic hact8", limit: 10 });
  const before = await state.router.recall(request);
  const supervisor = createHippocampusBackgroundSupervisor({
    configuration: shadowConfiguration(),
    runtimeFactory() {
      return {
        async runOnce() { throw new Error("private daemon failure"); },
        async stop() {}
      };
    },
    scheduler: fakeScheduler()
  });
  assert.equal((await supervisor.start()).status, "SHADOW_CYCLE_FAILED");
  const after = await state.router.recall(request);
  assert.deepEqual(after, before);
  assert.deepEqual(after.results.map((item) => item.id), ["raw-1"]);
});

test("HACT-8 command contains no commit bridge, chat wiring, storage writer or network implementation", () => {
  const daemonFile = path.join(__dirname, "..", "..", "scripts", "hippocampus-daemon.js");
  const daemonSource = fs.readFileSync(daemonFile, "utf8");
  const chatSource = fs.readFileSync(path.join(__dirname, "..", "..", "chat_orbitale_ollama.js"), "utf8");
  assert.doesNotMatch(daemonSource, /HippocampusBoundedCommitBridge|commitCapability|JsonMemoryStorage|fetch\s*\(|deleteMemory|saveMemor/);
  assert.doesNotMatch(chatSource, /hippocampus-daemon|HippocampusDaemon|BgeM3|Qdrant|BoundedPipeline/);
  assert.match(chatSource, /createRecallRouter/);
  assert.match(chatSource, /new JsonMemoryStorage\(dataDir\)/);
});
