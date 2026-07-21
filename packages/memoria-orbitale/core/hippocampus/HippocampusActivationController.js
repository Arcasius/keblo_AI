"use strict";

const {
  HIPPOCAMPUS_ACTIVATION_MODES,
  createHippocampusActivationGate
} = require("./HippocampusActivationGate");
const {
  validateHippocampusActivationPreflight
} = require("./HippocampusActivationPreflight");

const HIPPOCAMPUS_CONTROL_LIFECYCLE_STATES = deepFreeze({
  IDLE: "IDLE",
  PREFLIGHT: "PREFLIGHT",
  RUNNING: "RUNNING",
  STOPPING: "STOPPING",
  SUCCEEDED: "SUCCEEDED",
  FAILED: "FAILED",
  ABORTED: "ABORTED"
});

const HIPPOCAMPUS_CONTROL_REASON_CODES = deepFreeze({
  ACTIVATION_OFF: "ACTIVATION_OFF",
  MODE_UPDATED: "MODE_UPDATED",
  MODE_CHANGE_REJECTED_RUN_ACTIVE: "MODE_CHANGE_REJECTED_RUN_ACTIVE",
  PREFLIGHT_NOT_READY: "PREFLIGHT_NOT_READY",
  RUNNER_UNAVAILABLE: "RUNNER_UNAVAILABLE",
  RUN_ALREADY_ACTIVE: "RUN_ALREADY_ACTIVE",
  RUN_STARTED: "RUN_STARTED",
  RUN_SUCCEEDED: "RUN_SUCCEEDED",
  RUN_FAILED: "RUN_FAILED",
  STOP_REQUESTED: "STOP_REQUESTED",
  NO_ACTIVE_RUN: "NO_ACTIVE_RUN",
  RUN_ABORTED: "RUN_ABORTED",
  INVALID_REQUEST: "INVALID_REQUEST",
  LIVE_NOT_AUTHORIZED: "LIVE_NOT_AUTHORIZED"
});

const CONTROLLER_OPTION_KEYS = Object.freeze([
  "commitCapability",
  "createAbortController",
  "createGate",
  "evaluatePreflight",
  "now",
  "runner",
  "storageCapability"
]);
const MODE_REQUEST_KEYS = Object.freeze(["liveConfirmation", "mode"]);
const EMPTY_REQUEST_KEYS = Object.freeze([]);
const ACTIVE_STATES = new Set([
  HIPPOCAMPUS_CONTROL_LIFECYCLE_STATES.PREFLIGHT,
  HIPPOCAMPUS_CONTROL_LIFECYCLE_STATES.RUNNING,
  HIPPOCAMPUS_CONTROL_LIFECYCLE_STATES.STOPPING
]);
const RESULT_COUNT_KEYS = Object.freeze([
  "clusterCount",
  "deferredComponentCount",
  "simulatedSuperMemoryCount"
]);

class HippocampusActivationControllerError extends Error {
  constructor(code) {
    super("Hippocampus activation controller request failed");
    this.name = "HippocampusActivationControllerError";
    this.code = code;
    this.phase = "activation_control";
    this.retryable = false;
  }
}

function fail(code = HIPPOCAMPUS_CONTROL_REASON_CODES.INVALID_REQUEST) {
  throw new HippocampusActivationControllerError(code);
}

function deepFreeze(value) {
  Object.freeze(value);
  for (const child of Object.values(value)) {
    if (child && typeof child === "object" && !Object.isFrozen(child)) {
      deepFreeze(child);
    }
  }
  return value;
}

function isPlainDataObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.keys(value).every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, "value");
  });
}

function hasOnlyKeys(value, allowed) {
  return isPlainDataObject(value) &&
    Object.keys(value).every((key) => allowed.includes(key));
}

function assertOptions(options) {
  if (!hasOnlyKeys(options, CONTROLLER_OPTION_KEYS) ||
      (options.createGate !== undefined &&
        typeof options.createGate !== "function") ||
      typeof options.evaluatePreflight !== "function" ||
      (options.runner !== undefined && typeof options.runner !== "function") ||
      (options.now !== undefined && typeof options.now !== "function") ||
      (options.createAbortController !== undefined &&
        typeof options.createAbortController !== "function")) {
    fail();
  }
}

