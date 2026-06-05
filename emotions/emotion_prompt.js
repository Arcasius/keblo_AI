import { LABELS } from "./emotion_consts.js";

function clamp01(x){ return Math.max(0, Math.min(1, Number(x) || 0)); }

function pickTopDrift(shortEma, meanEma, n=3, minAbs=0.10){
  const items = (LABELS || Object.keys(shortEma || {})).map(k => {
    const s = clamp01(shortEma?.[k] ?? 0);
    const m = clamp01(meanEma?.[k] ?? 0);
    const d = s - m;
    return { k, d, abs: Math.abs(d) };
  }).filter(x => x.abs >= minAbs);

  items.sort((a,b)=> b.abs - a.abs);
  return items.slice(0,n);
}

function arrow(d){
  if (d > 0.02) return "↑";
  if (d < -0.02) return "↓";
  return "=";
}

export function formatEmotionForPrompt(ema){
  // accetta:
  // - state.emotion
  // - state (con .emotion)
  const root = ema?.emotion ? ema.emotion : ema;
  if (!root) return "mood=neutral";

  const dominant = Array.isArray(root.dominant) ? root.dominant : ["neutral"];
  if (!dominant.length || dominant[0] === "neutral") return "mood=neutral";

  // short/mean in shape: root.short.ema / root.mean.ema
  const shortEma = root?.short?.ema || {};
  const meanEma  = root?.mean?.ema || {};

  const driftParts = pickTopDrift(shortEma, meanEma, 3, 0.06)
    .map(x => `${x.k}${arrow(x.d)}`);

  // confidence può stare qui (root.confidence) o in root.meta.confidence (dipende dalla tua impl)
  const conf = clamp01(
    root?.confidence ??
    root?.meta?.confidence ??
    0
  );

  return `mood=${dominant.join("+")}${driftParts.length ? `, drift: ${driftParts.join(" ")}` : ""}, conf=${conf.toFixed(2)}`;
}
