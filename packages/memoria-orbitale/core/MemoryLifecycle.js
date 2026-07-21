const DAY_MS = 24 * 60 * 60 * 1000;

const MEMORY_LIFECYCLE_STATES = Object.freeze({
  COLD: "COLD",
  WARM: "WARM",
  HOT: "HOT",
  CONSCIOUS: "CONSCIOUS",
  SUPPRESSED: "SUPPRESSED",
  DECAYED: "DECAYED"
});

const MEMORY_LIFECYCLE_TRANSITIONS = Object.freeze({
  [MEMORY_LIFECYCLE_STATES.COLD]: Object.freeze([
    MEMORY_LIFECYCLE_STATES.WARM,
    MEMORY_LIFECYCLE_STATES.SUPPRESSED,
    MEMORY_LIFECYCLE_STATES.DECAYED
  ]),
  [MEMORY_LIFECYCLE_STATES.WARM]: Object.freeze([
    MEMORY_LIFECYCLE_STATES.HOT,
    MEMORY_LIFECYCLE_STATES.COLD,
    MEMORY_LIFECYCLE_STATES.SUPPRESSED
  ]),
  [MEMORY_LIFECYCLE_STATES.HOT]: Object.freeze([
    MEMORY_LIFECYCLE_STATES.CONSCIOUS,
    MEMORY_LIFECYCLE_STATES.WARM,
    MEMORY_LIFECYCLE_STATES.SUPPRESSED
  ]),
  [MEMORY_LIFECYCLE_STATES.CONSCIOUS]: Object.freeze([
    MEMORY_LIFECYCLE_STATES.HOT,
    MEMORY_LIFECYCLE_STATES.SUPPRESSED
  ]),
  [MEMORY_LIFECYCLE_STATES.DECAYED]: Object.freeze([
    MEMORY_LIFECYCLE_STATES.COLD,
    MEMORY_LIFECYCLE_STATES.SUPPRESSED
  ]),
  [MEMORY_LIFECYCLE_STATES.SUPPRESSED]: Object.freeze([])
});

const DEFAULT_LIFECYCLE_CONFIG = Object.freeze({
  coldActivationMax: 0.2,
  hotActivationMin: 0.7,
  warmEchoCountMin: 1,
  hotEchoEnergyMin: 2,
  hotPromotedCountMin: 1,
  suppressedCountMin: 1,
  decayedActivationMax: 0.03,
  decayedDormantAfterMs: 90 * DAY_MS
});

function finiteNumber(value, fallback = null) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizeConfig(config = {}) {
  return {
    ...DEFAULT_LIFECYCLE_CONFIG,
    ...Object.fromEntries(
      Object.entries(config).filter(([, value]) => finiteNumber(value) !== null)
    )
  };
}

function normalizeLifecycleState(state) {
  const normalized = String(state || "").trim().toUpperCase();
  return MEMORY_LIFECYCLE_STATES[normalized] || null;
}

function canTransitionLifecycle(fromState, toState) {
  const from = normalizeLifecycleState(fromState);
  const to = normalizeLifecycleState(toState);
  if (!from || !to) return false;
  if (to === MEMORY_LIFECYCLE_STATES.SUPPRESSED && from !== MEMORY_LIFECYCLE_STATES.SUPPRESSED) {
    return true;
  }
  return (MEMORY_LIFECYCLE_TRANSITIONS[from] || []).includes(to);
}

function memoryActivation(memory) {
  return finiteNumber(
    memory?.activation,
    finiteNumber(memory?.orbitalState, finiteNumber(memory?.orbital?.activation_score, 0))
  );
}

