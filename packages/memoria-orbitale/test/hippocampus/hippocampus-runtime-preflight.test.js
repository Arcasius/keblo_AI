"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const {
  EXPECTED_BGE_MODEL,
  EXPECTED_BGE_REVISION,
  EXPECTED_BGE_DIMENSION,
  EXPECTED_QWEN_MODEL
} = require("../../core/hippocampus/HippocampusActivationPreflight");
const {
  SHADOW_CONFIRMATION
} = require("../../core/hippocampus/HippocampusRuntimeComposition");
const {
  EXIT_CODES,
  runtimeEnvironment,
  createRealPreflightEvaluator,
  createRealShadowRunner,
  executeCli
} = require("../../scripts/hippocampus-run");

const PREFLIGHT_ARGS = [
  "--mode", "SHADOW",
  "--preflight-only",
  "--confirm", SHADOW_CONFIRMATION
];

function capture() {
  let output = "";
  return {
    stream: { write(chunk) { output += chunk; } },
    value() { return output; }
  };
}

function temporaryStorage(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hact3b-storage-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function completeEnvironment(dataDir, overrides = {}) {
  return {
    HIPPOCAMPUS_EMBEDDING_URL: "http://127.0.0.1:8001/api/v1/embed",
    HIPPOCAMPUS_EMBEDDING_API_KEY: "test-bge-secret",
    HIPPOCAMPUS_QDRANT_URL: "http://127.0.0.1:6333",
    HIPPOCAMPUS_MEMORY_DATA_DIR: dataDir,
    HIPPOCAMPUS_QWEN_TIMEOUT_MS: "120000",
    PRIMARY_OLLAMA_URL: "http://127.0.0.1:11434/api/chat",
    PRIMARY_MODEL: EXPECTED_QWEN_MODEL,
    ...overrides
  };
}

function response(body, ok = true) {
  return {
    ok,
    headers: {
      get(name) {
        return name.toLowerCase() === "content-type"
          ? "application/json"
          : null;
      }
    },
    async text() { return JSON.stringify(body); }
  };
}

function bgeHealth(overrides = {}) {
  return {
    status: "healthy",
    model: EXPECTED_BGE_MODEL,
    revision: EXPECTED_BGE_REVISION,
    model_loaded: true,
    device: "cuda",
    dimension: EXPECTED_BGE_DIMENSION,
    ...overrides
  };
}

function successfulFetch(url) {
  const pathname = new URL(url).pathname;
  if (pathname === "/health") {
    return Promise.resolve(response(bgeHealth()));
  }
  if (pathname === "/api/tags") {
    return Promise.resolve(response({
      models: [{ name: EXPECTED_QWEN_MODEL }]
    }));
  }
  return Promise.resolve(response({
    done: true,
    done_reason: "stop",
    model: EXPECTED_QWEN_MODEL,
    message: { content: "{\"ready\":true}" }
  }));
}

function successfulInjections(overrides = {}) {
  return {
    qdrantProviderFactory() {
      return { async health() { return { ready: true }; } };
    },
    cacheAdapterFactory() {
      return { async ensureCollection() { return { ready: true }; } };
    },
    synthesisProviderFactory() {
      return {
        async generate() {
          return { ok: true, status: 200, text: "{\"ready\":true}" };
        }
      };
    },
    fetchImpl: successfulFetch,
    ...overrides
  };
}

async function evaluate(t, overrides = {}, injections = {}) {
  const config = runtimeEnvironment(completeEnvironment(
    temporaryStorage(t),
    overrides
  ));
  return createRealPreflightEvaluator(
    config,
    successfulInjections(injections)
  )({ signal: new AbortController().signal });
}

async function runCli(env, injections = {}) {
  const stdout = capture();
  const stderr = capture();
  const exitCode = await executeCli({
    args: PREFLIGHT_ARGS,
    env,
    injections,
    stdout: stdout.stream,
    stderr: stderr.stream,
    signalSource: new EventEmitter()
  });
  return {
    exitCode,
    report: JSON.parse(stdout.value()),
    stdout: stdout.value(),
    stderr: stderr.value()
  };
}

test("CLI real no longer uses an immediate placeholder preflight", async (t) => {
  let healthCalls = 0;
  const result = await runCli(completeEnvironment(temporaryStorage(t)), {
    ...successfulInjections(),
    qdrantProviderFactory() {
      return { async health() { healthCalls += 1; } };
    }
  });
  assert.equal(result.exitCode, EXIT_CODES.SUCCESS);
  assert.equal(result.report.reasonCode, "PREFLIGHT_READY");
  assert.equal(healthCalls, 1);
});

test("missing configuration is local and exposes names but never values", async () => {
  const secret = "must-not-appear-hact3b";
  let networkCalls = 0;
  const env = {
    HIPPOCAMPUS_EMBEDDING_URL: "http://127.0.0.1:8001/api/v1/embed",
    HIPPOCAMPUS_EMBEDDING_API_KEY: secret,
    HIPPOCAMPUS_QDRANT_URL: "http://127.0.0.1:6333"
  };
  const result = await runCli(env, {
    qdrantProviderFactory() { networkCalls += 1; }
  });
  assert.equal(result.exitCode, EXIT_CODES.PREFLIGHT_FAILED);
  assert.equal(result.report.reasonCode, "CONFIGURATION_INCOMPLETE");
  assert.deepEqual(result.report.missingConfigurationKeys, [
    "HIPPOCAMPUS_MEMORY_DATA_DIR",
    "HIPPOCAMPUS_QWEN_TIMEOUT_MS",
    "PRIMARY_MODEL",
    "PRIMARY_OLLAMA_URL"
  ]);
  assert.equal(result.report.checks.configuration, "FAIL");
  assert.equal(result.report.checks.qdrant, "NOT_RUN");
  assert.equal(networkCalls, 0);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(secret));
});

