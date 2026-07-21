#!/usr/bin/env node
"use strict";

const {
  MAX_CANDIDATES,
  EXIT_CODES,
  createDefaultRuntime
} = require("./hippocampus-run");
const {
  SHADOW_CONFIRMATION,
  RUNTIME_OPERATIONS
} = require("../core/hippocampus/HippocampusRuntimeComposition");

const DAEMON_SCHEMA_VERSION = 1;
const DAEMON_OPERATIONS = Object.freeze({
  STATUS: "STATUS",
  RUN_ONCE: "RUN_ONCE",
  INTERVAL: "INTERVAL"
});
const FLAGS = new Set([
  "--confirm", "--interval-ms", "--max-candidates", "--mode",
  "--run-once", "--status", "--user-id"
]);

class HippocampusBackgroundDaemonError extends Error {
  constructor(code, exitCode = EXIT_CODES.INVALID_ARGUMENTS) {
    super("Hippocampus background daemon operation failed");
    this.name = "HippocampusBackgroundDaemonError";
    this.code = code;
    this.phase = "background_daemon";
    this.retryable = false;
    this.exitCode = exitCode;
  }
}

function fail(code, exitCode) {
  throw new HippocampusBackgroundDaemonError(code, exitCode);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze(value) {
  Object.freeze(value);
  for (const child of Object.values(value)) {
    if (child && typeof child === "object" && !Object.isFrozen(child)) deepFreeze(child);
  }
  return value;
}

function nextValue(args, index) {
  const value = args[index + 1];
  if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
    fail("INVALID_DAEMON_ARGUMENTS");
  }
  return value;
}

function positiveInteger(value) {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function offConfiguration() {
  return deepFreeze({
    mode: "OFF",
    operation: DAEMON_OPERATIONS.STATUS,
    confirmation: null,
    userId: null,
    maxCandidates: null,
    intervalMs: null
  });
}

function parseDaemonArguments(args) {
  if (!Array.isArray(args) || args.some((item) => typeof item !== "string")) {
    fail("INVALID_DAEMON_ARGUMENTS");
  }
  if (args.length === 0) return offConfiguration();
  const values = {
    mode: null,
    operation: null,
    confirmation: null,
    userId: null,
    maxCandidates: null,
    intervalMs: null
  };
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!FLAGS.has(flag) || seen.has(flag)) fail("INVALID_DAEMON_ARGUMENTS");
    seen.add(flag);
    if (flag === "--status") {
      if (values.operation !== null) fail("INVALID_DAEMON_ARGUMENTS");
      values.operation = DAEMON_OPERATIONS.STATUS;
      continue;
    }
    if (flag === "--run-once") {
      if (values.operation !== null) fail("INVALID_DAEMON_ARGUMENTS");
      values.operation = DAEMON_OPERATIONS.RUN_ONCE;
      continue;
    }
    const value = nextValue(args, index);
    index += 1;
    if (flag === "--mode") values.mode = value;
    if (flag === "--confirm") values.confirmation = value;
    if (flag === "--user-id") values.userId = value;
    if (flag === "--max-candidates") values.maxCandidates = positiveInteger(value);
    if (flag === "--interval-ms") {
      if (values.operation !== null) fail("INVALID_DAEMON_ARGUMENTS");
      values.operation = DAEMON_OPERATIONS.INTERVAL;
      values.intervalMs = positiveInteger(value);
    }
  }
  if (values.mode === "LIVE") {
    fail("LIVE_RUNTIME_NOT_AUTHORIZED", EXIT_CODES.LIVE_NOT_AUTHORIZED);
  }
  if (values.operation === DAEMON_OPERATIONS.STATUS) {
    if (values.mode !== null && values.mode !== "OFF" ||
        values.confirmation !== null || values.userId !== null ||
        values.maxCandidates !== null || values.intervalMs !== null) {
      fail("INVALID_DAEMON_ARGUMENTS");
    }
    return offConfiguration();
  }
  if (values.mode === "OFF" && values.operation === null &&
      values.confirmation === null && values.userId === null &&
      values.maxCandidates === null && values.intervalMs === null) {
    return offConfiguration();
  }
  if (values.mode !== "SHADOW" ||
      ![DAEMON_OPERATIONS.RUN_ONCE, DAEMON_OPERATIONS.INTERVAL]
        .includes(values.operation) ||
      values.confirmation !== SHADOW_CONFIRMATION ||
      typeof values.userId !== "string" ||
      !/^[A-Za-z0-9._-]{1,128}$/.test(values.userId) ||
      !Number.isSafeInteger(values.maxCandidates) ||
      values.maxCandidates <= 0 || values.maxCandidates > MAX_CANDIDATES ||
      values.operation === DAEMON_OPERATIONS.INTERVAL &&
        (!Number.isSafeInteger(values.intervalMs) || values.intervalMs <= 0) ||
      values.operation === DAEMON_OPERATIONS.RUN_ONCE && values.intervalMs !== null) {
    fail(values.mode === "SHADOW" && values.confirmation !== SHADOW_CONFIRMATION
      ? "SHADOW_CONFIRMATION_REQUIRED"
      : "INVALID_DAEMON_ARGUMENTS");
  }
  return deepFreeze(values);
}

