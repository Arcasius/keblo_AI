import fs from "fs";
import path from "path";
import { LABELS, BASELINE } from "./emotion_consts.js";

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

  state.emotion.short ??= { tau_min: 20, ema: { ...BASELINE } };
  state.emotion.mid   ??= { tau_min: 180, ema: { ...BASELINE } };
  state.emotion.long  ??= { tau_min: 10080, ema: { ...BASELINE } };
  state.emotion.mean  ??= { tau_min: 43200, ema: { ...BASELINE } };

  state.emotion.short.ema = ensureEmaLabels(state.emotion.short.ema, labels, BASELINE);
  state.emotion.mid.ema   = ensureEmaLabels(state.emotion.mid.ema,   labels, BASELINE);
  state.emotion.long.ema  = ensureEmaLabels(state.emotion.long.ema,  labels, BASELINE);
  state.emotion.mean.ema  = ensureEmaLabels(state.emotion.mean.ema,  labels, BASELINE);

  state.emotion.dominant ??= [];
  state.emotion.delta_vs_mean ??= {};

  return state;
}

export function loadEmotionState(baseDir, userId){
  const file = path.join(baseDir, "storage", "users", userId, "state", "emotion_state.json");
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return { file, state: normalizeEmotionState(data, userId) };
  } catch {
    const init = normalizeEmotionState(null, userId);
    return { file, state: init };
  }
}

// save ATOMICO (anti-file corrotto)
export function saveEmotionState(file, state){
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(tmp, file);
}
