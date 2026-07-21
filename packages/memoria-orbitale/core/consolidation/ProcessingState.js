"use strict";

const { createHash } = require("node:crypto");

const PROCESSING_STATE_SCHEMA_VERSION = 1;

function deepFreeze(value) {
  Object.freeze(value);
  for (const child of Object.values(value)) {
    if (child && typeof child === "object" && !Object.isFrozen(child)) deepFreeze(child);
  }
  return value;
}

const PROCESSING_STATES = deepFreeze({
  RAW: "raw",
  CANDIDATE: "candidate",
  SYNTHESIZING: "synthesizing",
  CONSOLIDATED: "consolidated",
  FAILED: "failed"
});

const PROCESSING_TRANSITIONS = deepFreeze({
  [PROCESSING_STATES.RAW]: [PROCESSING_STATES.CANDIDATE],
  [PROCESSING_STATES.CANDIDATE]: [
    PROCESSING_STATES.RAW,
    PROCESSING_STATES.SYNTHESIZING
  ],
  [PROCESSING_STATES.SYNTHESIZING]: [
    PROCESSING_STATES.CONSOLIDATED,
    PROCESSING_STATES.FAILED
  ],
  [PROCESSING_STATES.CONSOLIDATED]: [],
  [PROCESSING_STATES.FAILED]: [
    PROCESSING_STATES.CANDIDATE,
    PROCESSING_STATES.RAW
  ]
});

const STATE_VALUES = new Set(Object.values(PROCESSING_STATES));
const HEX_64 = /^[a-f0-9]{64}$/;
const ERROR_CODE = /^[A-Z][A-Z0-9_]*$/;
const FORBIDDEN_KEYS = /^(content|text|sourceSnapshot|payload|prompt|stack|cause|callback|storage|writer|write|commit)$/i;

class ProcessingStateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProcessingStateError";
    this.code = code;
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${stableStringify(value[key])}`
  ).join(",")}}`;
}

function cloneError(error) {
  if (error === null || !isPlainObject(error)) return error;
  return {
    code: error.code,
    message: error.message,
    retryable: error.retryable
  };
}

function inspectPlainData(value, ancestors, errors, path) {
  if (["undefined", "function", "symbol", "bigint"].includes(typeof value)) {
    errors.push(`${path} contains a non-JSON value`);
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (ancestors.has(value)) {
    errors.push(`${path} contains a circular reference`);
    return;
  }
  if (!Array.isArray(value) && !isPlainObject(value)) errors.push(`${path} must contain plain data`);
  ancestors.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.test(key)) errors.push(`${path}.${key} is forbidden`);
    inspectPlainData(child, ancestors, errors, `${path}.${key}`);
  }
  ancestors.delete(value);
}

function errorValidation(error) {
  if (!isPlainObject(error)) return ["failed error must be a plain object"];
  const errors = [];
  if (Object.keys(error).sort().join(",") !== "code,message,retryable") {
    errors.push("failed error has unsupported properties");
  }
  if (typeof error.code !== "string" || !ERROR_CODE.test(error.code)) {
    errors.push("failed error code must be a stable uppercase code");
  }
  if (typeof error.message !== "string" || error.message.trim().length === 0) {
    errors.push("failed error message must be non-empty");
  }
  if (typeof error.retryable !== "boolean") errors.push("failed error retryable must be boolean");
  return errors;
}