function zeroMetrics() {
  return {
    authoritativeMemoryReads: 0,
    authoritativeMemoryWrites: 0,
    processingStateWrites: 0,
    commitCalls: 0,
    clusterCount: 0,
    simulatedSuperMemoryCount: 0
  };
}

function daemonSnapshot(state) {
  return deepFreeze({
    schemaVersion: DAEMON_SCHEMA_VERSION,
    status: state.status,
    mode: state.mode,
    reasonCode: state.reasonCode,
    active: state.active,
    scheduled: state.scheduled,
    stopRequested: state.stopRequested,
    cycleCount: state.cycleCount,
    successfulCycleCount: state.successfulCycleCount,
    failedCycleCount: state.failedCycleCount,
    ...state.metrics
  });
}

function sanitizeCycleReport(report) {
  if (!isPlainObject(report)) fail("INVALID_SHADOW_REPORT", EXIT_CODES.RUN_FAILED);
  const integer = (key) => Number.isSafeInteger(report[key]) && report[key] >= 0
    ? report[key]
    : 0;
  if (report.mode !== "SHADOW" || report.authoritativeMemoryWrites !== 0 ||
      report.processingStateWrites !== 0 || report.commitCalls !== 0 ||
      report.realDataModified !== false) {
    fail("SHADOW_WRITE_BOUNDARY_VIOLATION", EXIT_CODES.RUN_FAILED);
  }
  const succeeded = ["SHADOW_SUCCEEDED", "SHADOW_NO_ELIGIBLE_CANDIDATES"]
    .includes(report.status);
  return {
    succeeded,
    status: succeeded ? "SHADOW_CYCLE_SUCCEEDED" : "SHADOW_CYCLE_FAILED",
    reasonCode: succeeded ? "SHADOW_CYCLE_SUCCEEDED" :
      typeof report.reasonCode === "string" && /^[A-Z][A-Z0-9_]*$/.test(report.reasonCode)
        ? report.reasonCode
        : "SHADOW_CYCLE_FAILED",
    metrics: {
      authoritativeMemoryReads: integer("authoritativeMemoryReads"),
      authoritativeMemoryWrites: 0,
      processingStateWrites: 0,
      commitCalls: 0,
      clusterCount: integer("clusterCount"),
      simulatedSuperMemoryCount: integer("simulatedSuperMemoryCount")
    }
  };
}

function sanitizedFailure(error, mode = "OFF") {
  const reasonCode = typeof error?.code === "string" &&
    /^[A-Z][A-Z0-9_]*$/.test(error.code)
    ? error.code
    : "BACKGROUND_DAEMON_FAILURE";
  return daemonSnapshot({
    status: reasonCode === "LIVE_RUNTIME_NOT_AUTHORIZED"
      ? "LIVE_RUNTIME_NOT_AUTHORIZED"
      : "FAILED",
    mode: reasonCode === "LIVE_RUNTIME_NOT_AUTHORIZED" ? "LIVE" : mode,
    reasonCode,
    active: false,
    scheduled: false,
    stopRequested: false,
    cycleCount: 0,
    successfulCycleCount: 0,
    failedCycleCount: 0,
    metrics: zeroMetrics()
  });
}

