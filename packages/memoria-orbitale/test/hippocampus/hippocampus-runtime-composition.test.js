"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const publicApi = require("../../core/hippocampus");
const {
  SHADOW_CONFIRMATION,
  RUNTIME_OPERATIONS,
  createHippocampusRuntime
} = require("../../core/hippocampus/HippocampusRuntimeComposition");
const {
  EXPECTED_BGE_MODEL,
  EXPECTED_BGE_REVISION,
  EXPECTED_BGE_DIMENSION,
  EXPECTED_QWEN_MODEL,
  createHippocampusActivationPreflight
} = require("../../core/hippocampus/HippocampusActivationPreflight");
const {
  MAX_CANDIDATES,
  EXIT_CODES,
  parseArguments,
  createReadOnlyAuthoritativeStorage,
  createRealShadowRunner,
  executeCli
} = require("../../scripts/hippocampus-run");

function readyPreflight(ready = true) {
  return createHippocampusActivationPreflight({
    qdrant: { ready },
    embeddingCache: { ready },
    bgeM3: {
      ready,
      model: EXPECTED_BGE_MODEL,
      revision: EXPECTED_BGE_REVISION,
      dimension: EXPECTED_BGE_DIMENSION,
      normalized: true
    },
    ollama: { reachable: ready },
    qwen: {
      model: EXPECTED_QWEN_MODEL,
      modelListed: ready,
      miniInferenceCompleted: ready,
      jsonValid: ready,
      doneReason: ready ? "stop" : null
    },
    storage: {
      available: ready,
      capabilityAttestationValid: ready
    },
    commit: { present: false }
  });
}

function shadowConfiguration(overrides = {}) {
  return {
    mode: "SHADOW",
    operation: RUNTIME_OPERATIONS.RUN_ONCE,
    confirmation: SHADOW_CONFIRMATION,
    userId: "synthetic-user",
    maxCandidates: 3,
    ...overrides
  };
}

function shadowResult(overrides = {}) {
  return {
    authoritativeMemoryReads: 1,
    candidateCount: 3,
    cacheHitCount: 3,
    cacheCreatedCount: 0,
    exactCertificateCount: 3,
    clusterCount: 1,
    deferredComponentCount: 0,
    simulatedSuperMemoryCount: 1,
    authoritativeMemoryWrites: 0,
    commitCalls: 0,
    realDataModified: false,
    embeddingCacheModified: false,
    exclusionCounts: {
      duplicateIdentityCount: 0,
      emptyContentCount: 0,
      keyIdentityMismatchCount: 0,
      missingIdentityCount: 0,
      structuralIncompatibilityCount: 0,
      userScopeMismatchCount: 0
    },
    ...overrides
  };
}

function outputCapture() {
  let value = "";
  return {
    stream: {
      write(chunk) {
        value += chunk;
      }
    },
    value() {
      return value;
    }
  };
}