function validateProcessingState(processing) {
  const errors = [];
  if (!isPlainObject(processing)) return { valid: false, errors: ["processing must be a plain object"] };
  inspectPlainData(processing, new Set(), errors, "processing");
  if (Object.keys(processing).sort().join(",") !==
      "attempt_id,error,revision,schema_version,state,updated_at") {
    errors.push("processing must contain exactly the V1 fields");
  }
  if (processing.schema_version !== PROCESSING_STATE_SCHEMA_VERSION) errors.push("unsupported schema_version");
  if (!STATE_VALUES.has(processing.state)) errors.push("unknown processing state");
  if (!Number.isInteger(processing.revision) || processing.revision < 0) errors.push("revision must be an integer >= 0");
  if (!Number.isInteger(processing.updated_at) || processing.updated_at < 0) errors.push("updated_at must be epoch milliseconds >= 0");
  const requiresAttempt = [
    PROCESSING_STATES.SYNTHESIZING,
    PROCESSING_STATES.CONSOLIDATED,
    PROCESSING_STATES.FAILED
  ].includes(processing.state);
  if (requiresAttempt) {
    if (typeof processing.attempt_id !== "string" || processing.attempt_id.trim().length === 0) {
      errors.push("attempt_id is required for this state");
    }
  } else if (processing.attempt_id !== null) {
    errors.push("attempt_id must be null for this state");
  }
  if (processing.state === PROCESSING_STATES.FAILED) {
    errors.push(...errorValidation(processing.error));
  } else if (processing.error !== null) {
    errors.push("error must be null outside failed");
  }
  return { valid: errors.length === 0, errors };
}

function createProcessingState(input) {
  if (!isPlainObject(input)) {
    throw new ProcessingStateError("ERR_PROCESSING_INVALID_INPUT", "Processing input must be a plain object");
  }
  const allowed = new Set(["schema_version", "state", "revision", "attempt_id", "updated_at", "error"]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new ProcessingStateError("ERR_PROCESSING_UNKNOWN_PROPERTY", `Unsupported processing property: ${key}`);
  }
  if (input.state === PROCESSING_STATES.FAILED && Object.hasOwn(input, "error")) {
    const inputErrorValidation = errorValidation(input.error);
    if (inputErrorValidation.length > 0) {
      throw new ProcessingStateError("ERR_PROCESSING_INVALID_ERROR", inputErrorValidation.join("; "));
    }
  }
  const processing = {
    schema_version: Object.hasOwn(input, "schema_version")
      ? input.schema_version
      : PROCESSING_STATE_SCHEMA_VERSION,
    state: input.state,
    revision: Object.hasOwn(input, "revision") ? input.revision : 0,
    attempt_id: Object.hasOwn(input, "attempt_id") ? input.attempt_id : null,
    updated_at: input.updated_at,
    error: Object.hasOwn(input, "error") ? cloneError(input.error) : null
  };
  const validation = validateProcessingState(processing);
  if (!validation.valid) {
    throw new ProcessingStateError("ERR_PROCESSING_INVALID_STATE", validation.errors.join("; "));
  }
  return deepFreeze(processing);
}

function assertKnownState(state, label) {
  if (!STATE_VALUES.has(state)) {
    throw new ProcessingStateError("ERR_PROCESSING_UNKNOWN_STATE", `${label} must be a canonical processing state`);
  }
}

function canTransitionProcessingState(fromState, toState) {
  assertKnownState(fromState, "fromState");
  assertKnownState(toState, "toState");
  return fromState !== toState && PROCESSING_TRANSITIONS[fromState].includes(toState);
}

function transitionIdentity(plan) {
  return {
    schemaVersion: plan.schemaVersion,
    memoryId: plan.memoryId,
    fromState: plan.fromState,
    toState: plan.toState,
    expectedRevision: plan.expectedRevision,
    nextRevision: plan.nextRevision,
    expectedUpdatedAt: plan.expectedUpdatedAt,
    nextUpdatedAt: plan.nextProcessing.updated_at,
    expectedAttemptId: plan.expectedAttemptId,
    attemptId: plan.nextProcessing.attempt_id,
    errorCode: plan.nextProcessing.error?.code || null,
    reason: plan.reason
  };
}

function calculateTransitionId(plan) {
  return createHash("sha256").update(stableStringify(transitionIdentity(plan)), "utf8").digest("hex");
}

