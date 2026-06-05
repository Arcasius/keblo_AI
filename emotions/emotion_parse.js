import { BASELINE, LABELS } from "./emotion_consts.js";
import { isTechnicalText } from "./emotion_gate.js";

function clamp01(x){ 
  return Math.max(0, Math.min(1, Number(x) || 0)); 
}

function extractFirstJsonObject(str){
  let s = String(str || "").trim();
  s = s.replace(/```json/gi, "").replace(/```/gi, "").trim();

  const start = s.indexOf("{");
  if (start < 0) return null;

  let depth = 0;
  for (let i = start; i < s.length; i++){
    if (s[i] === "{") depth++;
    else if (s[i] === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

export async function parseEmotionFromText(text, callLLM) {
  const SYSTEM = `
Sei un parser emotivo.
Rispondi SOLO con un oggetto JSON valido.
Non aggiungere testo, spiegazioni, markdown, note o commenti.

Formato obbligatorio:
{
  "labels": {
    "stress": 0.0,
    "calm": 0.0,
    "fatigue": 0.0,
    "joy": 0.0,
    "sadness": 0.0,
    "anger": 0.0,
    "urgency": 0.0,
    "focus": 0.0
  },
  "confidence": 0.0
}
`.trim();

  const safeText = String(text || "").slice(0, 800);

  try {
    const tech = isTechnicalText(text);

    if (tech.isTechnical && tech.score >= 7) {
      console.log("[EMA] Testo tecnico forte: skip LLM, baseline.");
      return { labels: { ...BASELINE }, confidence: 0.25 };
    }

    console.log("[EMA] Analisi mood (caratteri inviati:", safeText.length, ")");

    const out = await callLLM(`${SYSTEM}\n\nTESTO_UTENTE:\n${safeText}\n`);
    if (!out) throw new Error("Risposta LLM vuota");

    const jsonStr = extractFirstJsonObject(out);
    if (!jsonStr) {
      console.warn("[EMA] Avviso: JSON non trovato, uso baseline.");
      return { labels: { ...BASELINE }, confidence: 0.25 };
    }

    let parsed;
    try {
      parsed = JSON.parse(jsonStr);
    } catch (e) {
      console.error("[EMA] JSON malformato dall'AI, abortisco parsing.");
      return { labels: { ...BASELINE }, confidence: 0.25 };
    }

    const labels = {};
    for (const k of LABELS){
      labels[k] = clamp01(parsed?.labels?.[k] ?? parsed?.[k] ?? BASELINE[k]);
    }

    let conf = clamp01(parsed?.confidence ?? 0.35);
    conf = Math.max(0.2, Math.min(0.95, conf));

    if (tech.isTechnical) conf = Math.min(conf, 0.35);
    if (tech.score >= 7) conf = Math.min(conf, 0.25);

    const intensity = Math.max(
      ...Object.entries(labels).map(([k, v]) => Math.abs(v - (BASELINE[k] ?? 0)))
    );

    if (intensity >= 0.25 && conf < 0.55) conf = 0.65;
    if (intensity >= 0.40 && conf < 0.65) conf = 0.75;

    console.log("[EMA] Risultato finale:", labels, "Conf:", conf);
    return { labels, confidence: conf };

  } catch (err) {
    console.error("[EMA ERROR CRITICAL]:", err.message);
    return { labels: { ...BASELINE }, confidence: 0.25 };
  }
}