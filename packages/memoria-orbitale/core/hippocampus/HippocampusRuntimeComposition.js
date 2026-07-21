"use strict";

const {
  HIPPOCAMPUS_ACTIVATION_MODES,
  createHippocampusActivationGate
} = require("./HippocampusActivationGate");
const {
  createHippocampusActivationController
} = require("./HippocampusActivationController");
const {
  validateHippocampusActivationPreflight
} = require("./HippocampusActivationPreflight");

const SHADOW_CONFIRMATION = "RUN_HIPPOCAMPUS_SHADOW_V1";
const RUNTIME_OPERATIONS = deepFreeze({
  STATUS: "STATUS",
  PREFLIGHT_ONLY: "PREFLIGHT_ONLY",
  RUN_ONCE: "RUN_ONCE"
});
const RUNTIME_OPTION_KEYS = Object.freeze([
  "configuration",
  "createAbortController",
  "evaluatePreflight",
  "now",
  "runShadow"
]);
const CONFIGURATION_KEYS = Object.freeze([
  "confirmation", "maxCandidates", "mode", "operation", "userId"
]);
const SHADOW_RESULT_KEYS = Object.freeze([
  "authoritativeMemoryReads",
  "authoritativeMemoryWrites",
  "cacheCreatedCount",
  "cacheHitCount",
  "candidateCount",
  "commitCalls",
  "deferredComponentCount",
  "embeddingCacheModified",
  "exclusionCounts",
  "exactCertificateCount",
  "realDataModified",
  "simulatedSuperMemoryCount",
  "clusterCount"
]);
const SHADOW_EXCLUSION_COUNT_KEYS = Object.freeze([
  "duplicateIdentityCount",
  "emptyContentCount",
  "keyIdentityMismatchCount",
  "missingIdentityCount",
  "structuralIncompatibilityCount",
  "userScopeMismatchCount"
]);
const SHADOW_FAILURE_REASON_CODES = Object.freeze([
  "AUTHORITATIVE_STORAGE_READ_FAILED",
  "LEGACY_PROJECTION_FAILED",
  "CACHE_LOOKUP_FAILED",
  "CACHE_POINT_CONFLICT",
  "CACHE_REPLAY_VERIFICATION_FAILED",
  "EXACT_DISCOVERY_FAILED",
  "CLUSTERING_FAILED",
  "TEMPORAL_PROVENANCE_FAILED",
  "QWEN_SYNTHESIS_FAILED",
  "RESULT_VALIDATION_FAILED",
  "RUN_ABORTED",
  "INTERNAL_RUNTIME_ERROR"
]);
const SHADOW_FAILURE_PHASES = Object.freeze([
  "authoritative_read",
  "legacy_projection",
  "cache_lookup",
  "cache_replay_verification",
  "exact_discovery",
  "clustering",
  "temporal_provenance",
  "qwen_synthesis",
  "result_normalization",
  "runtime"
]);
const PREFLIGHT_CHECK_KEYS = Object.freeze([
  "configuration", "storage", "qdrant", "embeddingCache", "bgeM3",
  "qwenMiniInference", "commitCapabilityAbsent"
]);
const PREFLIGHT_CHECK_STATES = Object.freeze(["PASS", "FAIL", "NOT_RUN"]);
const PREFLIGHT_REASON_CODES = Object.freeze([
  "PREFLIGHT_READY",
  "CONFIGURATION_INCOMPLETE",
  "STORAGE_CONFIGURATION_INVALID",
  "QDRANT_UNAVAILABLE",
  "EMBEDDING_CACHE_NOT_READY",
  "BGE_M3_UNAVAILABLE",
  "BGE_M3_PROVENANCE_MISMATCH",
  "QWEN_UNAVAILABLE",
  "QWEN_MINI_INFERENCE_FAILED",
  "PREFLIGHT_ABORTED",
  "PREFLIGHT_INTERNAL_CONFIGURATION_ERROR"
]);

class HippocampusRuntimeCompositionError extends Error {
  constructor(code) {
    super("Hippocampus standalone runtime operation failed");
    this.name = "HippocampusRuntimeCompositionError";
    this.code = code;
    this.phase = "runtime_composition";
    this.retryable = false;
  }
}

function fail(code) {
  throw new HippocampusRuntimeCompositionError(code);
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

function isPlainObject(value) {
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

function hasExactKeys(value, expected) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index]);
}

function isAbortController(value) {
  return value && typeof value.abort === "function" &&
    value.signal && typeof value.signal.aborted === "boolean" &&
    typeof value.signal.addEventListener === "function";
}

