"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  LIVE_CONFIRMATION_TOKEN,
  COMMIT_CAPABILITY_ID,
  STORAGE_ATTESTATION_CONTRACT_VERSION,
  REQUIRED_LIVE_STORAGE_CAPABILITIES,
  createHippocampusActivationGate
} = require("../../core/hippocampus/HippocampusActivationGate");
const {
  EXPECTED_BGE_MODEL,
  EXPECTED_BGE_REVISION,
  EXPECTED_BGE_DIMENSION,
  EXPECTED_QWEN_MODEL,
  createHippocampusActivationPreflight
} = require("../../core/hippocampus/HippocampusActivationPreflight");
const {
  HippocampusActivationControllerError,
  createHippocampusActivationController
} = require("../../core/hippocampus/HippocampusActivationController");
const {
  DEFAULT_MAX_BODY_BYTES,
  createHippocampusControlPlaneHttpRouter
} = require("../../core/hippocampus/HippocampusControlPlaneHttpRouter");

function commitCapability(counters = { commits: 0 }) {
  return {
    schemaVersion: 1,
    capabilityId: COMMIT_CAPABILITY_ID,
    commit() {
      counters.commits += 1;
    }
  };
}

function storageCapability() {
  return {
    schemaVersion: 1,
    contractVersion: STORAGE_ATTESTATION_CONTRACT_VERSION,
    capabilities: REQUIRED_LIVE_STORAGE_CAPABILITIES.map((capability) => ({
      capability,
      status: "supported",
      verified: true
    }))
  };
}

function preflightInput({ ready = true, live = false } = {}) {
  return {
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
    commit: { present: live }
  };
}