function createHippocampusBackgroundSupervisor(options) {
  if (!isPlainObject(options) || !isPlainObject(options.configuration) ||
      typeof options.runtimeFactory !== "function" ||
      !isPlainObject(options.scheduler) ||
      typeof options.scheduler.setTimeout !== "function" ||
      typeof options.scheduler.clearTimeout !== "function" ||
      options.onReport !== undefined && typeof options.onReport !== "function") {
    fail("INVALID_DAEMON_CONFIGURATION");
  }
  const configuration = options.configuration;
  if (!Object.values(DAEMON_OPERATIONS).includes(configuration.operation) ||
      !["OFF", "SHADOW"].includes(configuration.mode)) {
    fail("INVALID_DAEMON_CONFIGURATION");
  }
  let runtime = null;
  let timer = null;
  let activePromise = null;
  let stoppedResolve;
  const stopped = new Promise((resolve) => { stoppedResolve = resolve; });
  const state = {
    status: configuration.mode === "OFF" ? "OFF" : "SHADOW_IDLE",
    mode: configuration.mode,
    reasonCode: configuration.mode === "OFF" ? "DEFAULT_OFF" : "SHADOW_READY",
    active: false,
    scheduled: false,
    stopRequested: false,
    cycleCount: 0,
    successfulCycleCount: 0,
    failedCycleCount: 0,
    metrics: zeroMetrics()
  };

  function report() {
    const snapshot = daemonSnapshot(state);
    options.onReport?.(snapshot);
    return snapshot;
  }

  function ensureRuntime() {
    if (runtime !== null) return runtime;
    runtime = options.runtimeFactory({
      configuration: {
        mode: "SHADOW",
        operation: RUNTIME_OPERATIONS.RUN_ONCE,
        confirmation: configuration.confirmation,
        userId: configuration.userId,
        maxCandidates: configuration.maxCandidates
      },
      env: options.env || {},
      injections: options.injections || {}
    });
    if (!runtime || typeof runtime.runOnce !== "function" ||
        typeof runtime.stop !== "function") {
      fail("INVALID_RUNTIME_CONFIGURATION");
    }
    return runtime;
  }

  function scheduleNext() {
    if (configuration.operation !== DAEMON_OPERATIONS.INTERVAL ||
        state.stopRequested) return;
    state.scheduled = true;
    timer = options.scheduler.setTimeout(() => {
      timer = null;
      state.scheduled = false;
      void runCycle().finally(scheduleNext);
    }, configuration.intervalMs);
  }

  async function runCycle() {
    if (configuration.mode !== "SHADOW") return report();
    if (state.stopRequested) return report();
    if (activePromise !== null) {
      state.status = "SHADOW_CYCLE_SKIPPED";
      state.reasonCode = "RUN_ALREADY_ACTIVE";
      return report();
    }
    state.active = true;
    state.status = "SHADOW_RUNNING";
    state.reasonCode = "SHADOW_CYCLE_STARTED";
    const cycle = (async () => {
      try {
        const normalized = sanitizeCycleReport(await ensureRuntime().runOnce());
        state.cycleCount += 1;
        state.metrics = normalized.metrics;
        state.status = normalized.status;
        state.reasonCode = normalized.reasonCode;
        if (normalized.succeeded) state.successfulCycleCount += 1;
        else state.failedCycleCount += 1;
      } catch (error) {
        state.cycleCount += 1;
        state.failedCycleCount += 1;
        state.metrics = zeroMetrics();
        state.status = "SHADOW_CYCLE_FAILED";
        state.reasonCode = typeof error?.code === "string" &&
          /^[A-Z][A-Z0-9_]*$/.test(error.code)
          ? error.code
          : "SHADOW_CYCLE_FAILED";
      } finally {
        state.active = false;
      }
      return report();
    })();
    activePromise = cycle;
    try { return await cycle; } finally { activePromise = null; }
  }

  async function start() {
    if (configuration.mode === "OFF") return report();
    if (state.stopRequested) return report();
    const first = await runCycle();
    if (configuration.operation === DAEMON_OPERATIONS.INTERVAL) scheduleNext();
    return first;
  }

  async function requestStop(reasonCode = "STOP_REQUESTED") {
    if (state.stopRequested) {
      if (activePromise) await activePromise;
      return report();
    }
    state.stopRequested = true;
    state.reasonCode = reasonCode;
    if (timer !== null) {
      options.scheduler.clearTimeout(timer);
      timer = null;
      state.scheduled = false;
    }
    if (runtime !== null) await Promise.resolve(runtime.stop()).catch(() => null);
    if (activePromise) await activePromise;
    state.status = "STOPPED";
    state.reasonCode = reasonCode;
    state.active = false;
    state.scheduled = false;
    stoppedResolve(report());
    return daemonSnapshot(state);
  }

  return Object.freeze({
    start,
    runCycle,
    requestStop,
    getStatus: () => daemonSnapshot(state),
    waitForStop: () => stopped
  });
}