function nextTransitionFields(current, toState, input) {
  if (current.state === PROCESSING_STATES.CANDIDATE && toState === PROCESSING_STATES.SYNTHESIZING) {
    if (typeof input.attemptId !== "string" || input.attemptId.trim().length === 0) {
      throw new ProcessingStateError("ERR_PROCESSING_ATTEMPT_REQUIRED", "candidate to synthesizing requires attemptId");
    }
    if (input.error !== undefined && input.error !== null) {
      throw new ProcessingStateError("ERR_PROCESSING_ERROR_FORBIDDEN", "error is forbidden for synthesizing");
    }
    return { attempt_id: input.attemptId, error: null };
  }
  if (current.state === PROCESSING_STATES.SYNTHESIZING) {
    if (input.attemptId !== undefined && input.attemptId !== current.attempt_id) {
      throw new ProcessingStateError("ERR_PROCESSING_ATTEMPT_CHANGED", "attemptId cannot change during a synthesis attempt");
    }
    if (toState === PROCESSING_STATES.FAILED) {
      if (input.error === undefined || input.error === null) {
        throw new ProcessingStateError("ERR_PROCESSING_ERROR_REQUIRED", "synthesizing to failed requires error");
      }
      return { attempt_id: current.attempt_id, error: cloneError(input.error) };
    }
    if (input.error !== undefined && input.error !== null) {
      throw new ProcessingStateError("ERR_PROCESSING_ERROR_FORBIDDEN", "error is forbidden for consolidated");
    }
    return { attempt_id: current.attempt_id, error: null };
  }
  if (input.attemptId !== undefined && input.attemptId !== null ||
      input.error !== undefined && input.error !== null) {
    throw new ProcessingStateError("ERR_PROCESSING_TRANSITION_FIELDS", "attemptId and error are not accepted for this transition");
  }
  return { attempt_id: null, error: null };
}

function createProcessingTransitionPlan(input) {
  if (!isPlainObject(input)) throw new ProcessingStateError("ERR_PROCESSING_INVALID_INPUT", "Transition input must be a plain object");
  const allowed = new Set(["memoryId", "current", "toState", "updatedAt", "attemptId", "error", "reason"]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new ProcessingStateError("ERR_PROCESSING_UNKNOWN_PROPERTY", `Unsupported transition property: ${key}`);
  }
  if (typeof input.memoryId !== "string" || input.memoryId.trim().length === 0) {
    throw new ProcessingStateError("ERR_PROCESSING_MEMORY_ID", "memoryId must be a non-empty string");
  }
  const currentValidation = validateProcessingState(input.current);
  if (!currentValidation.valid) throw new ProcessingStateError("ERR_PROCESSING_INVALID_CURRENT", currentValidation.errors.join("; "));
  assertKnownState(input.toState, "toState");
  if (!canTransitionProcessingState(input.current.state, input.toState)) {
    throw new ProcessingStateError("ERR_PROCESSING_TRANSITION_NOT_ALLOWED", "Processing transition is not allowed");
  }
  if (!Number.isInteger(input.updatedAt) || input.updatedAt < input.current.updated_at) {
    throw new ProcessingStateError("ERR_PROCESSING_TIMESTAMP", "updatedAt must be integer epoch milliseconds and non-decreasing");
  }
  if (typeof input.reason !== "string" || input.reason.trim().length === 0) {
    throw new ProcessingStateError("ERR_PROCESSING_REASON", "reason must be a non-empty technical string");
  }
  const fields = nextTransitionFields(input.current, input.toState, input);
  const nextProcessing = createProcessingState({
    state: input.toState,
    revision: input.current.revision + 1,
    attempt_id: fields.attempt_id,
    updated_at: input.updatedAt,
    error: fields.error
  });
  const plan = {
    schemaVersion: PROCESSING_STATE_SCHEMA_VERSION,
    transitionId: "",
    memoryId: input.memoryId,
    fromState: input.current.state,
    toState: input.toState,
    expectedRevision: input.current.revision,
    nextRevision: nextProcessing.revision,
    expectedUpdatedAt: input.current.updated_at,
    expectedAttemptId: input.current.attempt_id,
    nextProcessing,
    reason: input.reason
  };
  plan.transitionId = calculateTransitionId(plan);
  const validation = validateProcessingTransitionPlan(plan);
  if (!validation.valid) throw new ProcessingStateError("ERR_PROCESSING_INVALID_PLAN", validation.errors.join("; "));
  return deepFreeze(plan);
}