function validateOptions(options) {
  if (!isPlainObject(options) ||
      Object.keys(options).some((key) => !RUNTIME_OPTION_KEYS.includes(key)) ||
      !hasExactKeys(options.configuration, CONFIGURATION_KEYS) ||
      typeof options.evaluatePreflight !== "function" ||
      options.runShadow !== undefined && typeof options.runShadow !== "function" ||
      options.now !== undefined && typeof options.now !== "function" ||
      options.createAbortController !== undefined &&
        typeof options.createAbortController !== "function") {
    fail("INVALID_RUNTIME_CONFIGURATION");
  }
  const config = options.configuration;
  if (!Object.values(HIPPOCAMPUS_ACTIVATION_MODES).includes(config.mode) ||
      !Object.values(RUNTIME_OPERATIONS).includes(config.operation)) {
    fail("INVALID_RUNTIME_CONFIGURATION");
  }
  if (config.mode === HIPPOCAMPUS_ACTIVATION_MODES.LIVE) {
    fail("LIVE_RUNTIME_NOT_AUTHORIZED");
  }
  if (config.mode === HIPPOCAMPUS_ACTIVATION_MODES.OFF) {
    if (config.operation !== RUNTIME_OPERATIONS.STATUS ||
        config.confirmation !== null ||
        config.userId !== null ||
        config.maxCandidates !== null) {
      fail("INVALID_RUNTIME_CONFIGURATION");
    }
    return;
  }
  if (config.confirmation !== SHADOW_CONFIRMATION ||
      ![RUNTIME_OPERATIONS.PREFLIGHT_ONLY, RUNTIME_OPERATIONS.RUN_ONCE]
        .includes(config.operation)) {
    fail("SHADOW_CONFIRMATION_REQUIRED");
  }
  if (config.operation === RUNTIME_OPERATIONS.PREFLIGHT_ONLY &&
      (config.userId !== null || config.maxCandidates !== null)) {
    fail("INVALID_RUNTIME_CONFIGURATION");
  }
  if (config.operation === RUNTIME_OPERATIONS.RUN_ONCE &&
      (typeof config.userId !== "string" || config.userId.trim().length === 0 ||
        !Number.isSafeInteger(config.maxCandidates) ||
        config.maxCandidates <= 0)) {
    fail("INVALID_RUNTIME_CONFIGURATION");
  }
}

function emptyReport(status, mode, preflight, durationMs = 0) {
  return deepFreeze({
    status,
    mode,
    preflight,
    candidateCount: 0,
    cacheHitCount: 0,
    cacheCreatedCount: 0,
    exactCertificateCount: 0,
    clusterCount: 0,
    deferredComponentCount: 0,
    simulatedSuperMemoryCount: 0,
    authoritativeMemoryReads: 0,
    authoritativeMemoryWrites: 0,
    processingStateWrites: 0,
    commitCalls: 0,
    realDataModified: false,
    embeddingCacheModified: false,
    exclusionCounts: Object.fromEntries(
      SHADOW_EXCLUSION_COUNT_KEYS.map((key) => [key, 0])
    ),
    durationMs
  });
}

function sanitizedShadowFailure(error, fallbackPhase = "runtime") {
  const value = isPlainObject(error?.shadowFailure)
    ? error.shadowFailure
    : {};
  const numeric = (key) => Number.isSafeInteger(value[key]) && value[key] >= 0
    ? value[key]
    : 0;
  const reasonCode = SHADOW_FAILURE_REASON_CODES.includes(value.reasonCode)
    ? value.reasonCode
    : error?.code === "RUN_ABORTED"
      ? "RUN_ABORTED"
      : error?.code === "SHADOW_WRITE_BOUNDARY_VIOLATION" ||
        error?.code === "INVALID_SHADOW_RESULT"
        ? "RESULT_VALIDATION_FAILED"
        : "INTERNAL_RUNTIME_ERROR";
  const failurePhase = SHADOW_FAILURE_PHASES.includes(value.failurePhase)
    ? value.failurePhase
    : SHADOW_FAILURE_PHASES.includes(fallbackPhase)
      ? fallbackPhase
      : "runtime";
  return {
    reasonCode,
    failurePhase,
    candidateCount: numeric("candidateCount"),
    cacheHitCount: numeric("cacheHitCount"),
    cacheCreatedCount: numeric("cacheCreatedCount"),
    exactCertificateCount: numeric("exactCertificateCount"),
    clusterCount: numeric("clusterCount"),
    deferredComponentCount: numeric("deferredComponentCount"),
    simulatedSuperMemoryCount: numeric("simulatedSuperMemoryCount"),
    authoritativeMemoryReads: numeric("authoritativeMemoryReads"),
    authoritativeMemoryWrites: 0,
    processingStateWrites: 0,
    commitCalls: 0,
    realDataModified: false,
    embeddingCacheModified: value.embeddingCacheModified === true,
    exclusionCounts: Object.fromEntries(SHADOW_EXCLUSION_COUNT_KEYS.map((key) => [
      key,
      isPlainObject(value.exclusionCounts) &&
        Number.isSafeInteger(value.exclusionCounts[key]) &&
        value.exclusionCounts[key] >= 0
        ? value.exclusionCounts[key]
        : 0
    ]))
  };
}

