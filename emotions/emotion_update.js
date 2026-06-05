import { BASELINE, ALPHAS, DOMINANT_THRESHOLD, NEUTRAL_BAND } from "./emotion_consts.js";
import { loadEmotionState, saveAtomic, withFileLock } from "./emotion_store.js";
import {
  clamp01,
  computeDtMin,
  clampRawToLabels,
  confidenceToTrust,
  trustRaw,
  updateBucket
} from "./emotion_math.js";

function normalizeText(text = "") {
  return String(text).toLowerCase().trim();
}

function isPositiveClosure(text = "") {
  const t = normalizeText(text);
  return /^(ok|ok grazie|grazie|grazie mille|perfetto|chiaro|va bene|tutto chiaro|ottimo)[!. ]*$/.test(t);
}

function isNeutralInformative(text = "") {
  const t = normalizeText(text);

  if (!t) return false;
  if (isPositiveClosure(t)) return false;

  const definitional =
    t.includes("che cos") ||
    t.includes("cosa e") ||
    t.includes("cosa è") ||
    t.includes("cosa sono") ||
    t.includes("che significa") ||
    t.includes("qual è") ||
    t.includes("qual e");

  const shortQuestion = t.includes("?") && t.length < 140;

  return definitional || shortQuestion;
}

function applyTurnOverride(raw, text) {
  const out = { ...raw };

  if (isPositiveClosure(text)) {
    out.stress = Math.min(out.stress ?? 0, 0.08);
    out.anger = Math.min(out.anger ?? 0, 0.04);
    out.sadness = Math.min(out.sadness ?? 0, 0.04);
    out.urgency = Math.min(out.urgency ?? 0, 0.05);
    out.fatigue = Math.min(out.fatigue ?? 0, 0.10);

    out.calm = Math.max(out.calm ?? 0, 0.55);
    out.joy = Math.max(out.joy ?? 0, 0.30);
  }

  if (isNeutralInformative(text)) {
    out.stress = Math.min(out.stress ?? 0, 0.12);
    out.anger = Math.min(out.anger ?? 0, 0.05);
    out.sadness = Math.min(out.sadness ?? 0, 0.06);
    out.urgency = Math.min(out.urgency ?? 0, 0.08);

    out.focus = Math.max(out.focus ?? 0, 0.28);
    out.calm = Math.max(out.calm ?? 0, 0.22);
  }

  return out;
}

function getDominantLabels(shortNext, labels) {
  const sorted = [...labels].sort((a, b) => shortNext[b] - shortNext[a]);
  const top = sorted[0];

  if ((shortNext[top] ?? 0) < DOMINANT_THRESHOLD) {
    return ["neutral"];
  }

  const second = sorted[1];
  if (second && Math.abs((shortNext[top] ?? 0) - (shortNext[second] ?? 0)) <= NEUTRAL_BAND) {
    return [top, second];
  }

  return [top];
}

export function updateEmotionState(baseDir, userId, rawInput, conf, sourceText = "") {
  const lockFile = `${baseDir}/storage/users/${userId}/state/.emotion.lock`;

  return withFileLock(lockFile, () => {
    const { file, state } = loadEmotionState(baseDir, userId);
    const labels = state.emotion.labels;

    let raw = clampRawToLabels(rawInput, labels);
    raw = applyTurnOverride(raw, sourceText);

    const dtMin = computeDtMin(state.updatedAt);
    const trust = confidenceToTrust(conf);

    const meanNext = updateBucket({
      ema: state.emotion.mean.ema,
      raw,
      target: BASELINE,
      dtMin,
      tauMin: state.emotion.mean.tau_min,
      alpha: ALPHAS.mean
    });

    const positiveClosure = isPositiveClosure(sourceText);
    const neutralTurn = isNeutralInformative(sourceText);

    let effectiveTrust = trust;
    if (positiveClosure) {
      effectiveTrust = Math.max(trust, 0.85);
    } else if (neutralTurn) {
      effectiveTrust = Math.max(trust, 0.70);
    }

    const rawTrusted = trustRaw(raw, meanNext, effectiveTrust);

    const shortNext = updateBucket({
      ema: state.emotion.short.ema,
      raw: rawTrusted,
      target: meanNext,
      dtMin,
      tauMin: state.emotion.short.tau_min,
      alpha: positiveClosure ? Math.max(ALPHAS.short, 0.78) : ALPHAS.short
    });

    const midNext = updateBucket({
      ema: state.emotion.mid.ema,
      raw: rawTrusted,
      target: meanNext,
      dtMin,
      tauMin: state.emotion.mid.tau_min,
      alpha: neutralTurn ? Math.max(ALPHAS.mid, 0.55) : ALPHAS.mid
    });

    const longNext = updateBucket({
      ema: state.emotion.long.ema,
      raw: rawTrusted,
      target: meanNext,
      dtMin,
      tauMin: state.emotion.long.tau_min,
      alpha: ALPHAS.long
    });

    const dominant = getDominantLabels(shortNext, labels);

    state.updatedAt = new Date().toISOString();
    state.emotion.mean.ema = meanNext;
    state.emotion.short.ema = shortNext;
    state.emotion.mid.ema = midNext;
    state.emotion.long.ema = longNext;
    state.emotion.dominant = dominant;
    state.emotion.confidence = clamp01(conf);
    state.emotion.raw_last = raw;

    saveAtomic(file, state);
    return state.emotion;
  });
}