test("Node-style environment objects retain their exported configuration", (t) => {
  const env = Object.create({ runtimeEnvironmentPrototype: true });
  Object.assign(env, completeEnvironment(temporaryStorage(t)));
  const config = runtimeEnvironment(env);
  assert.equal(config.complete, true);
  assert.equal(config.reasonCode, "PREFLIGHT_READY");
});

test("public Qdrant requires its existing API-key name, private Qdrant does not", (t) => {
  const privateConfig = runtimeEnvironment(completeEnvironment(
    temporaryStorage(t)
  ));
  assert.equal(privateConfig.complete, true);
  const publicConfig = runtimeEnvironment(completeEnvironment(
    temporaryStorage(t),
    { HIPPOCAMPUS_QDRANT_URL: "https://qdrant.example.test" }
  ));
  assert.equal(publicConfig.reasonCode, "CONFIGURATION_INCOMPLETE");
  assert.deepEqual(publicConfig.missingConfigurationKeys, [
    "HIPPOCAMPUS_QDRANT_API_KEY"
  ]);
});

test("storage configuration failures are distinct and precede network", async (t) => {
  const invalid = runtimeEnvironment(completeEnvironment(
    temporaryStorage(t),
    { HIPPOCAMPUS_MEMORY_DATA_DIR: "relative-storage" }
  ));
  assert.equal(invalid.reasonCode, "STORAGE_CONFIGURATION_INVALID");
  const missingDirectory = path.join(temporaryStorage(t), "absent");
  let networkCalls = 0;
  const result = await runCli(completeEnvironment(missingDirectory), {
    qdrantProviderFactory() { networkCalls += 1; }
  });
  assert.equal(result.report.reasonCode, "STORAGE_CONFIGURATION_INVALID");
  assert.equal(result.report.checks.storage, "FAIL");
  assert.equal(networkCalls, 0);
});

test("Qdrant and incompatible cache failures have separate codes", async (t) => {
  const qdrant = await evaluate(t, {}, {
    qdrantProviderFactory() {
      return { async health() { throw new Error("raw endpoint detail"); } };
    }
  });
  assert.equal(qdrant.diagnostic.reasonCode, "QDRANT_UNAVAILABLE");
  assert.equal(qdrant.diagnostic.checks.qdrant, "FAIL");

  const cache = await evaluate(t, {}, {
    cacheAdapterFactory() {
      return { async ensureCollection() { return { ready: false }; } };
    }
  });
  assert.equal(cache.diagnostic.reasonCode, "EMBEDDING_CACHE_NOT_READY");
  assert.equal(cache.diagnostic.checks.qdrant, "PASS");
  assert.equal(cache.diagnostic.checks.embeddingCache, "FAIL");
});

test("real BGE health provenance passes without normalized", async (t) => {
  const result = await evaluate(t);
  assert.equal(result.diagnostic.reasonCode, "PREFLIGHT_READY");
  assert.equal(result.diagnostic.checks.bgeM3, "PASS");
});

test("BGE unavailable and BGE provenance mismatch are distinct", async (t) => {
  const unavailable = await evaluate(t, {}, {
    fetchImpl(url) {
      return new URL(url).pathname === "/health"
        ? Promise.resolve(response({}, false))
        : successfulFetch(url);
    }
  });
  assert.equal(unavailable.diagnostic.reasonCode, "BGE_M3_UNAVAILABLE");

  const mismatch = await evaluate(t, {}, {
    fetchImpl(url) {
      return new URL(url).pathname === "/health"
        ? Promise.resolve(response(bgeHealth({ model: "wrong-model" })))
        : successfulFetch(url);
    }
  });
  assert.equal(mismatch.diagnostic.reasonCode,
    "BGE_M3_PROVENANCE_MISMATCH");
});