function controllerOptions(overrides = {}) {
  let clock = 1_700_000_000_000;
  return {
    createGate: createHippocampusActivationGate,
    evaluatePreflight: async () =>
      createHippocampusActivationPreflight(preflightInput()),
    runner: async () => ({
      clusterCount: 1,
      deferredComponentCount: 0,
      simulatedSuperMemoryCount: 1
    }),
    now: () => {
      clock += 1;
      return clock;
    },
    ...overrides
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function httpRequest(method, requestPath, body, headers = {}) {
  const request = {
    method,
    path: requestPath,
    headers
  };
  if (body !== undefined) request.body = body;
  return request;
}

function jsonPost(requestPath, value) {
  return httpRequest("POST", requestPath, JSON.stringify(value), {
    "content-type": "application/json"
  });
}

test("new controller instances start OFF and IDLE without side effects", () => {
  const calls = { gate: 0, preflight: 0, runner: 0 };
  const make = () => createHippocampusActivationController(controllerOptions({
    createGate(options) {
      calls.gate += 1;
      return createHippocampusActivationGate(options);
    },
    evaluatePreflight: async () => {
      calls.preflight += 1;
      return createHippocampusActivationPreflight(preflightInput());
    },
    runner: async () => {
      calls.runner += 1;
    }
  }));
  const first = make();
  assert.deepEqual(first.getStatus(), {
    mode: "OFF",
    lifecycleState: "IDLE",
    runId: null,
    runStartedAt: null,
    runFinishedAt: null,
    stopRequested: false,
    lastResult: null
  });
  const before = { ...calls };
  assert.deepEqual(first.getStatus(), first.getStatus());
  assert.deepEqual(calls, before);
  const restarted = make();
  assert.equal(restarted.getStatus().mode, "OFF");
  assert.equal(restarted.getStatus().lifecycleState, "IDLE");
  assert.equal(calls.preflight, 0);
  assert.equal(calls.runner, 0);
});

test("setMode SHADOW is explicit and never starts a run", () => {
  const calls = { preflight: 0, runner: 0 };
  const controller = createHippocampusActivationController(controllerOptions({
    evaluatePreflight: async () => {
      calls.preflight += 1;
      return createHippocampusActivationPreflight(preflightInput());
    },
    runner: async () => {
      calls.runner += 1;
    }
  }));
  const result = controller.setMode({ mode: "SHADOW" });
  assert.equal(result.accepted, true);
  assert.equal(result.reasonCode, "MODE_UPDATED");
  assert.equal(result.status.mode, "SHADOW");
  assert.equal(result.status.lifecycleState, "IDLE");
  assert.deepEqual(calls, { preflight: 0, runner: 0 });
});

test("invalid mode and client capabilities fail closed without changing mode", () => {
  const controller = createHippocampusActivationController(controllerOptions());
  for (const request of [
    { mode: "ON" },
    { mode: true },
    { mode: "SHADOW", commitCapability: { commit() {} } },
    { mode: "LIVE", storageCapability: {} }
  ]) {
    assert.throws(() => controller.setMode(request), (error) => {
      assert.equal(error instanceof HippocampusActivationControllerError, true);
      assert.equal(error.code, "INVALID_REQUEST");
      assert.equal(error.retryable, false);
      return true;
    });
    assert.equal(controller.getStatus().mode, "OFF");
  }
});

test("LIVE uses only server-side capabilities and remains fail closed", () => {
  const counters = { commits: 0 };
  const withoutCapabilities = createHippocampusActivationController(
    controllerOptions()
  );
  assert.equal(withoutCapabilities.setMode({
    mode: "LIVE",
    liveConfirmation: LIVE_CONFIRMATION_TOKEN
  }).reasonCode, "LIVE_NOT_AUTHORIZED");
  assert.equal(withoutCapabilities.getStatus().mode, "OFF");

  const controller = createHippocampusActivationController(controllerOptions({
    commitCapability: commitCapability(counters),
    storageCapability: storageCapability()
  }));
  const result = controller.setMode({
    mode: "LIVE",
    liveConfirmation: LIVE_CONFIRMATION_TOKEN
  });
  assert.equal(result.accepted, true);
  assert.equal(result.status.mode, "LIVE");
  assert.equal(counters.commits, 0);
});

test("OFF rejects run and missing runner fails closed", async () => {
  const off = createHippocampusActivationController(controllerOptions());
  assert.equal((await off.runOnce({})).reasonCode, "ACTIVATION_OFF");
  const unavailable = createHippocampusActivationController(
    controllerOptions({ runner: undefined })
  );
  unavailable.setMode({ mode: "SHADOW" });
  const result = await unavailable.runOnce({});
  assert.equal(result.accepted, false);
  assert.equal(result.reasonCode, "RUNNER_UNAVAILABLE");
  assert.equal(result.status.lifecycleState, "FAILED");
});

test("preflight failure invokes no runner", async () => {
  let runnerCalls = 0;
  const controller = createHippocampusActivationController(controllerOptions({
    evaluatePreflight: async () =>
      createHippocampusActivationPreflight(preflightInput({ ready: false })),
    runner: async () => {
      runnerCalls += 1;
    }
  }));
  controller.setMode({ mode: "SHADOW" });
  const result = await controller.runOnce({});
  assert.equal(result.reasonCode, "PREFLIGHT_NOT_READY");
  assert.equal(result.status.lifecycleState, "FAILED");
  assert.equal(runnerCalls, 0);
});

test("SHADOW runner receives only immutable snapshots and AbortSignal", async () => {
  const counters = { commits: 0 };
  let received;
  const controller = createHippocampusActivationController(controllerOptions({
    commitCapability: commitCapability(counters),
    storageCapability: storageCapability(),
    runner: async (input) => {
      received = input;
      return { clusterCount: 1 };
    }
  }));
  controller.setMode({ mode: "SHADOW" });
  const result = await controller.runOnce({});
  assert.equal(result.reasonCode, "RUN_SUCCEEDED");
  assert.deepEqual(Object.keys(received).sort(), [
    "gateSnapshot", "preflightSnapshot", "signal"
  ]);
  assert.equal(Object.isFrozen(received.gateSnapshot), true);
  assert.equal(Object.isFrozen(received.preflightSnapshot), true);
  assert.equal(received.gateSnapshot.commitAuthorized, false);
  assert.equal(Object.hasOwn(received, "commitCapability"), false);
  assert.equal(counters.commits, 0);
});

test("concurrent run and mode change are rejected while one runner is active", async () => {
  const release = deferred();
  const started = deferred();
  const controller = createHippocampusActivationController(controllerOptions({
    runner: async () => {
      started.resolve();
      await release.promise;
      return {};
    }
  }));
  controller.setMode({ mode: "SHADOW" });
  const first = controller.runOnce({});
  await started.promise;
  assert.equal((await controller.runOnce({})).reasonCode, "RUN_ALREADY_ACTIVE");
  const modeChange = controller.setMode({ mode: "OFF" });
  assert.equal(modeChange.reasonCode, "MODE_CHANGE_REJECTED_RUN_ACTIVE");
  assert.equal(controller.getStatus().mode, "SHADOW");
  release.resolve();
  assert.equal((await first).reasonCode, "RUN_SUCCEEDED");
});

test("stop is idempotent, propagates AbortSignal and waits for runner exit", async () => {
  const release = deferred();
  const started = deferred();
  let observedAbort = false;
  const controller = createHippocampusActivationController(controllerOptions({
    runner: async ({ signal }) => {
      signal.addEventListener("abort", () => {
        observedAbort = true;
      }, { once: true });
      started.resolve();
      await release.promise;
      return {};
    }
  }));
  controller.setMode({ mode: "SHADOW" });
  const run = controller.runOnce({});
  await started.promise;
  const firstStop = controller.stop({});
  const secondStop = controller.stop({});
  assert.equal(observedAbort, true);
  assert.equal(controller.getStatus().lifecycleState, "STOPPING");
  let stopFinished = false;
  firstStop.then(() => {
    stopFinished = true;
  });
  await Promise.resolve();
  assert.equal(stopFinished, false);
  release.resolve();
  const [runResult, stopOne, stopTwo] = await Promise.all([
    run, firstStop, secondStop
  ]);
  assert.equal(runResult.reasonCode, "RUN_ABORTED");
  assert.equal(stopOne.reasonCode, "STOP_REQUESTED");
  assert.equal(stopTwo.reasonCode, "STOP_REQUESTED");
  assert.equal(stopOne.status.lifecycleState, "ABORTED");
  assert.equal(stopOne.status.stopRequested, true);
  assert.equal((await controller.stop({})).reasonCode, "NO_ACTIVE_RUN");
});

test("runner results and failures are sanitized and deeply immutable", async () => {
  const secret = "secret-api-key";
  const controller = createHippocampusActivationController(controllerOptions({
    runner: async () => ({
      clusterCount: 3,
      deferredComponentCount: 2,
      simulatedSuperMemoryCount: 1,
      text: "private memory",
      vector: [0.1],
      endpoint: "http://private",
      apiKey: secret,
      payload: { raw: true }
    })
  }));
  controller.setMode({ mode: "SHADOW" });
  const result = await controller.runOnce({});
  assert.deepEqual(result.status.lastResult, {
    status: "SUCCEEDED",
    reasonCode: "RUN_SUCCEEDED",
    clusterCount: 3,
    deferredComponentCount: 2,
    simulatedSuperMemoryCount: 1
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.status), true);
  assert.equal(Object.isFrozen(result.status.lastResult), true);
  assert.doesNotMatch(
    JSON.stringify(result),
    /private|secret|endpoint|api.?key|payload|vector|text/i
  );

  const failed = createHippocampusActivationController(controllerOptions({
    runner: async () => {
      const error = new Error(`raw ${secret} http://private`);
      error.stack = `stack ${secret}`;
      throw error;
    }
  }));
  failed.setMode({ mode: "SHADOW" });
  const failure = await failed.runOnce({});
  assert.equal(failure.reasonCode, "RUN_FAILED");
  assert.doesNotMatch(JSON.stringify(failure), /secret|private|stack|http/i);
});

test("no automatic mode transition occurs across completed runs", async () => {
  const controller = createHippocampusActivationController(controllerOptions());
  controller.setMode({ mode: "SHADOW" });
  await controller.runOnce({});
  assert.equal(controller.getStatus().mode, "SHADOW");
  await controller.runOnce({});
  assert.equal(controller.getStatus().mode, "SHADOW");
});

test("HTTP router exercises all four endpoints with closed JSON responses", async () => {
  const controller = createHippocampusActivationController(controllerOptions());
  const router = createHippocampusControlPlaneHttpRouter({
    controller,
    authorizeRequest: async () => true
  });
  const status = await router.handle(httpRequest(
    "GET", "/api/hippocampus/status", undefined
  ));
  assert.equal(status.statusCode, 200);
  assert.equal(status.body.status.mode, "OFF");

  const mode = await router.handle(jsonPost(
    "/api/hippocampus/mode", { mode: "SHADOW" }
  ));
  assert.equal(mode.statusCode, 200);
  assert.equal(mode.body.reasonCode, "MODE_UPDATED");

  const run = await router.handle(jsonPost("/api/hippocampus/run", {}));
  assert.equal(run.statusCode, 200);
  assert.equal(run.body.reasonCode, "RUN_SUCCEEDED");

  const stop = await router.handle(jsonPost("/api/hippocampus/stop", {}));
  assert.equal(stop.statusCode, 409);
  assert.equal(stop.body.reasonCode, "NO_ACTIVE_RUN");
});

test("HTTP rejects unknown fields, capabilities, content types and oversized body", async () => {
  const controller = createHippocampusActivationController(controllerOptions());
  const router = createHippocampusControlPlaneHttpRouter({
    controller,
    authorizeRequest: () => true
  });
  const cases = [
    jsonPost("/api/hippocampus/mode", {
      mode: "SHADOW", commitCapability: { capabilityId: "client" }
    }),
    jsonPost("/api/hippocampus/run", { extra: true }),
    jsonPost("/api/hippocampus/stop", { storageCapability: {} })
  ];
  for (const request of cases) {
    const result = await router.handle(request);
    assert.equal(result.statusCode, 400);
    assert.deepEqual(result.body, {
      ok: false,
      reasonCode: "INVALID_REQUEST"
    });
  }
  const wrongType = await router.handle(httpRequest(
    "POST", "/api/hippocampus/run", "{}", { "content-type": "text/plain" }
  ));
  assert.equal(wrongType.statusCode, 415);
  const oversized = await router.handle(httpRequest(
    "POST",
    "/api/hippocampus/run",
    `"${"x".repeat(DEFAULT_MAX_BODY_BYTES)}"`,
    { "content-type": "application/json" }
  ));
  assert.equal(oversized.statusCode, 413);
});

test("HTTP methods, authorization and malformed input fail deterministically", async () => {
  const controller = createHippocampusActivationController(controllerOptions());
  const denied = createHippocampusControlPlaneHttpRouter({
    controller,
    authorizeRequest: () => false
  });
  assert.equal((await denied.handle(httpRequest(
    "GET", "/api/hippocampus/status", undefined
  ))).statusCode, 403);

  const router = createHippocampusControlPlaneHttpRouter({
    controller,
    authorizeRequest: () => true
  });
  const wrongMethod = await router.handle(httpRequest(
    "POST",
    "/api/hippocampus/status",
    "{}",
    { "content-type": "application/json" }
  ));
  assert.equal(wrongMethod.statusCode, 405);
  assert.equal(wrongMethod.headers.allow, "GET");
  assert.equal((await router.handle(httpRequest(
    "GET", "/api/hippocampus/unknown", undefined
  ))).statusCode, 404);
  assert.equal((await router.handle(httpRequest(
    "GET", "/api/hippocampus/status", "{}"
  ))).statusCode, 400);
  assert.equal((await router.handle(httpRequest(
    "POST",
    "/api/hippocampus/run",
    "{malformed",
    { "content-type": "application/json" }
  ))).statusCode, 400);
});

test("pure HACT-2 modules import no frontend, provider, network or storage runtime", () => {
  const files = [
    "HippocampusActivationController.js",
    "HippocampusControlPlaneHttpRouter.js"
  ];
  for (const file of files) {
    const source = fs.readFileSync(path.join(
      __dirname, "../../core/hippocampus", file
    ), "utf8");
    assert.doesNotMatch(
      source,
      /apps\/|frontend|express|http:|https:|qdrant|bge-m3|qwen|ollama|process\.env|JsonMemoryStorage|\.commit\s*\(/
    );
  }
});

test("HACT-2 fake execution performs zero network, storage, data and commit calls", async () => {
  const calls = {
    network: 0, storageReads: 0, storageWrites: 0, commits: 0
  };
  const controller = createHippocampusActivationController(controllerOptions({
    commitCapability: commitCapability(calls),
    storageCapability: storageCapability(),
    runner: async ({ gateSnapshot }) => {
      assert.equal(gateSnapshot.mode, "SHADOW");
      return {
        clusterCount: 0,
        deferredComponentCount: 0,
        simulatedSuperMemoryCount: 0
      };
    }
  }));
  controller.setMode({ mode: "SHADOW" });
  await controller.runOnce({});
  assert.deepEqual(calls, {
    network: 0, storageReads: 0, storageWrites: 0, commits: 0
  });
});
