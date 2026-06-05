import { isTechnicalText } from "./emotion_gate.js";
import { shouldUpdateEmotion } from "./emotion_cooldown.js";
import { parseEmotionFromText } from "./emotion_parse.js";
import { updateEmotionState } from "./emotion_update.js";
import { formatEmotionForPrompt } from "./emotion_prompt.js";
import { loadEmotionState } from "./emotion_state.js";

export async function ingestEmotion({ baseDir, userId, text, callLLM }) {
  const policy = { minIntervalMs: 12000, burstWindowMs: 60000, burstMax: 6 };
  const tech = isTechnicalText(text);
  
  // Rate limit
  const cd = shouldUpdateEmotion(baseDir, userId, policy);

  // Se è troppo tecnico, non sporchiamo l'EMA
  if (!cd.ok && tech.isTechnical) {
    return { promptEmotion: { mood_line: "mood=neutral" } };
  }

  const t = text.trim().toLowerCase();
  const smallTalk = t.length <= 10 || /^(ciao|hola|ola|ehi|ok|va bene|grazie|buongiorno|buonasera|buonanotte|come stai)\b/.test(t);

if (smallTalk) {
  // aggiorna EMA comunque? io consiglierei: NO -> usa ultimo mood salvato
  const { state } = loadEmotionState(baseDir, userId);
  const moodLine = formatEmotionForPrompt(state.emotion);
  return { promptEmotion: { mood_line: moodLine }, ema: state.emotion };
}

  // Chiamata ad Ollama
  const parsed = await parseEmotionFromText(text, callLLM);
  
  // Se è codice, abbassiamo la fiducia
  let conf = tech.isTechnical ? Math.min(parsed.confidence, 0.35) : parsed.confidence;

  // Aggiornamento EMA (Il cuore matematico)
  const ema = updateEmotionState(baseDir, userId, parsed.labels, conf,text);
  
  // Trasformiamo i calcoli in una stringa per il prompt
  const moodLine = formatEmotionForPrompt(ema);

  // RITORNIAMO L'OGGETTO COMPLETO
  return {
    promptEmotion: {
      mood_line: moodLine
    },
    ema: ema // per eventuale debug
  };
}