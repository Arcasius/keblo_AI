"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  PROCESSING_STATE_SCHEMA_VERSION,
  PROCESSING_STATES,
  PROCESSING_TRANSITIONS,
  ProcessingStateError,
  createProcessingState,
  validateProcessingState,
  canTransitionProcessingState,
  createProcessingTransitionPlan,
  validateProcessingTransitionPlan
} = require("../../core/consolidation/ProcessingState");

const T0 = 1780000000000;

function state(stateName, extra = {}) {
  const attempt = ["synthesizing", "consolidated", "failed"].includes(stateName)
    ? "attempt-001"
    : null;
  const error = stateName === "failed"
    ? { code: "SYNTHESIS_FAILED", message: "Synthetic technical failure", retryable: true }
    : null;
  return createProcessingState({
    state: stateName,
    updated_at: T0,
    attempt_id: attempt,
    error,
    ...extra
  });
}

function transition(current, toState, extra = {}) {
  return createProcessingTransitionPlan({
    memoryId: "synthetic-memory",
    current,
    toState,
    updatedAt: current.updated_at + 1,
    reason: `TEST_${current.state.toUpperCase()}_TO_${toState.toUpperCase()}`,
    ...(current.state === "candidate" && toState === "synthesizing"
      ? { attemptId: "attempt-next" }
      : {}),
    ...(current.state === "synthesizing" && toState === "failed"
      ? { error: { code: "SYNTHESIS_FAILED", message: "Synthetic technical failure", retryable: true } }
      : {}),
    ...extra
  });
}

function mutable(value) {
  return JSON.parse(JSON.stringify(value));
}

test("exports the exact immutable state vocabulary and transition table", () => {
  assert.equal(PROCESSING_STATE_SCHEMA_VERSION, 1);
  assert.deepEqual(PROCESSING_STATES, {
    RAW: "raw", CANDIDATE: "candidate", SYNTHESIZING: "synthesizing",
    CONSOLIDATED: "consolidated", FAILED: "failed"
  });
  assert.deepEqual(PROCESSING_TRANSITIONS, {
    raw: ["candidate"],
    candidate: ["raw", "synthesizing"],
    synthesizing: ["consolidated", "failed"],
    consolidated: [],
    failed: ["candidate", "raw"]
  });
  assert.equal(Object.isFrozen(PROCESSING_STATES), true);
  assert.equal(Object.isFrozen(PROCESSING_TRANSITIONS), true);
  assert.equal(Object.isFrozen(PROCESSING_TRANSITIONS.candidate), true);
});

test("creates explicit raw state with complete future-persistable shape", () => {
  const processing = createProcessingState({ state: "raw", updated_at: T0 });
  assert.deepEqual(processing, {
    schema_version: 1,
    state: "raw",
    revision: 0,
    attempt_id: null,
    updated_at: T0,
    error: null
  });
  assert.equal(Object.getPrototypeOf(processing), Object.prototype);
  assert.equal(Object.isFrozen(processing), true);
  assert.deepEqual(validateProcessingState(processing), { valid: true, errors: [] });
});

test("requires explicit input, canonical state and timestamp with no raw default", () => {
  for (const input of [undefined, null, "raw", []]) {
    assert.throws(() => createProcessingState(input), ProcessingStateError);
  }
  assert.throws(() => createProcessingState({ updated_at: T0 }), /unknown processing state/);
  assert.throws(() => createProcessingState({ state: "raw" }), /updated_at/);
  for (const invalid of ["RAW", "Raw", "candiate", "unknown"]) {
    assert.throws(() => createProcessingState({ state: invalid, updated_at: T0 }), /unknown/);
  }
  assert.throws(() => createProcessingState({ state: "raw", updated_at: T0, unknown: true }), /Unsupported/);
});

test("validates revision imports and finite non-negative integer timestamps", () => {
  assert.equal(state("raw", { revision: 7 }).revision, 7);
  for (const revision of [-1, 1.5, NaN]) {
    assert.throws(() => state("raw", { revision }), /revision/);
  }
  for (const updated_at of [-1, 1.5, Infinity, "1780000000000"]) {
    assert.throws(() => state("raw", { updated_at }), /updated_at/);
  }
  assert.throws(() => createProcessingState({ schema_version: 2, state: "raw", updated_at: T0 }), /schema_version/);
});