function shadowFailureReport(failure, preflight, durationMs) {
  return deepFreeze({
    status: failure.reasonCode === "RUN_ABORTED"
      ? "SHADOW_ABORTED"
      : "SHADOW_FAILED",
    mode: "SHADOW",
    preflight,
    ...failure,
    durationMs
  });
}

function defaultDiagnostic(preflight) {
  const passed = preflight?.shadowReady === true;
  return {
    reasonCode: passed
      ? "PREFLIGHT_READY"
      : "PREFLIGHT_INTERNAL_CONFIGURATION_ERROR",
    checks: {
      configuration: passed ? "PASS" : "NOT_RUN",
      storage: preflight?.storage?.verifiedReady ? "PASS" : "FAIL",
      qdrant: preflight?.qdrant?.ready ? "PASS" : "FAIL",
      embeddingCache: preflight?.embeddingCache?.ready ? "PASS" : "FAIL",
      bgeM3: preflight?.bgeM3?.verifiedReady ? "PASS" : "FAIL",
      qwenMiniInference: preflight?.qwen?.verifiedReady ? "PASS" : "FAIL",
      commitCapabilityAbsent: preflight?.commit?.present === false
        ? "PASS"
        : "FAIL"
    },
    missingConfigurationKeys: []
  };
}

function sanitizeDiagnostic(value, preflight) {
  if (!isPlainObject(value) ||
      !PREFLIGHT_REASON_CODES.includes(value.reasonCode) ||
      !isPlainObject(value.checks) ||
      !hasExactKeys(value.checks, PREFLIGHT_CHECK_KEYS) ||
      PREFLIGHT_CHECK_KEYS.some((key) =>
        !PREFLIGHT_CHECK_STATES.includes(value.checks[key])) ||
      value.checks.commitCapabilityAbsent === "NOT_RUN" ||
      !Array.isArray(value.missingConfigurationKeys) ||
      value.missingConfigurationKeys.some((key) =>
        typeof key !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(key))) {
    return defaultDiagnostic(preflight);
  }
  return {
    reasonCode: value.reasonCode,
    checks: { ...value.checks },
    missingConfigurationKeys: [...new Set(value.missingConfigurationKeys)].sort()
  };
}

function diagnosticReport(diagnostic, durationMs) {
  const passed = diagnostic.reasonCode === "PREFLIGHT_READY";
  const report = {
    status: passed
      ? "SHADOW_PREFLIGHT_PASSED"
      : diagnostic.reasonCode === "PREFLIGHT_ABORTED"
        ? "SHADOW_ABORTED"
        : "SHADOW_PREFLIGHT_FAILED",
    mode: "SHADOW",
    reasonCode: diagnostic.reasonCode,
    checks: diagnostic.checks,
    authoritativeMemoryReads: 0,
    authoritativeMemoryWrites: 0,
    processingStateWrites: 0,
    embeddingCacheWrites: 0,
    commitCalls: 0,
    durationMs
  };
  if (diagnostic.missingConfigurationKeys.length > 0) {
    report.missingConfigurationKeys = diagnostic.missingConfigurationKeys;
  }
  return deepFreeze(report);
}

