"use strict";

const { createHash } = require("node:crypto");
const {
  CANDIDATE_DECISIONS,
  CANDIDATE_REASON_CODES,
  CandidateSelectionScaleError,
  selectConsolidationCandidatesScalable
} = require("./CandidateSelector");

const CONSOLIDATION_PLAN_SCHEMA_VERSION = 1;
const CONSOLIDATION_PLAN_ALGORITHM_VERSION = "consolidation-plan-batched-v1";
const HEX_64 = /^[a-f0-9]{64}$/;
const DECISIONS = new Set(Object.values(CANDIDATE_DECISIONS));
const REASONS = new Set(Object.values(CANDIDATE_REASON_CODES));
const ELIGIBLE_REASONS = new Set(["ELIGIBLE_EXPLICIT", "ELIGIBLE_LEGACY_OPT_IN"]);
const DEFERRED_REASONS = new Set([
  "UNSUPPORTED_PROCESSING_STATE", "LEGACY_UNCLASSIFIED", "LIMIT_EXPLICITLY_APPLIED",
  "EXPLICIT_CANDIDATE_ALREADY_CLAIMED", "EXPLICIT_FAILED_REQUIRES_RETRY"
]);
const FORBIDDEN_KEYS = /^(commit|write|writer|storageWriter|sourceSnapshot|content|text|snippet|prompt|payload|entities|meta)$/i;

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

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (isPlainObject(value)) return Object.fromEntries(Object.keys(value).map((key) => [key, clone(value[key])]));
  return value;
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function planIdentityPayload(plan) {
  return {
    schemaVersion: plan.schemaVersion,
    policyVersion: plan.policyVersion,
    policy: plan.policy,
    candidateIds: plan.candidateIds,
    decisions: plan.decisions,
    stats: plan.stats,
    dryRun: plan.dryRun
  };
}

function calculatePlanId(plan) {
  return createHash("sha256").update(stableStringify(planIdentityPayload(plan)), "utf8").digest("hex");
}

function assertSafeOptions(options) {
  if (options === undefined) return;
  if (!isPlainObject(options)) throw new TypeError("Plan options must be a plain object");
  if (Object.keys(options).length > 0) throw new TypeError("Consolidation plans accept no execution options");
}

function buildPlanFromSelection(selectionResult, detach, validate) {
  if (!isPlainObject(selectionResult) || !Array.isArray(selectionResult.decisions) ||
      !Array.isArray(selectionResult.eligibleIds) || !isPlainObject(selectionResult.policy) ||
      !isPlainObject(selectionResult.stats)) {
    throw new TypeError("A valid selection result is required");
  }
  const plan = {
    schemaVersion: CONSOLIDATION_PLAN_SCHEMA_VERSION,
    planId: "",
    dryRun: true,
    policyVersion: selectionResult.policy.policyVersion,
    policy: detach ? clone(selectionResult.policy) : selectionResult.policy,
    candidateIds: detach ? clone(selectionResult.eligibleIds) : selectionResult.eligibleIds,
    decisions: detach ? clone(selectionResult.decisions) : selectionResult.decisions,
    stats: detach ? clone(selectionResult.stats) : selectionResult.stats
  };
  plan.planId = calculatePlanId(plan);
  if (validate) {
    const validation = validateConsolidationPlanInternal(plan, plan.planId);
    if (!validation.valid) throw new TypeError(`Invalid consolidation plan: ${validation.errors.join("; ")}`);
  }
  return deepFreeze(plan);
}

function buildConsolidationPlan(selectionResult, options) {
  assertSafeOptions(options);
  return buildPlanFromSelection(selectionResult, true, true);
}

async function buildConsolidationPlanScalable(memories, options) {
  const started = process.hrtime.bigint();
  const rssStartBytes = process.memoryUsage().rss;
  const selected = await selectConsolidationCandidatesScalable(memories, options);
  if (options?.signal?.aborted) {
    throw new CandidateSelectionScaleError("CANDIDATE_SELECTION_ABORTED", "Candidate selection was aborted");
  }
  const plan = buildPlanFromSelection(selected.selection, false, false);
  const rssPeakBytes = Math.max(selected.telemetry.rssPeakBytes, process.memoryUsage().rss);
  const rssDeltaBytes = Math.max(0, rssPeakBytes - rssStartBytes);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  const telemetry = deepFreeze({
    inputCount: selected.telemetry.inputCount,
    processedCount: selected.telemetry.processedCount,
    batchCount: selected.telemetry.batchCount,
    batchSize: selected.telemetry.batchSize,
    eligibleCount: selected.telemetry.eligibleCount,
    excludedCount: selected.telemetry.excludedCount,
    deferredCount: selected.telemetry.deferredCount,
    duplicateIdCount: selected.telemetry.duplicateIdCount,
    duplicateContentCount: selected.telemetry.duplicateContentCount,
    elapsedMs,
    rssStartBytes,
    rssPeakBytes,
    rssDeltaBytes,
    budget: clone(selected.telemetry.budget),
    budgetExceeded: elapsedMs > selected.telemetry.budget.maxElapsedMs ||
      rssDeltaBytes > selected.telemetry.budget.maxRssDeltaBytes,
    algorithmVersion: CONSOLIDATION_PLAN_ALGORITHM_VERSION
  });
  return deepFreeze({ plan, telemetry });
}

function inspectValue(value, ancestors, errors, path = "plan") {
  if (["function", "symbol", "bigint", "undefined"].includes(typeof value)) {
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
    inspectValue(child, ancestors, errors, `${path}.${key}`);
  }
  ancestors.delete(value);
}