test("enforces attempt_id by state and rejects blank attempts", () => {
  assert.equal(state("raw").attempt_id, null);
  assert.equal(state("candidate").attempt_id, null);
  for (const name of ["synthesizing", "consolidated", "failed"]) {
    assert.equal(state(name).attempt_id, "attempt-001");
    for (const attempt_id of [null, "", "   "]) {
      assert.throws(() => state(name, { attempt_id }), /attempt_id/);
    }
  }
  assert.throws(() => state("raw", { attempt_id: "attempt" }), /must be null/);
});

test("requires a detached structured error only in failed", () => {
  const sourceError = { code: "SYNTHESIS_FAILED", message: "Synthetic failure", retryable: false };
  const failed = state("failed", { error: sourceError });
  assert.deepEqual(failed.error, sourceError);
  assert.notStrictEqual(failed.error, sourceError);
  assert.equal(Object.isFrozen(failed.error), true);
  assert.throws(() => state("failed", { error: null }), /failed error/);
  for (const error of [
    { code: "", message: "message", retryable: true },
    { code: "lowercase", message: "message", retryable: true },
    { code: "CODE", message: "", retryable: true },
    { code: "CODE", message: "message", retryable: "yes" },
    { code: "CODE", message: "message", retryable: true, stack: "forbidden" }
  ]) assert.throws(() => state("failed", { error }), /failed error|forbidden/);
  for (const name of ["raw", "candidate", "synthesizing", "consolidated"]) {
    assert.throws(() => state(name, { error: sourceError }), /error must be null/);
  }
});

test("allows exactly the seven V1 transitions", () => {
  const allowed = [
    ["raw", "candidate"],
    ["candidate", "raw"],
    ["candidate", "synthesizing"],
    ["synthesizing", "consolidated"],
    ["synthesizing", "failed"],
    ["failed", "candidate"],
    ["failed", "raw"]
  ];
  for (const [from, to] of allowed) {
    assert.equal(canTransitionProcessingState(from, to), true, `${from} -> ${to}`);
    assert.equal(transition(state(from), to).toState, to);
  }
});

test("rejects every other pair, self transitions and unknown states", () => {
  const states = Object.values(PROCESSING_STATES);
  const allowed = new Set([
    "raw: candidate", "candidate: raw", "candidate: synthesizing",
    "synthesizing: consolidated", "synthesizing: failed",
    "failed: candidate", "failed: raw"
  ]);
  for (const from of states) {
    for (const to of states) {
      assert.equal(canTransitionProcessingState(from, to), allowed.has(`${from}: ${to}`));
    }
  }
  for (const invalid of ["RAW", "unknown", null, undefined]) {
    assert.throws(() => canTransitionProcessingState(invalid, "raw"), ProcessingStateError);
    assert.throws(() => canTransitionProcessingState("raw", invalid), ProcessingStateError);
  }
  for (const to of states) assert.equal(canTransitionProcessingState("consolidated", to), false);
});

test("release, retry and reset clear attempt and error", () => {
  const released = transition(state("candidate"), "raw");
  assert.equal(released.nextProcessing.attempt_id, null);
  assert.equal(released.nextProcessing.error, null);
  for (const toState of ["candidate", "raw"]) {
    const plan = transition(state("failed"), toState);
    assert.equal(plan.nextProcessing.attempt_id, null);
    assert.equal(plan.nextProcessing.error, null);
  }
});

test("starting synthesis requires a new non-empty attempt", () => {
  const current = state("candidate");
  assert.throws(() => transition(current, "synthesizing", { attemptId: undefined }), /attemptId/);
  assert.throws(() => transition(current, "synthesizing", { attemptId: "  " }), /attemptId/);
  const plan = transition(current, "synthesizing", { attemptId: "attempt-002" });
  assert.equal(plan.nextProcessing.attempt_id, "attempt-002");
});

test("success and failure preserve the active attempt", () => {
  const current = state("synthesizing", { attempt_id: "attempt-preserved" });
  const success = transition(current, "consolidated");
  const failure = transition(current, "failed");
  assert.equal(success.nextProcessing.attempt_id, "attempt-preserved");
  assert.equal(failure.nextProcessing.attempt_id, "attempt-preserved");
  assert.equal(failure.nextProcessing.error.code, "SYNTHESIS_FAILED");
  assert.throws(() => transition(current, "consolidated", { attemptId: "changed" }), /cannot change/);
  assert.throws(() => transition(current, "failed", { attemptId: "changed" }), /cannot change/);
  assert.throws(() => transition(current, "failed", { error: undefined }), /requires error/);
});