function sanitizeShadowResult(value) {
  if (!hasExactKeys(value, SHADOW_RESULT_KEYS)) {
    fail("INVALID_SHADOW_RESULT");
  }
  const numericKeys = SHADOW_RESULT_KEYS.filter((key) =>
    !["embeddingCacheModified", "exclusionCounts", "realDataModified"]
      .includes(key));
  if (numericKeys.some((key) =>
    !Number.isSafeInteger(value[key]) || value[key] < 0
  ) ||
      !hasExactKeys(value.exclusionCounts, SHADOW_EXCLUSION_COUNT_KEYS) ||
      SHADOW_EXCLUSION_COUNT_KEYS.some((key) =>
        !Number.isSafeInteger(value.exclusionCounts[key]) ||
        value.exclusionCounts[key] < 0) ||
      typeof value.embeddingCacheModified !== "boolean" ||
      value.realDataModified !== false ||
      value.authoritativeMemoryWrites !== 0 ||
      value.commitCalls !== 0) {
    fail("SHADOW_WRITE_BOUNDARY_VIOLATION");
  }
  return {
    authoritativeMemoryReads: value.authoritativeMemoryReads,
    candidateCount: value.candidateCount,
    cacheHitCount: value.cacheHitCount,
    cacheCreatedCount: value.cacheCreatedCount,
    exactCertificateCount: value.exactCertificateCount,
    clusterCount: value.clusterCount,
    deferredComponentCount: value.deferredComponentCount,
    simulatedSuperMemoryCount: value.simulatedSuperMemoryCount,
    authoritativeMemoryWrites: 0,
    commitCalls: 0,
    realDataModified: false,
    embeddingCacheModified: value.embeddingCacheModified,
    exclusionCounts: { ...value.exclusionCounts }
  };
}

