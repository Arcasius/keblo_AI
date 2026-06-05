import { BASELINE } from "./emotion_consts.js";

// Forza il valore tra 0 e 1
export function clamp01(x){
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

// Calcola il decadimento esponenziale
export function expDecay(dtMin, tauMin){
  return Math.exp(-dtMin / Math.max(1e-6, tauMin));
}

// Calcola quanti minuti sono passati dall'ultimo aggiornamento
export function computeDtMin(prevISO){
  const prevAt = Date.parse(prevISO);
  const nowAt = Date.now();
  if (!Number.isFinite(prevAt)) return 9999;
  return Math.max(0.1, (nowAt - prevAt) / 60000);
}

// --- QUESTA È LA FUNZIONE CHE MANCAVA ---
export function clampRawToLabels(rawInput, labels){
  const raw = {};
  for (const k of labels) {
    raw[k] = clamp01(rawInput?.[k] ?? BASELINE[k] ?? 0);
  }
  return raw;
}

// Converte la confidenza del parser in "fiducia" del sistema
export function confidenceToTrust(conf){
  const c = clamp01(conf);
  return clamp01((c - 0.10) / 0.90);
}

export function blend(a,b,t){ return a*(1-t) + b*t; }

// Modula il peso del nuovo dato in base alla fiducia
export function trustRaw(raw, targetBase, trust){
  const out = {};
  for (const k of Object.keys(raw)){
    out[k] = clamp01(blend(targetBase[k], raw[k], trust));
  }
  return out;
}

// Calcola il nuovo valore del "secchio" (bucket) EMA
export function updateBucket({ ema, raw, target, dtMin, tauMin, alpha }){
  const decay = expDecay(dtMin, tauMin);
  const next = {};
  for (const k of Object.keys(raw)) {
    const e = ema[k];
    const t = target[k];
    const r = raw[k];

    const decayed = e * decay + t * (1 - decay);
    const fused = decayed * (1 - alpha) + r * alpha;
    next[k] = clamp01(fused);
  }
  return next;
}