function validateConsolidationPlanInternal(plan, trustedPlanId) {
  const errors = [];
  if (!isPlainObject(plan)) return { valid: false, errors: ["plan must be a plain object"] };
  inspectValue(plan, new Set(), errors);
  const allowedTop = new Set(["schemaVersion", "planId", "dryRun", "policyVersion", "policy", "candidateIds", "decisions", "stats"]);
  for (const key of Object.keys(plan)) if (!allowedTop.has(key)) errors.push(`unsupported plan property: ${key}`);
  if (plan.schemaVersion !== CONSOLIDATION_PLAN_SCHEMA_VERSION) errors.push("invalid schemaVersion");
  if (plan.dryRun !== true) errors.push("dryRun must be true");
  if (!HEX_64.test(plan.planId || "")) errors.push("invalid planId");
  if (!Number.isInteger(plan.policyVersion) || plan.policyVersion <= 0) errors.push("invalid policyVersion");
  if (!isPlainObject(plan.policy) || plan.policy.policyVersion !== plan.policyVersion ||
      Object.keys(plan.policy).sort().join(",") !== "allowLegacyUnclassified,maxCandidates,policyVersion" ||
      typeof plan.policy.allowLegacyUnclassified !== "boolean" ||
      plan.policy.maxCandidates !== null &&
        (!Number.isInteger(plan.policy.maxCandidates) || plan.policy.maxCandidates <= 0)) {
    errors.push("invalid policy");
  }
  if (!Array.isArray(plan.candidateIds) || new Set(plan.candidateIds).size !== plan.candidateIds?.length ||
      plan.candidateIds?.some((id) => typeof id !== "string" || id.length === 0)) errors.push("candidateIds must be unique non-empty strings");
  if (!Array.isArray(plan.decisions)) errors.push("decisions must be an array");
  else {
    for (const item of plan.decisions) {
      if (!isPlainObject(item) || !DECISIONS.has(item.decision)) errors.push("invalid decision");
      if (!Array.isArray(item?.reasonCodes) || item.reasonCodes.length === 0 || item.reasonCodes.some((reason) => !REASONS.has(reason))) errors.push("unknown or missing reason code");
      if (item?.contentHash !== null && !HEX_64.test(item?.contentHash || "")) errors.push("invalid contentHash");
      if (item?.memoryId !== null && (typeof item?.memoryId !== "string" || item.memoryId.length === 0)) errors.push("invalid decision memoryId");
      if (!Number.isInteger(item?.disambiguationIndex) || item.disambiguationIndex < 0) errors.push("invalid disambiguationIndex");
      if (item?.decision === "eligible" && !ELIGIBLE_REASONS.has(item.reasonCodes?.[0]) ||
          item?.decision === "deferred" && !DEFERRED_REASONS.has(item.reasonCodes?.[0]) ||
          item?.decision === "excluded" &&
            (ELIGIBLE_REASONS.has(item.reasonCodes?.[0]) || DEFERRED_REASONS.has(item.reasonCodes?.[0]))) {
        errors.push("decision and reason code are incoherent");
      }
    }
  }
  const statNames = [
    "inputCount", "validCount", "eligibleBeforeLimit", "eligibleIncluded",
    "excludedCount", "deferredCount", "duplicateIdCount", "duplicateContentCount"
  ];
  if (!isPlainObject(plan.stats) || statNames.some((name) =>
    !Number.isInteger(plan.stats?.[name]) || plan.stats[name] < 0
  ) || typeof plan.stats?.truncated !== "boolean" ||
      Array.isArray(plan.decisions) && isPlainObject(plan.stats) && (
    plan.stats.inputCount !== plan.decisions.length ||
    plan.stats.validCount > plan.stats.inputCount ||
    plan.stats.eligibleBeforeLimit < plan.stats.eligibleIncluded ||
    plan.stats.eligibleIncluded !== plan.candidateIds?.length ||
    plan.stats.excludedCount !== plan.decisions.filter((item) => item.decision === "excluded").length ||
    plan.stats.deferredCount !== plan.decisions.filter((item) => item.decision === "deferred").length ||
    plan.stats.eligibleIncluded + plan.stats.excludedCount + plan.stats.deferredCount !== plan.stats.inputCount ||
    plan.stats.duplicateIdCount !== plan.decisions.filter((item) => item.reasonCodes?.includes("DUPLICATE_ID")).length ||
    plan.stats.duplicateContentCount !== plan.decisions.filter((item) => item.reasonCodes?.includes("DUPLICATE_CONTENT")).length
  )) errors.push("incoherent statistics");
  if (Array.isArray(plan.decisions) && Array.isArray(plan.candidateIds)) {
    const eligible = plan.decisions.filter((item) => item.decision === "eligible").map((item) => item.memoryId);
    if (stableStringify(eligible) !== stableStringify(plan.candidateIds)) errors.push("candidateIds do not match eligible decisions");
  }
  if (HEX_64.test(plan.planId || "") && trustedPlanId !== plan.planId) {
    try {
      if (calculatePlanId(plan) !== plan.planId) errors.push("planId mismatch");
    } catch {
      errors.push("planId cannot be recalculated");
    }
  }
  return { valid: errors.length === 0, errors };
}

function validateConsolidationPlan(plan) {
  return validateConsolidationPlanInternal(plan, null);
}

module.exports = {
  CONSOLIDATION_PLAN_SCHEMA_VERSION,
  CONSOLIDATION_PLAN_ALGORITHM_VERSION,
  buildConsolidationPlan,
  buildConsolidationPlanScalable,
  validateConsolidationPlan
};
