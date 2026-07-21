"use strict";

const { createHash } = require("node:crypto");
const { projectMemoryForCandidateSelection } = require("../MemoryContractNormalizer");
const { PROCESSING_STATES } = require("./ProcessingState");

function deepFreeze(value) {
  Object.freeze(value);
  for (const child of Object.values(value)) {
    if (child && typeof child === "object" && !Object.isFrozen(child)) deepFreeze(child);
  }
  return value;
}

const CANDIDATE_DECISIONS = deepFreeze({
  ELIGIBLE: "eligible",
  EXCLUDED: "excluded",
  DEFERRED: "deferred"
});

const CANDIDATE_REASON_CODES = deepFreeze({
  ELIGIBLE_EXPLICIT: "ELIGIBLE_EXPLICIT",
  ELIGIBLE_LEGACY_OPT_IN: "ELIGIBLE_LEGACY_OPT_IN",
  INVALID_MEMORY: "INVALID_MEMORY",
  MISSING_ID: "MISSING_ID",
  EMPTY_CONTENT: "EMPTY_CONTENT",
  DUPLICATE_ID: "DUPLICATE_ID",
  DUPLICATE_CONTENT: "DUPLICATE_CONTENT",
  EXPLICIT_SUPER_MEMORY: "EXPLICIT_SUPER_MEMORY",
  EXPLICIT_DEEP_TIER: "EXPLICIT_DEEP_TIER",
  EXPLICIT_CONSOLIDATED: "EXPLICIT_CONSOLIDATED",
  EXPLICIT_SYNTHESIZING: "EXPLICIT_SYNTHESIZING",
  EXPLICIT_CANDIDATE_ALREADY_CLAIMED: "EXPLICIT_CANDIDATE_ALREADY_CLAIMED",
  EXPLICIT_FAILED_REQUIRES_RETRY: "EXPLICIT_FAILED_REQUIRES_RETRY",
  UNSUPPORTED_PROCESSING_STATE: "UNSUPPORTED_PROCESSING_STATE",
  LEGACY_UNCLASSIFIED: "LEGACY_UNCLASSIFIED",
  LIMIT_EXPLICITLY_APPLIED: "LIMIT_EXPLICITLY_APPLIED"
});

const DEFAULT_CANDIDATE_POLICY = deepFreeze({
  policyVersion: 1,
  allowLegacyUnclassified: false,
  maxCandidates: null
});
const CANDIDATE_SELECTION_ALGORITHM_VERSION = "candidate-selection-batched-v1";
const DEFAULT_CANDIDATE_SCALE_OPTIONS = deepFreeze({
  batchSize: 500,
  budget: {
    maxElapsedMs: 9500,
    maxRssDeltaBytes: 128 * 1024 * 1024
  }
});

class CandidateSelectionScaleError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CandidateSelectionScaleError";
    this.code = code;
  }
}

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertJsonLike(value, ancestors = new Set()) {
  if (value === null || ["string", "boolean"].includes(typeof value)) return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (!Array.isArray(value) && !isPlainObject(value)) {
    throw new TypeError("Input must contain only finite JSON-like plain data");
  }
  if (ancestors.has(value)) throw new TypeError("Input must not contain circular references");
  ancestors.add(value);
  for (const child of Array.isArray(value) ? value : Object.values(value)) assertJsonLike(child, ancestors);
  ancestors.delete(value);
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function normalizePolicy(options) {
  if (options === undefined) options = {};
  if (!isPlainObject(options)) throw new TypeError("Candidate options must be a plain object");
  const allowed = new Set(["allowLegacyUnclassified", "maxCandidates"]);
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) throw new TypeError(`Unsupported candidate option: ${key}`);
  }
  if (hasOwn(options, "allowLegacyUnclassified") && typeof options.allowLegacyUnclassified !== "boolean") {
    throw new TypeError("allowLegacyUnclassified must be boolean");
  }
  const maxCandidates = hasOwn(options, "maxCandidates")
    ? options.maxCandidates
    : DEFAULT_CANDIDATE_POLICY.maxCandidates;
  if (maxCandidates !== null && (!Number.isInteger(maxCandidates) || maxCandidates <= 0)) {
    throw new TypeError("maxCandidates must be null or a positive integer");
  }
  return {
    policyVersion: DEFAULT_CANDIDATE_POLICY.policyVersion,
    allowLegacyUnclassified: options.allowLegacyUnclassified === true,
    maxCandidates
  };
}