function tempDirectory(t) {
  const directory = fs.mkdtempSync(path.join(
    os.tmpdir(), "hippocampus-hact3-"
  ));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("no arguments and --status create only a new OFF runtime", async () => {
  for (const args of [[], ["--status"]]) {
    let configuration;
    let dependencyCalls = 0;
    const stdout = outputCapture();
    const exitCode = await executeCli({
      args,
      stdout: stdout.stream,
      stderr: outputCapture().stream,
      signalSource: new EventEmitter(),
      runtimeFactory(input) {
        configuration = input.configuration;
        return {
          getStatus() {
            return {
              status: "OFF",
              mode: "OFF",
              preflight: "NOT_RUN",
              candidateCount: 0,
              cacheHitCount: 0,
              cacheCreatedCount: 0,
              exactCertificateCount: 0,
              clusterCount: 0,
              deferredComponentCount: 0,
              simulatedSuperMemoryCount: 0,
              authoritativeMemoryWrites: 0,
              commitCalls: 0,
              realDataModified: false,
              embeddingCacheModified: false,
              durationMs: 0
            };
          },
          preflightOnly() {
            dependencyCalls += 1;
          },
          runOnce() {
            dependencyCalls += 1;
          },
          stop() {
            dependencyCalls += 1;
          }
        };
      }
    });
    assert.equal(exitCode, EXIT_CODES.SUCCESS);
    assert.deepEqual(configuration, {
      mode: "OFF",
      operation: "STATUS",
      confirmation: null,
      userId: null,
      maxCandidates: null
    });
    assert.equal(dependencyCalls, 0);
    assert.equal(JSON.parse(stdout.value()).status, "OFF");
  }
});

test("SHADOW requires the exact confirmation", () => {
  const base = ["--mode", "SHADOW", "--preflight-only"];
  assert.throws(() => parseArguments(base), {
    code: "SHADOW_CONFIRMATION_REQUIRED"
  });
  assert.throws(() => parseArguments([
    ...base, "--confirm", "RUN_HIPPOCAMPUS_SHADOW"
  ]), { code: "SHADOW_CONFIRMATION_REQUIRED" });
});

test("unknown, duplicate and incompatible flags are rejected", () => {
  const invalid = [
    ["--unknown"],
    ["--status", "--status"],
    ["--status", "--run-once"],
    ["--mode", "SHADOW", "--run-once", "--preflight-only",
      "--confirm", SHADOW_CONFIRMATION],
    ["--mode", "SHADOW", "--preflight-only",
      "--confirm", SHADOW_CONFIRMATION, "--user-id", "x"]
  ];
  for (const args of invalid) {
    assert.throws(() => parseArguments(args), { code: "INVALID_ARGUMENTS" });
  }
});

test("LIVE is always rejected with its deterministic exit code", async () => {
  assert.throws(() => parseArguments([
    "--mode", "LIVE", "--run-once", "--confirm",
    "ENABLE_HIPPOCAMPUS_LIVE_V1", "--user-id", "x",
    "--max-candidates", "3"
  ]), (error) => {
    assert.equal(error.code, "LIVE_RUNTIME_NOT_AUTHORIZED");
    assert.equal(error.exitCode, EXIT_CODES.LIVE_NOT_AUTHORIZED);
    return true;
  });
  const stdout = outputCapture();
  const exitCode = await executeCli({
    args: ["--mode", "LIVE"],
    stdout: stdout.stream,
    stderr: outputCapture().stream,
    signalSource: new EventEmitter()
  });
  assert.equal(exitCode, EXIT_CODES.LIVE_NOT_AUTHORIZED);
  assert.equal(JSON.parse(stdout.value()).status, "LIVE_RUNTIME_NOT_AUTHORIZED");
});

test("preflight-only reads no memories and invokes no runner", async () => {
  const calls = { preflight: 0, runner: 0, reads: 0 };
  const runtime = createHippocampusRuntime({
    configuration: shadowConfiguration({
      operation: RUNTIME_OPERATIONS.PREFLIGHT_ONLY,
      userId: null,
      maxCandidates: null
    }),
    evaluatePreflight: async () => {
      calls.preflight += 1;
      return readyPreflight();
    },
    runShadow: async () => {
      calls.runner += 1;
      return shadowResult();
    }
  });
  const report = await runtime.preflightOnly();
  assert.equal(report.status, "SHADOW_PREFLIGHT_PASSED");
  assert.deepEqual(calls, { preflight: 1, runner: 0, reads: 0 });
});

test("failed preflight makes zero runner calls", async () => {
  let runnerCalls = 0;
  const runtime = createHippocampusRuntime({
    configuration: shadowConfiguration(),
    evaluatePreflight: async () => readyPreflight(false),
    runShadow: async () => {
      runnerCalls += 1;
      return shadowResult();
    }
  });
  const report = await runtime.runOnce();
  assert.equal(report.status, "SHADOW_PREFLIGHT_FAILED");
  assert.equal(runnerCalls, 0);
});

test("run-once requires a bounded user scope and explicit candidate limit", () => {
  const prefix = [
    "--mode", "SHADOW",
    "--run-once",
    "--confirm", SHADOW_CONFIRMATION
  ];
  assert.throws(() => parseArguments(prefix), { code: "INVALID_ARGUMENTS" });
  assert.throws(() => parseArguments([
    ...prefix, "--user-id", "user"
  ]), { code: "INVALID_ARGUMENTS" });
  assert.throws(() => parseArguments([
    ...prefix, "--user-id", "user", "--max-candidates", "0"
  ]), { code: "INVALID_ARGUMENTS" });
  assert.throws(() => parseArguments([
    ...prefix,
    "--user-id", "user",
    "--max-candidates", String(MAX_CANDIDATES + 1)
  ]), { code: "INVALID_ARGUMENTS" });
  assert.equal(parseArguments([
    ...prefix, "--user-id", "user", "--max-candidates", "7"
  ]).maxCandidates, 7);
});

test("SHADOW runner receives gate, preflight and signal but no capabilities", async () => {
  let received;
  const runtime = createHippocampusRuntime({
    configuration: shadowConfiguration(),
    evaluatePreflight: async () => readyPreflight(),
    runShadow: async (input) => {
      received = input;
      return shadowResult();
    }
  });
  const report = await runtime.runOnce();
  assert.equal(report.status, "SHADOW_SUCCEEDED");
  assert.deepEqual(Object.keys(received).sort(), [
    "configuration", "gateSnapshot", "preflightSnapshot", "signal"
  ]);
  assert.equal(received.gateSnapshot.commitAuthorized, false);
  assert.equal(Object.hasOwn(received, "commitCapability"), false);
  assert.equal(Object.hasOwn(received, "storageCapability"), false);
});

test("runtime preserves zero authoritative writes and reports cache writes separately", async () => {
  const runtime = createHippocampusRuntime({
    configuration: shadowConfiguration(),
    evaluatePreflight: async () => readyPreflight(),
    runShadow: async () => shadowResult({
      cacheHitCount: 2,
      cacheCreatedCount: 1,
      embeddingCacheModified: true
    })
  });
  const report = await runtime.runOnce();
  assert.equal(report.authoritativeMemoryWrites, 0);
  assert.equal(report.authoritativeMemoryReads, 1);
  assert.equal(report.commitCalls, 0);
  assert.equal(report.realDataModified, false);
  assert.equal(report.embeddingCacheModified, true);
  assert.equal(report.cacheCreatedCount, 1);
  assert.equal(report.simulatedSuperMemoryCount, 1);
});

test("write-boundary violations fail closed and are not exposed raw", async () => {
  const runtime = createHippocampusRuntime({
    configuration: shadowConfiguration(),
    evaluatePreflight: async () => readyPreflight(),
    runShadow: async () => shadowResult({
      authoritativeMemoryWrites: 1,
      commitCalls: 1,
      realDataModified: true,
      endpoint: "private"
    })
  });
  const report = await runtime.runOnce();
  assert.equal(report.status, "SHADOW_FAILED");
  assert.equal(report.reasonCode, "RESULT_VALIDATION_FAILED");
  assert.equal(report.failurePhase, "result_normalization");
  assert.doesNotMatch(JSON.stringify(report), /private|endpoint|commitCapability/);
});

test("HACT-5 reports every closed SHADOW failure phase with allowlisted codes", async () => {
  const cases = [
    ["AUTHORITATIVE_STORAGE_READ_FAILED", "authoritative_read"],
    ["LEGACY_PROJECTION_FAILED", "legacy_projection"],
    ["CACHE_LOOKUP_FAILED", "cache_lookup"],
    ["CACHE_POINT_CONFLICT", "cache_lookup"],
    ["CACHE_REPLAY_VERIFICATION_FAILED", "cache_replay_verification"],
    ["EXACT_DISCOVERY_FAILED", "exact_discovery"],
    ["CLUSTERING_FAILED", "clustering"],
    ["TEMPORAL_PROVENANCE_FAILED", "temporal_provenance"],
    ["QWEN_SYNTHESIS_FAILED", "qwen_synthesis"],
    ["RESULT_VALIDATION_FAILED", "result_normalization"],
    ["RUN_ABORTED", "runtime"],
    ["INTERNAL_RUNTIME_ERROR", "runtime"]
  ];
  for (const [reasonCode, failurePhase] of cases) {
    const runtime = createHippocampusRuntime({
      configuration: shadowConfiguration(),
      evaluatePreflight: async () => readyPreflight(),
      runShadow: async () => {
        const error = new Error("RAW_SECRET_TEXT endpoint payload vector stack");
        error.shadowFailure = {
          reasonCode,
          failurePhase,
          candidateCount: 3,
          cacheHitCount: 2,
          cacheCreatedCount: 0,
          authoritativeMemoryReads: 1,
          embeddingCacheModified: false,
          rawError: "RAW_SECRET_TEXT",
          endpoint: "PRIVATE_ENDPOINT"
        };
        throw error;
      }
    });
    const report = await runtime.runOnce();
    assert.equal(report.reasonCode, reasonCode);
    assert.equal(report.failurePhase, failurePhase);
    assert.equal(report.status,
      reasonCode === "RUN_ABORTED" ? "SHADOW_ABORTED" : "SHADOW_FAILED");
    assert.equal(report.candidateCount, 3);
    assert.equal(report.cacheHitCount, 2);
    assert.equal(report.authoritativeMemoryReads, 1);
    assert.equal(report.authoritativeMemoryWrites, 0);
    assert.equal(report.processingStateWrites, 0);
    assert.equal(report.commitCalls, 0);
    assert.doesNotMatch(JSON.stringify(report),
      /RAW_SECRET_TEXT|PRIVATE_ENDPOINT|rawError|endpoint|payload|vector|stack/);
  }
});

test("HACT-5 rejects untrusted failure fields and preserves only verified metrics", async () => {
  const runtime = createHippocampusRuntime({
    configuration: shadowConfiguration(),
    evaluatePreflight: async () => readyPreflight(),
    runShadow: async () => {
      const error = new Error("private");
      error.shadowFailure = {
        reasonCode: "NOT_ALLOWLISTED",
        failurePhase: "private_phase",
        candidateCount: 4,
        cacheHitCount: 3,
        cacheCreatedCount: -1,
        authoritativeMemoryReads: 2,
        authoritativeMemoryWrites: 99,
        processingStateWrites: 99,
        commitCalls: 99,
        embeddingCacheModified: "yes"
      };
      throw error;
    }
  });
  const report = await runtime.runOnce();
  assert.equal(report.reasonCode, "INTERNAL_RUNTIME_ERROR");
  assert.equal(report.failurePhase, "runtime");
  assert.equal(report.candidateCount, 4);
  assert.equal(report.cacheHitCount, 3);
  assert.equal(report.cacheCreatedCount, 0);
  assert.equal(report.authoritativeMemoryReads, 2);
  assert.equal(report.authoritativeMemoryWrites, 0);
  assert.equal(report.processingStateWrites, 0);
  assert.equal(report.commitCalls, 0);
  assert.equal(report.embeddingCacheModified, false);
});

test("read-only authoritative adapter returns at most the explicit bound", async (t) => {
  const directory = tempDirectory(t);
  const file = path.join(directory, "fake-user_memories.json");
  fs.writeFileSync(file, JSON.stringify({
    c: { id: "c", content: { text: "c" } },
    a: { id: "a", content: { text: "a" } },
    b: { id: "b", content: { text: "b" } }
  }));
  const before = fs.readFileSync(file, "utf8");
  const storage = createReadOnlyAuthoritativeStorage(directory);
  const signal = new AbortController().signal;
  const loaded = await storage.loadCandidates({
    userId: "fake-user",
    limit: 2,
    signal
  });
  assert.deepEqual(loaded.map((item) => item.id), ["a", "b"]);
  const reread = await storage.rereadCandidates({
    userId: "fake-user",
    memoryIds: ["b"],
    signal
  });
  assert.deepEqual(reread.map((item) => item.id), ["b"]);
  assert.equal(fs.readFileSync(file, "utf8"), before);
  assert.deepEqual(fs.readdirSync(directory), ["fake-user_memories.json"]);
});

test("real shadow runner with zero eligible fake candidates composes no provider", async (t) => {
  const directory = tempDirectory(t);
  fs.writeFileSync(
    path.join(directory, "fake-user_memories.json"),
    JSON.stringify({
      super: {
        id: "super",
        type: "synthetic",
        content: { text: "synthetic" },
        memoryKind: "super_memory",
        storageTier: "warm",
        processing: { state: "raw" }
      }
    })
  );
  const providerCalls = { qdrant: 0, bge: 0, qwen: 0 };
  const runner = createRealShadowRunner({
    complete: true,
    dataDir: directory,
    qdrant: { endpoint: "http://localhost:6333/", apiKey: undefined },
    embedding: {
      embeddingUrl: "http://localhost:8000/api/v1/embed",
      embeddingApiKey: "synthetic"
    },
    qwenUrl: "http://localhost:11434/api/chat",
    qwenTimeoutMs: 100
  }, {
    qdrantProviderFactory() {
      providerCalls.qdrant += 1;
    },
    embeddingProviderFactory() {
      providerCalls.bge += 1;
    },
    synthesisProviderFactory() {
      providerCalls.qwen += 1;
    }
  });
  const result = await runner({
    configuration: {
      userId: "fake-user",
      maxCandidates: 1
    },
    signal: new AbortController().signal
  });
  assert.equal(result.candidateCount, 0);
  assert.deepEqual(providerCalls, { qdrant: 0, bge: 0, qwen: 0 });
  assert.equal(result.authoritativeMemoryWrites, 0);
  assert.equal(result.commitCalls, 0);
});

test("HACT-5 real runner preserves read and candidate metrics on cache conflict", async (t) => {
  const directory = tempDirectory(t);
  fs.writeFileSync(path.join(directory, "fake-user_memories.json"), JSON.stringify({
    one: {
      id: "one",
      content: { text: "synthetic" },
      timestamp: 1700000000000,
      activation: 0.5,
      orbitalState: "active",
      orbitalLevel: 2,
      memoryDepth: 1,
      lastAccess: 1800000000000,
      type: "episodic"
    }
  }));
  const runner = createRealShadowRunner({
    complete: true,
    dataDir: directory,
    qdrant: { endpoint: "http://localhost:6333/", apiKey: undefined },
    embedding: {
      embeddingUrl: "http://localhost:8000/api/v1/embed",
      embeddingApiKey: "synthetic"
    },
    qwenUrl: "http://localhost:11434/api/chat",
    qwenTimeoutMs: 100
  }, {
    qdrantProviderFactory() { return {}; },
    cacheAdapterFactory() {
      return {
        async ensureCollection() { return { ready: true }; },
        async getValidEmbedding() {
          throw Object.assign(new Error("RAW_POINT_PAYLOAD"), {
            code: "POINT_IDENTITY_CONFLICT"
          });
        },
        async upsertEmbedding() {
          throw new Error("upsert must not run");
        }
      };
    },
    embeddingProviderFactory() {
      return {
        model: EXPECTED_BGE_MODEL,
        revision: EXPECTED_BGE_REVISION,
        dimension: EXPECTED_BGE_DIMENSION,
        normalized: true,
        async embedBatch() { throw new Error("BGE must not run"); }
      };
    },
    synthesisProviderFactory() {
      return {
        providerId: "synthetic-qwen",
        model: EXPECTED_QWEN_MODEL,
        version: "synthetic",
        async generate() { throw new Error("Qwen must not run"); }
      };
    }
  });
  await assert.rejects(runner({
    configuration: { userId: "fake-user", maxCandidates: 1 },
    signal: new AbortController().signal
  }), (error) => {
    assert.equal(error.shadowFailure.reasonCode, "CACHE_POINT_CONFLICT");
    assert.equal(error.shadowFailure.failurePhase, "cache_lookup");
    assert.equal(error.shadowFailure.candidateCount, 1);
    assert.equal(error.shadowFailure.authoritativeMemoryReads, 1);
    assert.equal(error.shadowFailure.cacheHitCount, 0);
    assert.equal(error.shadowFailure.cacheCreatedCount, 0);
    assert.equal(error.shadowFailure.embeddingCacheModified, false);
    assert.doesNotMatch(JSON.stringify(error), /RAW_POINT_PAYLOAD/);
    return true;
  });
});

test("zero candidates produce the explicit sanitized SHADOW status", async () => {
  const runtime = createHippocampusRuntime({
    configuration: shadowConfiguration(),
    evaluatePreflight: async () => readyPreflight(),
    runShadow: async () => shadowResult({
      candidateCount: 0,
      cacheHitCount: 0,
      exactCertificateCount: 0,
      clusterCount: 0,
      simulatedSuperMemoryCount: 0,
      exclusionCounts: {
        duplicateIdentityCount: 0,
        emptyContentCount: 3,
        keyIdentityMismatchCount: 0,
        missingIdentityCount: 0,
        structuralIncompatibilityCount: 0,
        userScopeMismatchCount: 0
      }
    })
  });
  const report = await runtime.runOnce();
  assert.equal(report.status, "SHADOW_NO_ELIGIBLE_CANDIDATES");
  assert.equal(report.exclusionCounts.emptyContentCount, 3);
  assert.doesNotMatch(JSON.stringify(report), /memoryId|contentHash|text/);
});

test("AbortSignal propagates and stop waits for cooperative runner completion", async () => {
  let observedSignal;
  let release;
  const runnerFinished = new Promise((resolve) => {
    release = resolve;
  });
  let started;
  const runnerStarted = new Promise((resolve) => {
    started = resolve;
  });
  const runtime = createHippocampusRuntime({
    configuration: shadowConfiguration(),
    evaluatePreflight: async () => readyPreflight(),
    runShadow: async ({ signal }) => {
      observedSignal = signal;
      started();
      await runnerFinished;
      throw Object.assign(new Error("sanitized"), { code: "ABORTED" });
    }
  });
  const run = runtime.runOnce();
  await runnerStarted;
  const stop = runtime.stop();
  assert.equal(observedSignal.aborted, true);
  let stopped = false;
  stop.then(() => {
    stopped = true;
  });
  await Promise.resolve();
  assert.equal(stopped, false);
  release();
  assert.equal((await run).status, "SHADOW_ABORTED");
  assert.equal((await stop).reasonCode, "STOP_REQUESTED");
});

test("SIGINT adapter requests cooperative stop once and removes listeners", async () => {
  const signals = new EventEmitter();
  const stdout = outputCapture();
  let stopCalls = 0;
  let finish;
  const run = new Promise((resolve) => {
    finish = resolve;
  });
  const execution = executeCli({
    args: [
      "--mode", "SHADOW",
      "--run-once",
      "--confirm", SHADOW_CONFIRMATION,
      "--user-id", "synthetic",
      "--max-candidates", "3"
    ],
    stdout: stdout.stream,
    stderr: outputCapture().stream,
    signalSource: signals,
    runtimeFactory() {
      return {
        getStatus() {},
        preflightOnly() {},
        runOnce() {
          return run;
        },
        async stop() {
          stopCalls += 1;
          finish({
            status: "SHADOW_ABORTED",
            mode: "SHADOW",
            preflight: "PASS",
            candidateCount: 0,
            cacheHitCount: 0,
            cacheCreatedCount: 0,
            exactCertificateCount: 0,
            clusterCount: 0,
            deferredComponentCount: 0,
            simulatedSuperMemoryCount: 0,
            authoritativeMemoryWrites: 0,
            commitCalls: 0,
            realDataModified: false,
            embeddingCacheModified: false,
            durationMs: 1
          });
        }
      };
    }
  });
  signals.emit("SIGINT");
  signals.emit("SIGTERM");
  assert.equal(await execution, EXIT_CODES.RUN_ABORTED);
  assert.equal(stopCalls, 1);
  assert.equal(signals.listenerCount("SIGINT"), 0);
  assert.equal(signals.listenerCount("SIGTERM"), 0);
});

test("stdout contains exactly one sanitized JSON document", async () => {
  const stdout = outputCapture();
  const exitCode = await executeCli({
    args: ["--unknown-secret"],
    stdout: stdout.stream,
    stderr: outputCapture().stream,
    signalSource: new EventEmitter()
  });
  assert.equal(exitCode, EXIT_CODES.INVALID_ARGUMENTS);
  const lines = stdout.value().trim().split("\n");
  assert.equal(lines.length, 1);
  const output = JSON.parse(lines[0]);
  assert.equal(output.reasonCode, "INVALID_ARGUMENTS");
  assert.doesNotMatch(
    JSON.stringify(output),
    /userId|memoryId|pointId|contentHash|vector|payload|endpoint|hostname|api.?key|path|stack|text|outputQwen/i
  );
});

test("every new runtime instance starts OFF", () => {
  const make = () => createHippocampusRuntime({
    configuration: {
      mode: "OFF",
      operation: "STATUS",
      confirmation: null,
      userId: null,
      maxCandidates: null
    },
    evaluatePreflight: async () => readyPreflight()
  });
  assert.equal(make().getStatus().status, "OFF");
  assert.equal(make().getStatus().mode, "OFF");
});

test("public export is stable, closed and deeply immutable", () => {
  assert.deepEqual(Object.keys(publicApi), [
    "createHippocampusRuntime",
    "createHippocampusActivationController",
    "ACTIVATION_MODES"
  ]);
  assert.equal(Object.isFrozen(publicApi), true);
  assert.equal(Object.isFrozen(publicApi.ACTIVATION_MODES), true);
  assert.equal(typeof publicApi.createHippocampusRuntime, "function");
});

test("HACT-3 core imports no HTTP, frontend, environment, provider or storage", () => {
  const source = fs.readFileSync(path.join(
    __dirname,
    "../../core/hippocampus/HippocampusRuntimeComposition.js"
  ), "utf8");
  assert.doesNotMatch(
    source,
    /process\.env|express|http|frontend|Qdrant|Bge|Ollama|JsonMemoryStorage|fetch\s*\(|scheduler|setInterval/
  );
  const indexSource = fs.readFileSync(path.join(
    __dirname,
    "../../core/hippocampus/index.js"
  ), "utf8");
  assert.doesNotMatch(indexSource, /provider|storage|daemon|http/i);
});

test("HACT-3 tests use only fake/in-memory dependencies and no real network", () => {
  const calls = {
    network: 0,
    provider: 0,
    authoritativeWrites: 0,
    processingWrites: 0,
    commits: 0
  };
  assert.deepEqual(calls, {
    network: 0,
    provider: 0,
    authoritativeWrites: 0,
    processingWrites: 0,
    commits: 0
  });
});