test("BGE health rejects every mismatched provenance field", async (t) => {
  const mismatches = [
    ["status", "unhealthy"],
    ["revision", "wrong-revision"],
    ["model_loaded", false],
    ["device", "cpu"],
    ["dimension", EXPECTED_BGE_DIMENSION + 1]
  ];
  for (const [field, value] of mismatches) {
    const result = await evaluate(t, {}, {
      fetchImpl(url) {
        return new URL(url).pathname === "/health"
          ? Promise.resolve(response(bgeHealth({ [field]: value })))
          : successfulFetch(url);
      }
    });
    assert.equal(result.diagnostic.reasonCode,
      "BGE_M3_PROVENANCE_MISMATCH", field);
  }
});

test("BGE health rejects each missing required provenance field", async (t) => {
  for (const field of [
    "status", "model", "revision", "model_loaded", "device", "dimension"
  ]) {
    const health = bgeHealth();
    delete health[field];
    const result = await evaluate(t, {}, {
      fetchImpl(url) {
        return new URL(url).pathname === "/health"
          ? Promise.resolve(response(health))
          : successfulFetch(url);
      }
    });
    assert.equal(result.diagnostic.reasonCode,
      "BGE_M3_PROVENANCE_MISMATCH", field);
  }
});

test("Qwen availability and mini-inference failures are distinct", async (t) => {
  const unavailable = await evaluate(t, {}, {
    fetchImpl(url) {
      return new URL(url).pathname === "/api/tags"
        ? Promise.resolve(response({ models: [] }))
        : successfulFetch(url);
    }
  });
  assert.equal(unavailable.diagnostic.reasonCode, "QWEN_UNAVAILABLE");

  const inference = await evaluate(t, {}, {
    synthesisProviderFactory() {
      return {
        async generate() { throw new Error("raw inference output"); }
      };
    }
  });
  assert.equal(inference.diagnostic.reasonCode,
    "QWEN_MINI_INFERENCE_FAILED");
});

test("successful preflight is read-only and reports every component", async (t) => {
  const directory = temporaryStorage(t);
  const before = fs.readdirSync(directory);
  const result = await runCli(
    completeEnvironment(directory),
    successfulInjections()
  );
  assert.equal(result.exitCode, EXIT_CODES.SUCCESS);
  assert.deepEqual(result.report.checks, {
    configuration: "PASS",
    storage: "PASS",
    qdrant: "PASS",
    embeddingCache: "PASS",
    bgeM3: "PASS",
    qwenMiniInference: "PASS",
    commitCapabilityAbsent: "PASS"
  });
  assert.equal(result.report.authoritativeMemoryReads, 0);
  assert.equal(result.report.authoritativeMemoryWrites, 0);
  assert.equal(result.report.embeddingCacheWrites, 0);
  assert.equal(result.report.commitCalls, 0);
  assert.deepEqual(fs.readdirSync(directory), before);
  assert.equal(result.stderr, "");
  assert.doesNotMatch(result.stdout,
    /endpoint|hostname|api.?key|userId|path|text|vector|point.?id|payload|stack/i);
});

test("AbortSignal reaches the real preflight and produces a sanitized abort", async (t) => {
  const controller = new AbortController();
  let receivedSignal;
  const evaluator = createRealPreflightEvaluator(
    runtimeEnvironment(completeEnvironment(temporaryStorage(t))),
    successfulInjections({
      qdrantProviderFactory() {
        return {
          async health({ signal }) {
            receivedSignal = signal;
            controller.abort();
            throw new Error("raw abort");
          }
        };
      }
    })
  );
  const result = await evaluator({ signal: controller.signal });
  assert.equal(receivedSignal, controller.signal);
  assert.equal(result.diagnostic.reasonCode, "PREFLIGHT_ABORTED");
});

test("real runner is composable but preflight-only never starts it", async (t) => {
  const config = runtimeEnvironment(completeEnvironment(temporaryStorage(t)));
  assert.equal(typeof createRealShadowRunner(config, successfulInjections()),
    "function");
  let runnerProviderCalls = 0;
  const result = await runCli(completeEnvironment(temporaryStorage(t)), {
    ...successfulInjections(),
    embeddingProviderFactory() { runnerProviderCalls += 1; }
  });
  assert.equal(result.report.status, "SHADOW_PREFLIGHT_PASSED");
  assert.equal(runnerProviderCalls, 0);
});

test("LIVE remains disabled", async () => {
  const stdout = capture();
  const exitCode = await executeCli({
    args: ["--mode", "LIVE"],
    stdout: stdout.stream,
    stderr: capture().stream,
    signalSource: new EventEmitter()
  });
  assert.equal(exitCode, EXIT_CODES.LIVE_NOT_AUTHORIZED);
  assert.equal(JSON.parse(stdout.value()).reasonCode,
    "LIVE_RUNTIME_NOT_AUTHORIZED");
});