function assertEmptyRequest(request) {
  if (!hasOnlyKeys(request, EMPTY_REQUEST_KEYS)) fail();
}

function immutableStatus(state) {
  return deepFreeze({
    mode: state.gate.mode,
    lifecycleState: state.lifecycleState,
    runId: state.runId,
    runStartedAt: state.runStartedAt,
    runFinishedAt: state.runFinishedAt,
    stopRequested: state.stopRequested,
    lastResult: state.lastResult === null
      ? null
      : { ...state.lastResult }
  });
}

function operation(accepted, reasonCode, state) {
  return deepFreeze({
    accepted,
    reasonCode,
    status: immutableStatus(state)
  });
}

function sanitizedRunResult(reasonCode, rawResult) {
  const status = reasonCode === HIPPOCAMPUS_CONTROL_REASON_CODES.RUN_SUCCEEDED
    ? HIPPOCAMPUS_CONTROL_LIFECYCLE_STATES.SUCCEEDED
    : reasonCode === HIPPOCAMPUS_CONTROL_REASON_CODES.RUN_ABORTED
      ? HIPPOCAMPUS_CONTROL_LIFECYCLE_STATES.ABORTED
      : HIPPOCAMPUS_CONTROL_LIFECYCLE_STATES.FAILED;
  const result = { status, reasonCode };
  if (reasonCode === HIPPOCAMPUS_CONTROL_REASON_CODES.RUN_SUCCEEDED &&
      isPlainDataObject(rawResult)) {
    for (const key of RESULT_COUNT_KEYS) {
      if (Number.isSafeInteger(rawResult[key]) && rawResult[key] >= 0) {
        result[key] = rawResult[key];
      }
    }
  }
  return deepFreeze(result);
}