function validateProcessingTransitionPlan(plan) {
  const errors = [];
  if (!isPlainObject(plan)) return { valid: false, errors: ["transition plan must be a plain object"] };
  inspectPlainData(plan, new Set(), errors, "plan");
  const expectedKeys = [
    "expectedAttemptId", "expectedRevision", "expectedUpdatedAt", "fromState",
    "memoryId", "nextProcessing", "nextRevision", "reason", "schemaVersion",
    "toState", "transitionId"
  ];
  if (Object.keys(plan).sort().join(",") !== expectedKeys.sort().join(",")) errors.push("transition plan has unsupported properties");
  if (plan.schemaVersion !== PROCESSING_STATE_SCHEMA_VERSION) errors.push("invalid transition schemaVersion");
  if (!STATE_VALUES.has(plan.fromState) || !STATE_VALUES.has(plan.toState)) errors.push("transition contains unknown state");
  else if (!canTransitionProcessingState(plan.fromState, plan.toState)) errors.push("transition is not allowed");
  if (typeof plan.memoryId !== "string" || plan.memoryId.trim().length === 0) errors.push("invalid memoryId");
  if (typeof plan.reason !== "string" || plan.reason.trim().length === 0) errors.push("invalid reason");
  if (!Number.isInteger(plan.expectedRevision) || plan.expectedRevision < 0 ||
      plan.nextRevision !== plan.expectedRevision + 1) errors.push("revisions must be consecutive");
  if (!Number.isInteger(plan.expectedUpdatedAt) || plan.expectedUpdatedAt < 0) errors.push("invalid expectedUpdatedAt");
  if ([PROCESSING_STATES.RAW, PROCESSING_STATES.CANDIDATE].includes(plan.fromState) &&
      plan.expectedAttemptId !== null) errors.push("expectedAttemptId must be null for the source state");
  if ([PROCESSING_STATES.SYNTHESIZING, PROCESSING_STATES.FAILED].includes(plan.fromState) &&
      (typeof plan.expectedAttemptId !== "string" || plan.expectedAttemptId.trim().length === 0)) {
    errors.push("expectedAttemptId is required for the source state");
  }
  const nextValidation = validateProcessingState(plan.nextProcessing);
  if (!nextValidation.valid) errors.push(...nextValidation.errors.map((error) => `nextProcessing: ${error}`));
  if (isPlainObject(plan.nextProcessing)) {
    if (plan.nextProcessing.state !== plan.toState || plan.nextProcessing.revision !== plan.nextRevision) errors.push("nextProcessing is incoherent");
    if (plan.nextProcessing.updated_at < plan.expectedUpdatedAt) errors.push("next timestamp is older than expected timestamp");
    const preservesAttempt = plan.fromState === PROCESSING_STATES.SYNTHESIZING &&
      [PROCESSING_STATES.CONSOLIDATED, PROCESSING_STATES.FAILED].includes(plan.toState);
    if (preservesAttempt && (typeof plan.expectedAttemptId !== "string" ||
        plan.nextProcessing.attempt_id !== plan.expectedAttemptId)) errors.push("attempt_id was not preserved");
    const clearsAttempt = plan.fromState === PROCESSING_STATES.FAILED &&
      [PROCESSING_STATES.CANDIDATE, PROCESSING_STATES.RAW].includes(plan.toState);
    if (clearsAttempt && (plan.nextProcessing.attempt_id !== null || plan.nextProcessing.error !== null)) errors.push("retry or reset must clear attempt and error");
  }
  if (!HEX_64.test(plan.transitionId || "")) errors.push("invalid transitionId");
  else {
    try {
      if (calculateTransitionId(plan) !== plan.transitionId) errors.push("transitionId mismatch");
    } catch {
      errors.push("transitionId cannot be recalculated");
    }
  }
  return { valid: errors.length === 0, errors };
}

module.exports = {
  PROCESSING_STATE_SCHEMA_VERSION,
  PROCESSING_STATES,
  PROCESSING_TRANSITIONS,
  ProcessingStateError,
  createProcessingState,
  validateProcessingState,
  canTransitionProcessingState,
  createProcessingTransitionPlan,
  validateProcessingTransitionPlan
};
