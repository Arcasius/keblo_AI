import { BASELINE } from "./emotion_consts.js";

function clamp01(x){ return Math.max(0, Math.min(1, Number(x) || 0)); }
function expDecay(dtMin, tauMin){ return Math.exp(-dtMin / tauMin); }

export function updateBucket({ ema, raw, target, dtMin, tauMin, alpha }){
  const decay = expDecay(dtMin, tauMin);
  const next = {};
  for (const k of Object.keys(raw)) {
    const e = ema[k];
    const t = target[k];
    const r = raw[k];

    // 1) torna lentamente al target (decay)
    const decayed = e * decay + t * (1 - decay);

    // 2) fonde con raw (alpha “quanto mi fido del raw”)
    const fused = decayed * (1 - alpha) + r * alpha;

    next[k] = clamp01(fused);
  }
  return next;
}

export function computeDtMin(prevUpdatedAtISO){
  const prevAt = Date.parse(prevUpdatedAtISO);
  const nowAt = Date.now();
  if (!Number.isFinite(prevAt)) return 9999; // se data rotta, riallinea
  return Math.max(0.1, (nowAt - prevAt) / 60000);
}

export function clampRawToLabels(rawInput, labels){
  const raw = {};
  for (const k of labels) raw[k] = clamp01(rawInput?.[k] ?? BASELINE[k] ?? 0);
  return raw;
}