function createHippocampusActivationController(options) {
  assertOptions(options);
  const createGate = options.createGate || createHippocampusActivationGate;
  const evaluatePreflight = options.evaluatePreflight;
  const runner = options.runner;
  const now = options.now || Date.now;
  const createAbortController =
    options.createAbortController || (() => new AbortController());
  const serverCapabilities = {
    commitCapability: options.commitCapability,
    storageCapability: options.storageCapability
  };
  let selectedRequest = deepFreeze({ mode: HIPPOCAMPUS_ACTIVATION_MODES.OFF });
  let runSequence = 0;
  let activeRun = null;
  const state = {
    gate: createGate(),
    lifecycleState: HIPPOCAMPUS_CONTROL_LIFECYCLE_STATES.IDLE,
    runId: null,
    runStartedAt: null,
    runFinishedAt: null,
    stopRequested: false,
    lastResult: null
  };

  function timestamp() {
    const value = now();
    if (!Number.isFinite(value)) fail();
    return new Date(value).toISOString();
  }

  function isRunActive() {
    return ACTIVE_STATES.has(state.lifecycleState);
  }

  function gateFor(request) {
    const gateOptions = {
      mode: request.mode,
      ...serverCapabilities
    };
    if (request.liveConfirmation !== undefined) {
      gateOptions.liveConfirmation = request.liveConfirmation;
    }
    return createGate(gateOptions);
  }

  function getStatus() {
    return immutableStatus(state);
  }

  function setMode(request) {
    if (!hasOnlyKeys(request, MODE_REQUEST_KEYS) ||
        !Object.hasOwn(request, "mode") ||
        !Object.values(HIPPOCAMPUS_ACTIVATION_MODES).includes(request.mode) ||
        (request.liveConfirmation !== undefined &&
          typeof request.liveConfirmation !== "string")) {
      fail();
    }
    if (isRunActive()) {
      return operation(
        false,
        HIPPOCAMPUS_CONTROL_REASON_CODES.MODE_CHANGE_REJECTED_RUN_ACTIVE,
        state
      );
    }
    let proposedGate;
    try {
      proposedGate = gateFor(request);
    } catch {
      fail();
    }
    if (request.mode === HIPPOCAMPUS_ACTIVATION_MODES.LIVE &&
        proposedGate.liveAuthorized !== true) {
      return operation(
        false,
        HIPPOCAMPUS_CONTROL_REASON_CODES.LIVE_NOT_AUTHORIZED,
        state
      );
    }
    selectedRequest = deepFreeze({ ...request });
    state.gate = proposedGate;
    return operation(
      true,
      HIPPOCAMPUS_CONTROL_REASON_CODES.MODE_UPDATED,
      state
    );
  }

  function finishRun(lifecycleState, reasonCode, rawResult) {
    state.lifecycleState = lifecycleState;
    state.runFinishedAt = timestamp();
    state.lastResult = sanitizedRunResult(reasonCode, rawResult);
  }

  async function executeRun(runContext) {
    let rawResult = null;
    try {
      const preflightSnapshot = await evaluatePreflight({
        gateSnapshot: runContext.gateSnapshot,
        signal: runContext.abortController.signal
      });
      if (runContext.abortController.signal.aborted) {
        finishRun(
          HIPPOCAMPUS_CONTROL_LIFECYCLE_STATES.ABORTED,
          HIPPOCAMPUS_CONTROL_REASON_CODES.RUN_ABORTED
        );
        return operation(
          true,
          HIPPOCAMPUS_CONTROL_REASON_CODES.RUN_ABORTED,
          state
        );
      }
      const validation =
        validateHippocampusActivationPreflight(preflightSnapshot);
      const ready = runContext.gateSnapshot.mode ===
        HIPPOCAMPUS_ACTIVATION_MODES.LIVE
        ? preflightSnapshot && preflightSnapshot.liveReady === true
        : preflightSnapshot && preflightSnapshot.shadowReady === true;
      if (!validation.valid || !ready) {
        finishRun(
          HIPPOCAMPUS_CONTROL_LIFECYCLE_STATES.FAILED,
          HIPPOCAMPUS_CONTROL_REASON_CODES.PREFLIGHT_NOT_READY
        );
        return operation(
          true,
          HIPPOCAMPUS_CONTROL_REASON_CODES.PREFLIGHT_NOT_READY,
          state
        );
      }
      state.lifecycleState = HIPPOCAMPUS_CONTROL_LIFECYCLE_STATES.RUNNING;
      state.lastResult = deepFreeze({
        status: HIPPOCAMPUS_CONTROL_LIFECYCLE_STATES.RUNNING,
        reasonCode: HIPPOCAMPUS_CONTROL_REASON_CODES.RUN_STARTED
      });
      rawResult = await runner({
        gateSnapshot: runContext.gateSnapshot,
        preflightSnapshot,
        signal: runContext.abortController.signal
      });
      if (runContext.abortController.signal.aborted) {
        finishRun(
          HIPPOCAMPUS_CONTROL_LIFECYCLE_STATES.ABORTED,
          HIPPOCAMPUS_CONTROL_REASON_CODES.RUN_ABORTED
        );
        return operation(
          true,
          HIPPOCAMPUS_CONTROL_REASON_CODES.RUN_ABORTED,
          state
        );
      }
      finishRun(
        HIPPOCAMPUS_CONTROL_LIFECYCLE_STATES.SUCCEEDED,
        HIPPOCAMPUS_CONTROL_REASON_CODES.RUN_SUCCEEDED,
        rawResult
      );
      return operation(
        true,
        HIPPOCAMPUS_CONTROL_REASON_CODES.RUN_SUCCEEDED,
        state
      );
    } catch {
      const aborted = runContext.abortController.signal.aborted;
      finishRun(
        aborted
          ? HIPPOCAMPUS_CONTROL_LIFECYCLE_STATES.ABORTED
          : HIPPOCAMPUS_CONTROL_LIFECYCLE_STATES.FAILED,
        aborted
          ? HIPPOCAMPUS_CONTROL_REASON_CODES.RUN_ABORTED
          : HIPPOCAMPUS_CONTROL_REASON_CODES.RUN_FAILED
      );
      return operation(
        true,
        aborted
          ? HIPPOCAMPUS_CONTROL_REASON_CODES.RUN_ABORTED
          : HIPPOCAMPUS_CONTROL_REASON_CODES.RUN_FAILED,
        state
      );
    } finally {
      rawResult = null;
      if (activeRun === runContext) activeRun = null;
    }
  }

  function runOnce(request = {}) {
    assertEmptyRequest(request);
    if (state.gate.mode === HIPPOCAMPUS_ACTIVATION_MODES.OFF) {
      return Promise.resolve(operation(
        false,
        HIPPOCAMPUS_CONTROL_REASON_CODES.ACTIVATION_OFF,
        state
      ));
    }
    if (isRunActive()) {
      return Promise.resolve(operation(
        false,
        HIPPOCAMPUS_CONTROL_REASON_CODES.RUN_ALREADY_ACTIVE,
        state
      ));
    }
    let gateSnapshot;
    try {
      gateSnapshot = gateFor(selectedRequest);
    } catch {
      return Promise.resolve(operation(
        false,
        HIPPOCAMPUS_CONTROL_REASON_CODES.LIVE_NOT_AUTHORIZED,
        state
      ));
    }
    if (!gateSnapshot.activationAuthorized ||
        (gateSnapshot.mode === HIPPOCAMPUS_ACTIVATION_MODES.LIVE &&
          !gateSnapshot.liveAuthorized)) {
      return Promise.resolve(operation(
        false,
        gateSnapshot.mode === HIPPOCAMPUS_ACTIVATION_MODES.LIVE
          ? HIPPOCAMPUS_CONTROL_REASON_CODES.LIVE_NOT_AUTHORIZED
          : HIPPOCAMPUS_CONTROL_REASON_CODES.ACTIVATION_OFF,
        state
      ));
    }
    runSequence += 1;
    state.runId = `hact2-run-${runSequence}`;
    state.runStartedAt = timestamp();
    state.runFinishedAt = null;
    state.stopRequested = false;
    if (typeof runner !== "function") {
      finishRun(
        HIPPOCAMPUS_CONTROL_LIFECYCLE_STATES.FAILED,
        HIPPOCAMPUS_CONTROL_REASON_CODES.RUNNER_UNAVAILABLE
      );
      return Promise.resolve(operation(
        false,
        HIPPOCAMPUS_CONTROL_REASON_CODES.RUNNER_UNAVAILABLE,
        state
      ));
    }
    let abortController;
    try {
      abortController = createAbortController();
    } catch {
      finishRun(
        HIPPOCAMPUS_CONTROL_LIFECYCLE_STATES.FAILED,
        HIPPOCAMPUS_CONTROL_REASON_CODES.RUN_FAILED
      );
      return Promise.resolve(operation(
        false,
        HIPPOCAMPUS_CONTROL_REASON_CODES.RUN_FAILED,
        state
      ));
    }
    if (!abortController || typeof abortController.abort !== "function" ||
        !abortController.signal ||
        typeof abortController.signal.aborted !== "boolean") {
      finishRun(
        HIPPOCAMPUS_CONTROL_LIFECYCLE_STATES.FAILED,
        HIPPOCAMPUS_CONTROL_REASON_CODES.RUN_FAILED
      );
      return Promise.resolve(operation(
        false,
        HIPPOCAMPUS_CONTROL_REASON_CODES.RUN_FAILED,
        state
      ));
    }
    state.lifecycleState = HIPPOCAMPUS_CONTROL_LIFECYCLE_STATES.PREFLIGHT;
    state.lastResult = deepFreeze({
      status: HIPPOCAMPUS_CONTROL_LIFECYCLE_STATES.PREFLIGHT,
      reasonCode: HIPPOCAMPUS_CONTROL_REASON_CODES.RUN_STARTED
    });
    const runContext = {
      abortController,
      gateSnapshot,
      promise: null
    };
    activeRun = runContext;
    runContext.promise = executeRun(runContext);
    return runContext.promise;
  }

  async function stop(request = {}) {
    assertEmptyRequest(request);
    if (!activeRun || !isRunActive()) {
      return operation(
        false,
        HIPPOCAMPUS_CONTROL_REASON_CODES.NO_ACTIVE_RUN,
        state
      );
    }
    const runContext = activeRun;
    if (!state.stopRequested) {
      state.stopRequested = true;
      state.lifecycleState = HIPPOCAMPUS_CONTROL_LIFECYCLE_STATES.STOPPING;
      runContext.abortController.abort();
    }
    await runContext.promise;
    return operation(
      true,
      HIPPOCAMPUS_CONTROL_REASON_CODES.STOP_REQUESTED,
      state
    );
  }

  return deepFreeze({
    getStatus,
    setMode,
    runOnce,
    stop
  });
}

module.exports = {
  HIPPOCAMPUS_CONTROL_LIFECYCLE_STATES,
  HIPPOCAMPUS_CONTROL_REASON_CODES,
  HippocampusActivationControllerError,
  createHippocampusActivationController
};