test("plans expose optimistic concurrency expectations and consecutive revision", () => {
  const current = state("raw", { revision: 9, updated_at: T0 });
  const plan = transition(current, "candidate", { updatedAt: T0 });
  assert.equal(plan.fromState, "raw");
  assert.equal(plan.expectedRevision, 9);
  assert.equal(plan.nextRevision, 10);
  assert.equal(plan.expectedUpdatedAt, T0);
  assert.equal(plan.expectedAttemptId, null);
  assert.equal(plan.nextProcessing.revision, 10);
  assert.equal(plan.nextProcessing.updated_at, T0);
  assert.throws(() => transition(current, "candidate", { updatedAt: T0 - 1 }), /non-decreasing/);
});

test("transition plans are deterministic, detached and deeply immutable", () => {
  const current = state("candidate");
  const input = {
    memoryId: "synthetic-memory",
    current,
    toState: "synthesizing",
    updatedAt: T0 + 1,
    attemptId: "attempt-deterministic",
    reason: "START_SYNTHESIS"
  };
  const before = mutable(input);
  const first = createProcessingTransitionPlan(input);
  const second = createProcessingTransitionPlan(input);
  assert.deepStrictEqual(first, second);
  assert.match(first.transitionId, /^[a-f0-9]{64}$/);
  assert.deepEqual(input, before);
  assert.notStrictEqual(first.nextProcessing, current);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.nextProcessing), true);
  assert.throws(() => { first.nextRevision = 99; }, TypeError);
});

test("validates a valid plan and rejects revision, timestamp and id tampering", () => {
  const plan = transition(state("candidate"), "synthesizing");
  assert.deepEqual(validateProcessingTransitionPlan(plan), { valid: true, errors: [] });
  for (const mutate of [
    (copy) => { copy.nextRevision += 1; },
    (copy) => { copy.nextProcessing.updated_at = copy.expectedUpdatedAt - 1; },
    (copy) => { copy.transitionId = "0".repeat(64); },
    (copy) => { copy.fromState = "raw"; },
    (copy) => { copy.commit = true; }
  ]) {
    const copy = mutable(plan);
    mutate(copy);
    assert.equal(validateProcessingTransitionPlan(copy).valid, false);
  }
});

test("rejects attempt and failed-error tampering", () => {
  const success = mutable(transition(state("synthesizing"), "consolidated"));
  success.nextProcessing.attempt_id = "changed";
  assert.equal(validateProcessingTransitionPlan(success).valid, false);
  const failure = mutable(transition(state("synthesizing"), "failed"));
  failure.nextProcessing.error = null;
  assert.equal(validateProcessingTransitionPlan(failure).valid, false);
  const retry = mutable(transition(state("failed"), "candidate"));
  retry.nextProcessing.attempt_id = "not-cleared";
  assert.equal(validateProcessingTransitionPlan(retry).valid, false);
});

test("rejects functions, cycles and privacy/write fields in plans", () => {
  const plan = mutable(transition(state("raw"), "candidate"));
  plan.callback = () => undefined;
  assert.equal(validateProcessingTransitionPlan(plan).valid, false);
  delete plan.callback;
  plan.loop = plan;
  assert.equal(validateProcessingTransitionPlan(plan).valid, false);
  delete plan.loop;
  plan.payload = { sourceSnapshot: { content: "PRIVATE_SYNTHETIC_TEXT" } };
  assert.equal(validateProcessingTransitionPlan(plan).valid, false);
});

test("module has no time, randomness, filesystem, storage or runtime integration", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "..", "core", "consolidation", "ProcessingState.js"),
    "utf8"
  );
  assert.doesNotMatch(source, /Date\.now|new Date|Math\.random|randomUUID/);
  assert.doesNotMatch(source, /require\(["'](?:node:)?fs["']\)|JsonMemoryStorage|StorageCapabilityContract|Keblomemory|Qwen|Ollama|ClusterEngine/);
});
