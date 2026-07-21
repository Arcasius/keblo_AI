"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  HIPPOCAMPUS_ACTIVATION_MODES,
  HIPPOCAMPUS_ACTIVATION_REASON_CODES,
  LIVE_CONFIRMATION_TOKEN,
  COMMIT_CAPABILITY_ID,
  STORAGE_ATTESTATION_CONTRACT_VERSION,
  REQUIRED_LIVE_STORAGE_CAPABILITIES,
  HippocampusActivationGateError,
  createHippocampusActivationGate
} = require("../../core/hippocampus/HippocampusActivationGate");
const {
  EXPECTED_BGE_MODEL,
  EXPECTED_BGE_REVISION,
  EXPECTED_BGE_DIMENSION,
  EXPECTED_QWEN_MODEL,
  createHippocampusActivationPreflight,
  validateHippocampusActivationPreflight
} = require("../../core/hippocampus/HippocampusActivationPreflight");

function commitCapability(counters = { commits: 0 }) {
  return {
    schemaVersion: 1,
    capabilityId: COMMIT_CAPABILITY_ID,
    commit() {
      counters.commits += 1;
    }
  };
}

function storageCapability(overrides = {}) {
  return {
    schemaVersion: 1,
    contractVersion: STORAGE_ATTESTATION_CONTRACT_VERSION,
    capabilities: REQUIRED_LIVE_STORAGE_CAPABILITIES.map((capability) => ({
      capability,
      status: "supported",
      verified: true
    })),
    ...overrides
  };
}

function readyPreflight(overrides = {}) {
  return {
    qdrant: { ready: true },
    embeddingCache: { ready: true },
    bgeM3: {
      ready: true,
      model: EXPECTED_BGE_MODEL,
      revision: EXPECTED_BGE_REVISION,
      dimension: EXPECTED_BGE_DIMENSION,
      normalized: true
    },
    ollama: { reachable: true },
    qwen: {
      model: EXPECTED_QWEN_MODEL,
      modelListed: true,
      miniInferenceCompleted: true,
      jsonValid: true,
      doneReason: "stop"
    },
    storage: { available: true, capabilityAttestationValid: true },
    commit: { present: false },
    ...overrides
  };
}

test("omitted configuration defaults to a closed immutable OFF decision", () => {
  const gate = createHippocampusActivationGate();
  assert.deepEqual(gate, {
    mode: "OFF",
    activationAuthorized: false,
    shadowAuthorized: false,
    liveAuthorized: false,
    commitAuthorized: false,
    reasonCode: "ACTIVATION_OFF"
  });
  assert.equal(Object.isFrozen(gate), true);
});

test("every new instance without configuration restarts at OFF", () => {
  const live = createHippocampusActivationGate({
    mode: "LIVE",
    liveConfirmation: LIVE_CONFIRMATION_TOKEN,
    commitCapability: commitCapability(),
    storageCapability: storageCapability()
  });
  const restarted = createHippocampusActivationGate();
  assert.equal(live.mode, "LIVE");
  assert.equal(restarted.mode, "OFF");
  assert.equal(restarted.reasonCode, "ACTIVATION_OFF");
});

test("unknown and boolean activation modes fail closed with typed sanitized errors", () => {
  for (const mode of ["ON", "live", true, 1, null]) {
    assert.throws(() => createHippocampusActivationGate({ mode }), (error) => {
      assert.equal(error instanceof HippocampusActivationGateError, true);
      assert.equal(error.code, "INVALID_ACTIVATION_MODE");
      assert.equal(error.phase, "activation_gate");
      assert.equal(error.retryable, false);
      assert.equal(
        error.message,
        "Hippocampus activation gate configuration failed"
      );
      return true;
    });
  }
  assert.throws(
    () => createHippocampusActivationGate({ enabled: true }),
    { code: "INVALID_ACTIVATION_CONFIGURATION" }
  );
});

test("OFF composes no provider, reads no source and starts no daemon", () => {
  const calls = {
    compose: 0, qdrant: 0, bge: 0, qwen: 0, reads: 0, writes: 0, starts: 0
  };
  const gate = createHippocampusActivationGate({ mode: "OFF" });
  if (gate.activationAuthorized) calls.compose += 1;
  assert.deepEqual(calls, {
    compose: 0, qdrant: 0, bge: 0, qwen: 0, reads: 0, writes: 0, starts: 0
  });
});