function normalizeScaleOptions(options) {
  if (options === undefined) options = {};
  if (!isPlainObject(options)) throw new TypeError("Scale options must be a plain object");
  const allowed = new Set(["allowLegacyUnclassified", "maxCandidates", "batchSize", "budget", "signal"]);
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) throw new TypeError(`Unsupported scale option: ${key}`);
  }
  const policyOptions = {};
  if (hasOwn(options, "allowLegacyUnclassified")) policyOptions.allowLegacyUnclassified = options.allowLegacyUnclassified;
  if (hasOwn(options, "maxCandidates")) policyOptions.maxCandidates = options.maxCandidates;
  const policy = normalizePolicy(policyOptions);
  const batchSize = options.batchSize === undefined ? DEFAULT_CANDIDATE_SCALE_OPTIONS.batchSize : options.batchSize;
  if (!Number.isInteger(batchSize) || batchSize <= 0) throw new TypeError("batchSize must be a positive integer");
  const budget = options.budget === undefined ? DEFAULT_CANDIDATE_SCALE_OPTIONS.budget : options.budget;
  if (!isPlainObject(budget) || Object.keys(budget).sort().join(",") !== "maxElapsedMs,maxRssDeltaBytes" ||
      typeof budget.maxElapsedMs !== "number" || !Number.isFinite(budget.maxElapsedMs) || budget.maxElapsedMs <= 0 ||
      !Number.isSafeInteger(budget.maxRssDeltaBytes) || budget.maxRssDeltaBytes <= 0) {
    throw new TypeError("budget must contain positive maxElapsedMs and maxRssDeltaBytes");
  }
  if (options.signal !== undefined && (!options.signal || typeof options.signal.aborted !== "boolean" ||
      typeof options.signal.addEventListener !== "function")) throw new TypeError("signal must be an AbortSignal");
  return { policy, batchSize, budget: { ...budget }, signal: options.signal };
}

function inputSource(memories) {
  if (!Array.isArray(memories) && !isPlainObject(memories)) {
    throw new TypeError("Memories must be an array or a plain object map");
  }
  const fromMap = !Array.isArray(memories);
  const keys = fromMap ? Object.keys(memories) : null;
  return {
    count: fromMap ? keys.length : memories.length,
    entryAt(index) {
      return fromMap
        ? { mapKey: keys[index], inputIndex: index, value: memories[keys[index]] }
        : { inputIndex: index, value: memories[index] };
    }
  };
}

