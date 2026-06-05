import fs from "fs";
import path from "path";
import { LABELS, BASELINE, TAU } from "./emotion_consts.js";

function nowISO(){ return new Date().toISOString(); }

function ensureEmaLabels(ema, labels, fallback){
  const out = { ...(ema || {}) };
  for (const k of labels) if (out[k] == null) out[k] = fallback[k] ?? 0;
  return out;
}

function normalizeEmotionState(state, userId){
  const labels = state?.emotion?.labels ?? LABELS;
  state ??= {};
  state.v ??= 1;
  state.userId ??= userId;
  state.updatedAt ??= nowISO();
  state.emotion ??= {};
  state.emotion.labels ??= labels;
  state.emotion.raw_last ??= { ...BASELINE };
  state.emotion.confidence ??= 0;
  state.emotion.short ??= { tau_min: TAU.short, ema: { ...BASELINE } };
  state.emotion.mid   ??= { tau_min: TAU.mid,   ema: { ...BASELINE } };
  state.emotion.long  ??= { tau_min: TAU.long,  ema: { ...BASELINE } };
  state.emotion.mean  ??= { tau_min: TAU.mean,  ema: { ...BASELINE } };
  state.emotion.short.ema = ensureEmaLabels(state.emotion.short.ema, labels, BASELINE);
  state.emotion.mid.ema   = ensureEmaLabels(state.emotion.mid.ema,   labels, BASELINE);
  state.emotion.long.ema  = ensureEmaLabels(state.emotion.long.ema,  labels, BASELINE);
  state.emotion.mean.ema  = ensureEmaLabels(state.emotion.mean.ema,  labels, BASELINE);
  state.emotion.dominant ??= ["neutral"];
  state.emotion.delta_vs_mean ??= {};
  return state;
}

export function emotionStatePath(baseDir, userId){
  return path.join(baseDir, "storage", "users", userId, "state", "emotion_state.json");
}

export function saveAtomic(file, obj){
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

export function withFileLock(lockFile, fn, { timeoutMs=1500, retryMs=35 } = {}){
  const start = Date.now();
  while (true){
    try {
      const fd = fs.openSync(lockFile, "wx");
      try { return fn(); } finally {
        try { fs.closeSync(fd); } catch {}
        try { fs.unlinkSync(lockFile); } catch {}
      }
    } catch (e){
      if (Date.now() - start > timeoutMs) return fn();
      const end = Date.now() + retryMs;
      while (Date.now() < end) {}
    }
  }
}

export function loadEmotionState(baseDir, userId){
  const file = emotionStatePath(baseDir, userId);
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return { file, state: normalizeEmotionState(data, userId) };
  } catch {
    return { file, state: normalizeEmotionState(null, userId) };
  }
}