test("SHADOW is explicitly authorized without commit", () => {
  assert.deepEqual(createHippocampusActivationGate({ mode: "SHADOW" }), {
    mode: "SHADOW",
    activationAuthorized: true,
    shadowAuthorized: true,
    liveAuthorized: false,
    commitAuthorized: false,
    reasonCode: "SHADOW_AUTHORIZED"
  });
});

test("SHADOW ignores a valid injected commit capability and never invokes it", () => {
  const counters = { commits: 0 };
  const gate = createHippocampusActivationGate({
    mode: "SHADOW",
    commitCapability: commitCapability(counters),
    storageCapability: storageCapability()
  });
  assert.equal(gate.commitAuthorized, false);
  assert.equal(gate.liveAuthorized, false);
  assert.equal(counters.commits, 0);
});

test("LIVE without token or with the wrong token remains unauthorized", () => {
  for (const liveConfirmation of [undefined, "", "ENABLE_HIPPOCAMPUS_LIVE"]) {
    const gate = createHippocampusActivationGate({
      mode: "LIVE",
      liveConfirmation,
      commitCapability: commitCapability(),
      storageCapability: storageCapability()
    });
    assert.equal(gate.activationAuthorized, false);
    assert.equal(gate.commitAuthorized, false);
    assert.equal(gate.reasonCode, "LIVE_CONFIRMATION_REQUIRED");
  }
});

test("LIVE with token but without commit capability remains unauthorized", () => {
  const gate = createHippocampusActivationGate({
    mode: "LIVE",
    liveConfirmation: LIVE_CONFIRMATION_TOKEN,
    storageCapability: storageCapability()
  });
  assert.equal(gate.reasonCode, "LIVE_COMMIT_CAPABILITY_REQUIRED");
  assert.equal(gate.activationAuthorized, false);
});

test("LIVE rejects missing or incomplete verified storage capability", () => {
  const missing = createHippocampusActivationGate({
    mode: "LIVE",
    liveConfirmation: LIVE_CONFIRMATION_TOKEN,
    commitCapability: commitCapability()
  });
  assert.equal(missing.reasonCode, "LIVE_STORAGE_CAPABILITY_REQUIRED");

  const incomplete = createHippocampusActivationGate({
    mode: "LIVE",
    liveConfirmation: LIVE_CONFIRMATION_TOKEN,
    commitCapability: commitCapability(),
    storageCapability: storageCapability({
      capabilities: REQUIRED_LIVE_STORAGE_CAPABILITIES.slice(1).map((capability) => ({
        capability, status: "supported", verified: true
      }))
    })
  });
  assert.equal(incomplete.reasonCode, "LIVE_STORAGE_CAPABILITY_REQUIRED");
  assert.equal(incomplete.liveAuthorized, false);
});

test("LIVE with every requirement authorizes the gate but executes no commit", () => {
  const counters = { commits: 0 };
  const gate = createHippocampusActivationGate({
    mode: "LIVE",
    liveConfirmation: LIVE_CONFIRMATION_TOKEN,
    commitCapability: commitCapability(counters),
    storageCapability: storageCapability()
  });
  assert.deepEqual(gate, {
    mode: "LIVE",
    activationAuthorized: true,
    shadowAuthorized: false,
    liveAuthorized: true,
    commitAuthorized: true,
    reasonCode: "LIVE_AUTHORIZED"
  });
  assert.equal(counters.commits, 0);
});

test("mode decisions are isolated and never auto-promote across cycles", () => {
  const shadow = createHippocampusActivationGate({ mode: "SHADOW" });
  const off = createHippocampusActivationGate();
  const refusedLive = createHippocampusActivationGate({ mode: "LIVE" });
  assert.equal(shadow.mode, "SHADOW");
  assert.equal(off.mode, "OFF");
  assert.equal(refusedLive.mode, "LIVE");
  assert.equal(refusedLive.liveAuthorized, false);
  assert.equal(refusedLive.reasonCode, "LIVE_CONFIRMATION_REQUIRED");
});

test("gate constants and outputs are deeply immutable", () => {
  assert.equal(Object.isFrozen(HIPPOCAMPUS_ACTIVATION_MODES), true);
  assert.equal(Object.isFrozen(HIPPOCAMPUS_ACTIVATION_REASON_CODES), true);
  assert.equal(Object.isFrozen(REQUIRED_LIVE_STORAGE_CAPABILITIES), true);
  const gate = createHippocampusActivationGate({ mode: "SHADOW" });
  assert.throws(() => { gate.mode = "LIVE"; }, TypeError);
  assert.equal(gate.mode, "SHADOW");
});