function memoryTimestamp(memory) {
  const raw = memory?.lastAccess ?? memory?.timestamp ?? memory?.orbital?.last_access;
  const numeric = finiteNumber(raw, null);
  if (numeric !== null) return numeric;

  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function gatePromotedMemory(memoryId, gateDecision) {
  if (!gateDecision) return false;
  if (gateDecision.promoted === true || gateDecision.conscious === true) return true;

  const promotedIds = Array.isArray(gateDecision.promotedMemoryIds)
    ? gateDecision.promotedMemoryIds
    : Array.isArray(gateDecision.promoted)
      ? gateDecision.promoted.map(item => item?.id || item?.memoryId || item)
      : [];

  return promotedIds.map(String).includes(String(memoryId));
}

function calculateMemoryLifecycle(memory, echoState = {}, options = {}) {
  if (!memory?.id) {
    throw new Error("calculateMemoryLifecycle requires a memory with id");
  }

  const config = normalizeConfig(options.config);
  const nowMs = finiteNumber(options.nowMs, Date.now());
  const activation = memoryActivation(memory);
  const dormantMs = finiteNumber(echoState?.dormantMs, (() => {
    const lastSeen = memoryTimestamp(memory);
    return lastSeen === null ? null : Math.max(0, nowMs - lastSeen);
  })());
  const echoCount = Math.max(0, finiteNumber(echoState?.echoCount, 0));
  const promotedCount = Math.max(0, finiteNumber(echoState?.promotedCount, 0));
  const suppressedCount = Math.max(0, finiteNumber(echoState?.suppressedCount, 0));
  const echoEnergy = Math.max(0, finiteNumber(echoState?.echoEnergy, 0));
  const gatePromoted = gatePromotedMemory(memory.id, options.gateDecision);

  let state = MEMORY_LIFECYCLE_STATES.COLD;
  const reasons = [];

  if (memory.suppressed === true || suppressedCount >= config.suppressedCountMin || options.suppressed === true) {
    state = MEMORY_LIFECYCLE_STATES.SUPPRESSED;
    reasons.push(`suppressedCount=${suppressedCount}`);
  } else if (
    activation <= config.decayedActivationMax &&
    dormantMs !== null &&
    dormantMs >= config.decayedDormantAfterMs
  ) {
    state = MEMORY_LIFECYCLE_STATES.DECAYED;
    reasons.push(`activation=${activation.toFixed(3)}`, `dormantMs=${dormantMs}`);
  } else if (
    gatePromoted &&
    (activation >= config.hotActivationMin || promotedCount >= config.hotPromotedCountMin)
  ) {
    state = MEMORY_LIFECYCLE_STATES.CONSCIOUS;
    reasons.push("gatePromoted=true");
  } else if (
    activation >= config.hotActivationMin ||
    promotedCount >= config.hotPromotedCountMin ||
    echoEnergy >= config.hotEchoEnergyMin
  ) {
    state = MEMORY_LIFECYCLE_STATES.HOT;
    reasons.push(`activation=${activation.toFixed(3)}`, `echoEnergy=${echoEnergy.toFixed(3)}`);
  } else if (activation >= config.coldActivationMax || echoCount >= config.warmEchoCountMin) {
    state = MEMORY_LIFECYCLE_STATES.WARM;
    reasons.push(`activation=${activation.toFixed(3)}`, `echoCount=${echoCount}`);
  } else {
    reasons.push(`activation=${activation.toFixed(3)}`);
  }

  return {
    memoryId: String(memory.id),
    state,
    activation,
    echoCount,
    promotedCount,
    suppressedCount,
    echoEnergy,
    dormantMs,
    gatePromoted,
    allowedTransitions: MEMORY_LIFECYCLE_TRANSITIONS[state] || [],
    reasons
  };
}

async function calculateMemoryLifecycleForId(storage, userId, memoryId, echoStates = [], options = {}) {
  if (!storage || typeof storage.getMemory !== "function") {
    throw new Error("calculateMemoryLifecycleForId requires storage.getMemory(userId, memoryId)");
  }

  const memory = await storage.getMemory(userId, memoryId);
  if (!memory) return null;

  const state = Array.isArray(echoStates)
    ? echoStates.find(item => String(item?.memoryId) === String(memoryId))
    : echoStates;

  return calculateMemoryLifecycle(memory, state || {}, options);
}

module.exports = {
  MEMORY_LIFECYCLE_STATES,
  MEMORY_LIFECYCLE_TRANSITIONS,
  DEFAULT_LIFECYCLE_CONFIG,
  canTransitionLifecycle,
  calculateMemoryLifecycle,
  calculateMemoryLifecycleForId
};
