const DAY_MS = 24 * 60 * 60 * 1000;

const DEFAULT_CONFIG = Object.freeze({
  version: "echo-reinforcement-policy/1",
  maxMemoryUpdates: 50,
  maxLinkUpdates: 25,
  minEchoCountForLatentPresence: 5,
  maxPromotionRatioForLatentPresence: 0.2,
  latentPresenceDelta: 0.02,
  minPromotedCountForOrbitLift: 3,
  minPromotedRatioForOrbitLift: 0.5,
  orbitLiftActivationDelta: 0.015,
  minEchoCountForCoEcho: 3,
  minSharedConceptsForCoEcho: 1,
  semanticLinkDelta: 0.02,
  allowNewSemanticLinkCandidates: false,
  dormantAfterMs: 30 * DAY_MS,
  dormantDecayDelta: -0.01,
  minSuppressedCountForInhibition: 3,
  temporaryInhibitionMs: 2 * DAY_MS,
  inhibitionStrength: 0.08
});

const ORBIT_LIFT = Object.freeze({
  cold: "long",
  long: "medium",
  medium: "short"
});

function finiteNumber(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function mergeConfig(config = {}) {
  const merged = { ...DEFAULT_CONFIG };

  for (const key of Object.keys(DEFAULT_CONFIG)) {
    if (config[key] === undefined) continue;
    merged[key] = typeof DEFAULT_CONFIG[key] === "number"
      ? finiteNumber(config[key], DEFAULT_CONFIG[key])
      : config[key];
  }

  merged.maxMemoryUpdates = Math.max(1, Math.floor(merged.maxMemoryUpdates));
  merged.maxLinkUpdates = Math.max(0, Math.floor(merged.maxLinkUpdates));
  merged.latentPresenceDelta = clamp(merged.latentPresenceDelta, 0, 0.05);
  merged.orbitLiftActivationDelta = clamp(merged.orbitLiftActivationDelta, 0, 0.05);
  merged.semanticLinkDelta = clamp(merged.semanticLinkDelta, 0, 0.05);
  merged.dormantDecayDelta = clamp(merged.dormantDecayDelta, -0.05, 0);
  merged.inhibitionStrength = clamp(merged.inhibitionStrength, 0, 0.25);

  return merged;
}

function promotedRatio(state) {
  const echoCount = Math.max(0, finiteNumber(state.echoCount, 0));
  if (echoCount === 0) return 0;
  return Math.max(0, finiteNumber(state.promotedCount, 0)) / echoCount;
}

function memoryLevel(memory) {
  return memory?.orbitalLevel || memory?.orbital?.level || null;
}

function memoryActivation(memory) {
  return finiteNumber(memory?.activation, finiteNumber(memory?.orbitalState, finiteNumber(memory?.orbital?.activation_score, null)));
}

function memoryTimestamp(memory) {
  const raw = memory?.lastAccess ?? memory?.timestamp ?? memory?.orbital?.last_access;
  const numeric = finiteNumber(raw, null);
  if (numeric !== null) return numeric;

  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildExistingLinkKey(source, target) {
  return [source, target].sort().join("\u0000");
}

function buildLinkIndex(links) {
  const index = new Map();
  for (const link of Array.isArray(links) ? links : []) {
    if (!link?.source || !link?.target) continue;
    index.set(buildExistingLinkKey(link.source, link.target), link);
  }
  return index;
}

function sharedConcepts(a, b) {
  const left = new Set(Array.isArray(a.concepts) ? a.concepts : []);
  const right = Array.isArray(b.concepts) ? b.concepts : [];
  return right.filter(concept => left.has(concept)).sort();
}

function addMemoryUpdate(plan, update) {
  if (plan.memoryUpdates.length >= plan.config.maxMemoryUpdates) {
    plan.summary.memoryUpdatesSkipped += 1;
    return;
  }
  plan.memoryUpdates.push(update);
}

function addLinkUpdate(plan, update) {
  if (plan.linkUpdates.length >= plan.config.maxLinkUpdates) {
    plan.summary.linkUpdatesSkipped += 1;
    return;
  }
  plan.linkUpdates.push(update);
}

function planEchoReinforcement(input = {}, options = {}) {
  const config = mergeConfig(options.config);
  const nowMs = finiteNumber(options.nowMs, Date.now());
  const states = Array.isArray(input.states) ? input.states : [];
  const memories = Array.isArray(input.memories) ? input.memories : [];
  const stateByMemoryId = new Map(states.filter(state => state?.memoryId).map(state => [String(state.memoryId), state]));
  const memoryById = new Map(memories.filter(memory => memory?.id).map(memory => [String(memory.id), memory]));
  const linkIndex = buildLinkIndex(input.links);
  const plan = {
    policyVersion: config.version,
    dryRun: true,
    generatedAt: new Date(nowMs).toISOString(),
    config,
    summary: {
      memoryUpdates: 0,
      linkUpdates: 0,
      memoryUpdatesSkipped: 0,
      linkUpdatesSkipped: 0
    },
    memoryUpdates: [],
    linkUpdates: []
  };

  for (const state of states) {
    if (!state?.memoryId) continue;

    const memoryId = String(state.memoryId);
    const echoCount = Math.max(0, finiteNumber(state.echoCount, 0));
    const promotedCount = Math.max(0, finiteNumber(state.promotedCount, 0));
    const suppressedCount = Math.max(0, finiteNumber(state.suppressedCount, 0));
    const ratio = promotedRatio(state);
    const memory = memoryById.get(memoryId);

    if (
      echoCount >= config.minEchoCountForLatentPresence &&
      ratio <= config.maxPromotionRatioForLatentPresence
    ) {
      addMemoryUpdate(plan, {
        memoryId,
        action: "increase_latent_presence",
        delta: config.latentPresenceDelta,
        reason: `echoCount=${echoCount}, promotedRatio=${ratio.toFixed(3)}`
      });
    }

    if (
      promotedCount >= config.minPromotedCountForOrbitLift &&
      ratio >= config.minPromotedRatioForOrbitLift
    ) {
      const currentLevel = memoryLevel(memory);
      addMemoryUpdate(plan, {
        memoryId,
        action: "allow_orbit_lift",
        activationDelta: config.orbitLiftActivationDelta,
        currentOrbitalLevel: currentLevel,
        candidateOrbitalLevel: ORBIT_LIFT[currentLevel] || currentLevel,
        reason: `promotedCount=${promotedCount}, promotedRatio=${ratio.toFixed(3)}`
      });
    }

    if (suppressedCount >= config.minSuppressedCountForInhibition) {
      addMemoryUpdate(plan, {
        memoryId,
        action: "temporary_inhibition",
        inhibitionStrength: config.inhibitionStrength,
        inhibitionUntil: new Date(nowMs + config.temporaryInhibitionMs).toISOString(),
        reason: `suppressedCount=${suppressedCount}`
      });
    }
  }

  for (const memory of memories) {
    if (!memory?.id || stateByMemoryId.has(String(memory.id))) continue;

    const lastSeen = memoryTimestamp(memory);
    if (lastSeen !== null && nowMs - lastSeen < config.dormantAfterMs) continue;

    addMemoryUpdate(plan, {
      memoryId: String(memory.id),
      action: "slow_dormant_decay",
      activationDelta: config.dormantDecayDelta,
      currentActivation: memoryActivation(memory),
      reason: "no_echo_state_observed"
    });
  }

  for (let i = 0; i < states.length; i++) {
    const left = states[i];
    if (!left?.memoryId || finiteNumber(left.echoCount, 0) < config.minEchoCountForCoEcho) continue;

    for (let j = i + 1; j < states.length; j++) {
      const right = states[j];
      if (!right?.memoryId || finiteNumber(right.echoCount, 0) < config.minEchoCountForCoEcho) continue;

      const concepts = sharedConcepts(left, right);
      if (concepts.length < config.minSharedConceptsForCoEcho) continue;

      const link = linkIndex.get(buildExistingLinkKey(left.memoryId, right.memoryId));
      if (link && link.type === "semantic") {
        addLinkUpdate(plan, {
          action: "reinforce_semantic_link",
          linkId: link.id || null,
          source: link.source,
          target: link.target,
          weightDelta: config.semanticLinkDelta,
          sharedConcepts: concepts,
          reason: "frequent_co_echo"
        });
      } else if (!link && config.allowNewSemanticLinkCandidates) {
        addLinkUpdate(plan, {
          action: "candidate_semantic_link",
          source: String(left.memoryId),
          target: String(right.memoryId),
          initialWeight: config.semanticLinkDelta,
          sharedConcepts: concepts,
          reason: "frequent_co_echo"
        });
      }
    }
  }

  plan.summary.memoryUpdates = plan.memoryUpdates.length;
  plan.summary.linkUpdates = plan.linkUpdates.length;

  return plan;
}

function formatEchoReinforcementPlan(plan) {
  const lines = [
    `Echo reinforcement plan ${plan.policyVersion}`,
    `dryRun=${plan.dryRun} generatedAt=${plan.generatedAt}`,
    `memoryUpdates=${plan.summary.memoryUpdates} linkUpdates=${plan.summary.linkUpdates}`
  ];

  for (const update of plan.memoryUpdates) {
    lines.push(`memory ${update.memoryId}: ${update.action} (${update.reason})`);
  }

  for (const update of plan.linkUpdates) {
    lines.push(`link ${update.source}->${update.target}: ${update.action} (${update.reason})`);
  }

  return lines.join("\n");
}

module.exports = {
  DEFAULT_CONFIG,
  mergeConfig,
  planEchoReinforcement,
  formatEchoReinforcementPlan
};