test("malformed capabilities and accessor configuration fail without disclosure", () => {
  assert.throws(() => createHippocampusActivationGate({
    mode: "LIVE",
    commitCapability: { endpoint: "private", apiKey: "secret" }
  }), (error) => {
    assert.equal(error.code, "INVALID_ACTIVATION_CONFIGURATION");
    assert.doesNotMatch(JSON.stringify(error), /private|secret|endpoint|api.?key/i);
    return true;
  });
  const options = {};
  Object.defineProperty(options, "mode", {
    enumerable: true,
    get() {
      throw new Error("must not execute");
    }
  });
  assert.throws(
    () => createHippocampusActivationGate(options),
    { code: "INVALID_ACTIVATION_CONFIGURATION" }
  );
});

test("preflight requires mini-inference; tags alone never make Qwen ready", () => {
  const report = createHippocampusActivationPreflight(readyPreflight({
    qwen: {
      model: EXPECTED_QWEN_MODEL,
      modelListed: true,
      miniInferenceCompleted: false,
      jsonValid: false,
      doneReason: null
    }
  }));
  assert.equal(report.qwen.verifiedReady, false);
  assert.equal(report.shadowReady, false);
  assert.equal(report.liveReady, false);
  assert.equal(report.reasonCodes.includes("QWEN_MINI_INFERENCE_NOT_READY"), true);
});

test("preflight represents ready SHADOW and requires commit evidence only for LIVE", () => {
  const shadow = createHippocampusActivationPreflight(readyPreflight());
  assert.equal(shadow.shadowReady, true);
  assert.equal(shadow.liveReady, false);
  assert.deepEqual(shadow.reasonCodes, ["COMMIT_CAPABILITY_NOT_PRESENT"]);
  const live = createHippocampusActivationPreflight(readyPreflight({
    commit: { present: true }
  }));
  assert.equal(live.shadowReady, true);
  assert.equal(live.liveReady, true);
  assert.deepEqual(live.reasonCodes, []);
  assert.equal(validateHippocampusActivationPreflight(live).valid, true);
});

test("preflight validates exact BGE provenance and rejects tampered reports", () => {
  const wrong = createHippocampusActivationPreflight(readyPreflight({
    bgeM3: {
      ready: true,
      model: EXPECTED_BGE_MODEL,
      revision: "wrong",
      dimension: EXPECTED_BGE_DIMENSION,
      normalized: true
    }
  }));
  assert.equal(wrong.bgeM3.verifiedReady, false);
  assert.equal(wrong.reasonCodes.includes("BGE_M3_NOT_READY"), true);
  const valid = createHippocampusActivationPreflight(readyPreflight());
  const tampered = {
    ...valid,
    qwen: { ...valid.qwen, verifiedReady: false }
  };
  assert.equal(validateHippocampusActivationPreflight(tampered).valid, false);
});

test("preflight output is deeply frozen, closed and contains no private runtime data", () => {
  const report = createHippocampusActivationPreflight(readyPreflight());
  assert.equal(Object.isFrozen(report), true);
  assert.equal(Object.isFrozen(report.qwen), true);
  assert.equal(Object.isFrozen(report.reasonCodes), true);
  assert.doesNotMatch(
    JSON.stringify(report),
    /endpoint|api.?key|userId|text|path|payload|vector/i
  );
});

test("pure HACT-1 modules import no frontend, network, provider or operational storage", () => {
  for (const relative of [
    "../../core/hippocampus/HippocampusActivationGate.js",
    "../../core/hippocampus/HippocampusActivationPreflight.js"
  ]) {
    const source = fs.readFileSync(path.join(__dirname, relative), "utf8");
    assert.doesNotMatch(source, /\brequire\s*\(/);
    assert.doesNotMatch(
      source,
      /process\.env|fetch\s*\(|Qdrant|BgeM3EmbeddingProvider|Ollama|JsonMemoryStorage|RecallRouter|frontend|server\.js/
    );
  }
});

test("HACT-1 uses only fake evidence and performs zero real reads, writes or network", () => {
  const calls = { reads: 0, writes: 0, network: 0, commits: 0 };
  createHippocampusActivationGate({
    mode: "LIVE",
    liveConfirmation: LIVE_CONFIRMATION_TOKEN,
    commitCapability: commitCapability(calls),
    storageCapability: storageCapability()
  });
  createHippocampusActivationPreflight(readyPreflight({
    commit: { present: true }
  }));
  assert.deepEqual(calls, { reads: 0, writes: 0, network: 0, commits: 0 });
});