async function executeDaemonCli(options = {}) {
  const args = options.args || [];
  const stdout = options.stdout || process.stdout;
  const signalSource = options.signalSource || process;
  const supervisorFactory = options.supervisorFactory ||
    createHippocampusBackgroundSupervisor;
  let supervisor = null;
  let configuration;
  let signalStop = null;
  let finalReport;
  let exitCode = EXIT_CODES.SUCCESS;
  const onSignal = (signalName) => {
    if (!supervisor || signalStop) return;
    signalStop = supervisor.requestStop(signalName === "SIGINT"
      ? "SIGINT_STOP_REQUESTED"
      : "SIGTERM_STOP_REQUESTED");
  };
  const onSigint = () => onSignal("SIGINT");
  const onSigterm = () => onSignal("SIGTERM");
  try {
    configuration = parseDaemonArguments(args);
    if (configuration.mode === "OFF") {
      finalReport = daemonSnapshot({
        status: "OFF", mode: "OFF", reasonCode: "DEFAULT_OFF",
        active: false, scheduled: false, stopRequested: false,
        cycleCount: 0, successfulCycleCount: 0, failedCycleCount: 0,
        metrics: zeroMetrics()
      });
    } else {
      supervisor = supervisorFactory({
        configuration,
        runtimeFactory: options.runtimeFactory || createDefaultRuntime,
        scheduler: options.scheduler || {
          setTimeout: globalThis.setTimeout,
          clearTimeout: globalThis.clearTimeout
        },
        env: options.env || {},
        injections: options.injections || {},
        onReport: options.onReport
      });
      signalSource.on("SIGINT", onSigint);
      signalSource.on("SIGTERM", onSigterm);
      finalReport = await supervisor.start();
      if (configuration.operation === DAEMON_OPERATIONS.INTERVAL) {
        finalReport = await supervisor.waitForStop();
      }
      if (signalStop) finalReport = await signalStop;
    }
  } catch (error) {
    finalReport = sanitizedFailure(error, configuration?.mode || "OFF");
    exitCode = error?.exitCode || EXIT_CODES.RUN_FAILED;
  } finally {
    signalSource.removeListener?.("SIGINT", onSigint);
    signalSource.removeListener?.("SIGTERM", onSigterm);
  }
  stdout.write(`${JSON.stringify(finalReport)}\n`);
  return exitCode;
}

if (require.main === module) {
  executeDaemonCli({
    args: process.argv.slice(2),
    env: process.env,
    stdout: process.stdout,
    signalSource: process
  }).then((code) => { process.exitCode = code; }).catch(() => {
    process.stdout.write(`${JSON.stringify(sanitizedFailure(null))}\n`);
    process.exitCode = EXIT_CODES.RUN_FAILED;
  });
}

module.exports = {
  DAEMON_SCHEMA_VERSION,
  DAEMON_OPERATIONS,
  HippocampusBackgroundDaemonError,
  parseDaemonArguments,
  createHippocampusBackgroundSupervisor,
  executeDaemonCli
};