function createHippocampusRuntime(options) {
  validateOptions(options);
  const config = deepFreeze({ ...options.configuration });
  const now = options.now || Date.now;
  const createAbortController =
    options.createAbortController || (() => new AbortController());
  let activePreflight = null;
  let lastPreflight = null;
  let lastPreflightDiagnostic = null;
  let lastShadowResult = null;
  let lastShadowFailure = null;
  let controllerAbortController = null;

  function clock() {
    const value = now();
    if (!Number.isFinite(value)) fail("INVALID_RUNTIME_CLOCK");
    return value;
  }

  async function evaluate(input) {
    const evaluated = await options.evaluatePreflight({
      configuration: config,
      gateSnapshot: input.gateSnapshot,
      signal: input.signal
    });
    const wrapped = isPlainObject(evaluated) &&
      hasExactKeys(evaluated, ["diagnostic", "report"]);
    const report = wrapped ? evaluated.report : evaluated;
    const validation = validateHippocampusActivationPreflight(report);
    if (!validation.valid) fail("INVALID_ACTIVATION_PREFLIGHT");
    lastPreflight = report;
    lastPreflightDiagnostic = sanitizeDiagnostic(
      wrapped ? evaluated.diagnostic : defaultDiagnostic(report),
      report
    );
    return report;
  }

  const controller = createHippocampusActivationController({
    createGate: createHippocampusActivationGate,
    evaluatePreflight: evaluate,
    runner: options.runShadow === undefined
      ? undefined
      : async ({ gateSnapshot, preflightSnapshot, signal }) => {
        let result;
        try {
          result = await options.runShadow({
            configuration: config,
            gateSnapshot,
            preflightSnapshot,
            signal
          });
          lastShadowResult = sanitizeShadowResult(result);
        } catch (error) {
          lastShadowFailure = sanitizedShadowFailure(
            signal.aborted && !isPlainObject(error?.shadowFailure)
              ? { code: "RUN_ABORTED" }
              : error,
            result === undefined ? "runtime" : "result_normalization"
          );
          throw error;
        }
        return {
          clusterCount: lastShadowResult.clusterCount,
          deferredComponentCount: lastShadowResult.deferredComponentCount,
          simulatedSuperMemoryCount:
            lastShadowResult.simulatedSuperMemoryCount
        };
      },
    now: clock,
    createAbortController() {
      const created = createAbortController();
      if (!isAbortController(created)) fail("INVALID_ABORT_CONTROLLER");
      controllerAbortController = created;
      return created;
    }
  });

  if (config.mode === HIPPOCAMPUS_ACTIVATION_MODES.SHADOW) {
    const selected = controller.setMode({ mode: config.mode });
    if (!selected.accepted) fail(selected.reasonCode);
  }

  function getStatus() {
    return emptyReport(
      config.mode === HIPPOCAMPUS_ACTIVATION_MODES.OFF
        ? "OFF"
        : "SHADOW_IDLE",
      config.mode,
      "NOT_RUN"
    );
  }

  async function preflightOnly() {
    if (config.operation !== RUNTIME_OPERATIONS.PREFLIGHT_ONLY) {
      fail("INVALID_RUNTIME_OPERATION");
    }
    const startedAt = clock();
    lastPreflightDiagnostic = null;
    const abortController = createAbortController();
    if (!isAbortController(abortController)) fail("INVALID_ABORT_CONTROLLER");
    activePreflight = abortController;
    try {
      const gateSnapshot = createHippocampusActivationGate({
        mode: HIPPOCAMPUS_ACTIVATION_MODES.SHADOW
      });
      const report = await evaluate({
        gateSnapshot,
        signal: abortController.signal
      });
      if (abortController.signal.aborted) {
        return diagnosticReport(sanitizeDiagnostic({
          reasonCode: "PREFLIGHT_ABORTED",
          checks: {
            configuration: "NOT_RUN", storage: "NOT_RUN",
            qdrant: "NOT_RUN", embeddingCache: "NOT_RUN",
            bgeM3: "NOT_RUN", qwenMiniInference: "NOT_RUN",
            commitCapabilityAbsent: "PASS"
          },
          missingConfigurationKeys: []
        }, report), clock() - startedAt);
      }
      return diagnosticReport(
        lastPreflightDiagnostic || defaultDiagnostic(report),
        clock() - startedAt
      );
    } catch {
      if (abortController.signal.aborted) {
        return diagnosticReport({
          reasonCode: "PREFLIGHT_ABORTED",
          checks: {
            configuration: "NOT_RUN", storage: "NOT_RUN",
            qdrant: "NOT_RUN", embeddingCache: "NOT_RUN",
            bgeM3: "NOT_RUN", qwenMiniInference: "NOT_RUN",
            commitCapabilityAbsent: "PASS"
          },
          missingConfigurationKeys: []
        }, clock() - startedAt);
      }
      return diagnosticReport({
        reasonCode: "PREFLIGHT_INTERNAL_CONFIGURATION_ERROR",
        checks: {
          configuration: "NOT_RUN", storage: "NOT_RUN",
          qdrant: "NOT_RUN", embeddingCache: "NOT_RUN",
          bgeM3: "NOT_RUN", qwenMiniInference: "NOT_RUN",
          commitCapabilityAbsent: "PASS"
        },
        missingConfigurationKeys: []
      }, clock() - startedAt);
    } finally {
      activePreflight = null;
    }
  }

  async function runOnce() {
    if (config.operation !== RUNTIME_OPERATIONS.RUN_ONCE) {
      fail("INVALID_RUNTIME_OPERATION");
    }
    const startedAt = clock();
    lastPreflight = null;
    lastShadowResult = null;
    lastShadowFailure = null;
    const operation = await controller.runOnce({});
    const durationMs = clock() - startedAt;
    if (operation.reasonCode === "RUN_ABORTED") {
      return shadowFailureReport(
        lastShadowFailure || sanitizedShadowFailure({ code: "RUN_ABORTED" }),
        "PASS",
        durationMs
      );
    }
    if (operation.reasonCode === "PREFLIGHT_NOT_READY") {
      return emptyReport(
        "SHADOW_PREFLIGHT_FAILED", "SHADOW", "FAIL", durationMs
      );
    }
    if (operation.reasonCode === "RUNNER_UNAVAILABLE") {
      return emptyReport(
        "SHADOW_RUNNER_UNAVAILABLE",
        "SHADOW",
        lastPreflight?.shadowReady ? "PASS" : "NOT_RUN",
        durationMs
      );
    }
    if (operation.reasonCode !== "RUN_SUCCEEDED" ||
        lastShadowResult === null) {
      return shadowFailureReport(
        lastShadowFailure || sanitizedShadowFailure(null),
        lastPreflight?.shadowReady ? "PASS" : "FAIL",
        durationMs
      );
    }
    return deepFreeze({
      status: lastShadowResult.candidateCount === 0
        ? "SHADOW_NO_ELIGIBLE_CANDIDATES"
        : "SHADOW_SUCCEEDED",
      mode: "SHADOW",
      preflight: "PASS",
      ...lastShadowResult,
      processingStateWrites: 0,
      durationMs
    });
  }

  async function stop() {
    if (activePreflight) {
      if (!activePreflight.signal.aborted) activePreflight.abort();
      return deepFreeze({ requested: true, reasonCode: "STOP_REQUESTED" });
    }
    if (controllerAbortController &&
        !controllerAbortController.signal.aborted) {
      const stopped = await controller.stop({});
      return deepFreeze({
        requested: stopped.accepted,
        reasonCode: stopped.reasonCode
      });
    }
    return deepFreeze({ requested: false, reasonCode: "NO_ACTIVE_RUN" });
  }

  return deepFreeze({
    getStatus,
    preflightOnly,
    runOnce,
    stop
  });
}

module.exports = {
  SHADOW_CONFIRMATION,
  RUNTIME_OPERATIONS,
  HippocampusRuntimeCompositionError,
  createHippocampusRuntime
};