function projectEntry(entry) {
  let projected = null;
  if (isPlainObject(entry.value)) projected = projectMemoryForCandidateSelection(entry.value);
  else assertJsonLike(entry.value);
  const memoryId = projected && typeof projected.id === "string" && projected.id.length > 0
    ? projected.id
    : null;
  const text = projected?.text;
  const contentHash = typeof text === "string" ? sha256(text) : null;
  const textState = typeof text === "string" && text.length > 0 ? "present" : "empty";
  return {
    memoryId,
    sourceContract: projected?.sourceContract || "invalid",
    contentHash,
    textState,
    timestamp: projected?.timestamp ?? null,
    memoryKind: projected?.memoryKind ?? null,
    storageTier: projected?.storageTier ?? null,
    processingState: projected?.processingState ?? null,
    mapKey: entry.mapKey,
    inputIndex: entry.inputIndex,
    sortFingerprint: null
  };
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function entrySortFingerprint(entry) {
  if (entry.sortFingerprint === null) {
    entry.sortFingerprint = sha256(stableStringify({
      memoryId: entry.memoryId,
      sourceContract: entry.sourceContract,
      contentHash: entry.contentHash,
      textState: entry.textState,
      timestamp: entry.timestamp,
      memoryKind: entry.memoryKind,
      storageTier: entry.storageTier,
      processingState: entry.processingState
    }));
  }
  return entry.sortFingerprint;
}

function sortEntries(entries) {
  return entries.sort((left, right) => {
    const idOrder = compareStrings(String(left.memoryId || ""), String(right.memoryId || ""));
    if (idOrder !== 0) return idOrder;
    const fingerprintOrder = compareStrings(entrySortFingerprint(left), entrySortFingerprint(right));
    if (fingerprintOrder !== 0) return fingerprintOrder;
    const keyOrder = compareStrings(String(left.mapKey || ""), String(right.mapKey || ""));
    return keyOrder || left.inputIndex - right.inputIndex;
  });
}

function descriptor(entry, decision, reasonCodes, contentHash) {
  return {
    memoryId: entry.memoryId,
    sourceContract: entry.sourceContract,
    decision,
    reasonCodes: [...reasonCodes],
    contentHash,
    timestamp: entry.timestamp,
    memoryKind: entry.memoryKind,
    storageTier: entry.storageTier,
    processingState: entry.processingState,
    disambiguationIndex: 0
  };
}

function initialDecision(entry) {
  const R = CANDIDATE_REASON_CODES;
  const D = CANDIDATE_DECISIONS;
  if (entry.sourceContract === "invalid") return descriptor(entry, D.EXCLUDED, [R.INVALID_MEMORY], null);
  const contentHash = entry.contentHash;
  if (entry.memoryId === null) return descriptor(entry, D.EXCLUDED, [R.MISSING_ID], contentHash);
  if (entry.textState !== "present") return descriptor(entry, D.EXCLUDED, [R.EMPTY_CONTENT], contentHash);
  if (entry.memoryKind === "super_memory") return descriptor(entry, D.EXCLUDED, [R.EXPLICIT_SUPER_MEMORY], contentHash);
  if (entry.storageTier === "deep") return descriptor(entry, D.EXCLUDED, [R.EXPLICIT_DEEP_TIER], contentHash);
  if (entry.processingState === PROCESSING_STATES.CONSOLIDATED) return descriptor(entry, D.EXCLUDED, [R.EXPLICIT_CONSOLIDATED], contentHash);
  if (entry.processingState === PROCESSING_STATES.SYNTHESIZING) return descriptor(entry, D.EXCLUDED, [R.EXPLICIT_SYNTHESIZING], contentHash);
  const legacy = entry.memoryKind === null && entry.storageTier === null && entry.processingState === null;
  if (legacy) return descriptor(entry, D.DEFERRED, [R.LEGACY_UNCLASSIFIED], contentHash);
  if (entry.processingState === PROCESSING_STATES.CANDIDATE) return descriptor(entry, D.DEFERRED, [R.EXPLICIT_CANDIDATE_ALREADY_CLAIMED], contentHash);
  if (entry.processingState === PROCESSING_STATES.FAILED) return descriptor(entry, D.DEFERRED, [R.EXPLICIT_FAILED_REQUIRES_RETRY], contentHash);
  if (entry.processingState !== PROCESSING_STATES.RAW ||
      !["raw", "episodic", "semantic", "structural"].includes(entry.memoryKind) ||
      !["core", "warm"].includes(entry.storageTier)) {
    return descriptor(entry, D.DEFERRED, [R.UNSUPPORTED_PROCESSING_STATE], contentHash);
  }
  return descriptor(entry, D.ELIGIBLE, [R.ELIGIBLE_EXPLICIT], contentHash);
}

function finalizeSelection(entries, policy) {
  const decisions = sortEntries(entries).map(initialDecision);
  const idCounts = new Map();
  const contentCounts = new Map();
  for (const item of decisions) {
    item.disambiguationIndex = idCounts.get(item.memoryId) || 0;
    if (item.memoryId !== null) idCounts.set(item.memoryId, item.disambiguationIndex + 1);
    if (item.disambiguationIndex > 0) {
      item.decision = CANDIDATE_DECISIONS.EXCLUDED;
      item.reasonCodes = [CANDIDATE_REASON_CODES.DUPLICATE_ID];
      continue;
    }
    if (item.contentHash !== null) {
      const seen = contentCounts.get(item.contentHash) || 0;
      contentCounts.set(item.contentHash, seen + 1);
      if (seen > 0) {
        item.decision = CANDIDATE_DECISIONS.EXCLUDED;
        item.reasonCodes = [CANDIDATE_REASON_CODES.DUPLICATE_CONTENT];
        continue;
      }
    }
    if (item.decision === CANDIDATE_DECISIONS.DEFERRED &&
        item.reasonCodes[0] === CANDIDATE_REASON_CODES.LEGACY_UNCLASSIFIED &&
        policy.allowLegacyUnclassified) {
      item.decision = CANDIDATE_DECISIONS.ELIGIBLE;
      item.reasonCodes = [CANDIDATE_REASON_CODES.ELIGIBLE_LEGACY_OPT_IN];
    }
  }

  let eligibleBeforeLimit = 0;
  for (const item of decisions) {
    if (item.decision === CANDIDATE_DECISIONS.ELIGIBLE) eligibleBeforeLimit += 1;
  }
  if (policy.maxCandidates !== null) {
    let included = 0;
    for (const item of decisions) {
      if (item.decision !== CANDIDATE_DECISIONS.ELIGIBLE) continue;
      included += 1;
      if (included > policy.maxCandidates) {
        item.decision = CANDIDATE_DECISIONS.DEFERRED;
        item.reasonCodes = [CANDIDATE_REASON_CODES.LIMIT_EXPLICITLY_APPLIED];
      }
    }
  }

  const eligibleIds = [];
  const excludedIds = [];
  const deferredIds = [];
  const stats = {
    inputCount: decisions.length,
    validCount: 0,
    eligibleBeforeLimit,
    eligibleIncluded: 0,
    excludedCount: 0,
    deferredCount: 0,
    duplicateIdCount: 0,
    duplicateContentCount: 0,
    truncated: policy.maxCandidates !== null && eligibleBeforeLimit > policy.maxCandidates
  };
  for (const item of decisions) {
    if (item.sourceContract !== "invalid") stats.validCount += 1;
    if (item.reasonCodes.includes(CANDIDATE_REASON_CODES.DUPLICATE_ID)) stats.duplicateIdCount += 1;
    if (item.reasonCodes.includes(CANDIDATE_REASON_CODES.DUPLICATE_CONTENT)) stats.duplicateContentCount += 1;
    if (item.decision === CANDIDATE_DECISIONS.ELIGIBLE) {
      stats.eligibleIncluded += 1;
      if (item.memoryId !== null) eligibleIds.push(item.memoryId);
    } else if (item.decision === CANDIDATE_DECISIONS.EXCLUDED) {
      stats.excludedCount += 1;
      if (item.memoryId !== null) excludedIds.push(item.memoryId);
    } else {
      stats.deferredCount += 1;
      if (item.memoryId !== null) deferredIds.push(item.memoryId);
    }
  }
  return deepFreeze({ policy, decisions, eligibleIds, excludedIds, deferredIds, stats });
}

function selectConsolidationCandidates(memories, options) {
  const policy = normalizePolicy(options);
  const source = inputSource(memories);
  const entries = [];
  for (let index = 0; index < source.count; index++) entries.push(projectEntry(source.entryAt(index)));
  return finalizeSelection(entries, policy);
}

function assertNotAborted(signal) {
  if (signal?.aborted) {
    throw new CandidateSelectionScaleError("CANDIDATE_SELECTION_ABORTED", "Candidate selection was aborted");
  }
}

async function selectConsolidationCandidatesScalable(memories, options) {
  const normalized = normalizeScaleOptions(options);
  const source = inputSource(memories);
  const entries = [];
  const started = process.hrtime.bigint();
  const rssStartBytes = process.memoryUsage().rss;
  let rssPeakBytes = rssStartBytes;
  let batchCount = 0;
  for (let start = 0; start < source.count; start += normalized.batchSize) {
    assertNotAborted(normalized.signal);
    const end = Math.min(source.count, start + normalized.batchSize);
    for (let index = start; index < end; index++) entries.push(projectEntry(source.entryAt(index)));
    batchCount += 1;
    rssPeakBytes = Math.max(rssPeakBytes, process.memoryUsage().rss);
    if (end < source.count) await new Promise(resolve => setImmediate(resolve));
  }
  assertNotAborted(normalized.signal);
  const selection = finalizeSelection(entries, normalized.policy);
  rssPeakBytes = Math.max(rssPeakBytes, process.memoryUsage().rss);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  const rssDeltaBytes = Math.max(0, rssPeakBytes - rssStartBytes);
  const telemetry = deepFreeze({
    inputCount: source.count,
    processedCount: source.count,
    batchCount,
    batchSize: normalized.batchSize,
    eligibleCount: selection.stats.eligibleIncluded,
    excludedCount: selection.stats.excludedCount,
    deferredCount: selection.stats.deferredCount,
    duplicateIdCount: selection.stats.duplicateIdCount,
    duplicateContentCount: selection.stats.duplicateContentCount,
    elapsedMs,
    rssStartBytes,
    rssPeakBytes,
    rssDeltaBytes,
    budget: { ...normalized.budget },
    budgetExceeded: elapsedMs > normalized.budget.maxElapsedMs || rssDeltaBytes > normalized.budget.maxRssDeltaBytes,
    algorithmVersion: CANDIDATE_SELECTION_ALGORITHM_VERSION
  });
  return deepFreeze({ selection, telemetry });
}

module.exports = {
  CANDIDATE_DECISIONS,
  CANDIDATE_REASON_CODES,
  DEFAULT_CANDIDATE_POLICY,
  CANDIDATE_SELECTION_ALGORITHM_VERSION,
  DEFAULT_CANDIDATE_SCALE_OPTIONS,
  CandidateSelectionScaleError,
  selectConsolidationCandidates,
  selectConsolidationCandidatesScalable
};
