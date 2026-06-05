import { isTechnicalText } from "./emotion_gate.js";
import { shouldUpdateEmotion } from "./emotion_cooldown.js";
import { parseEmotionFromText } from "./emotion_parse.js";
import { updateEmotionState } from "./emotion_update.js";
import { formatEmotionForPrompt } from "./emotion_prompt.js";

export async function ingestEmotion({ baseDir, userId, text, callLLM }) {
  const policy = { minIntervalMs: 12000, burstWindowMs: 60000, burstMax: 6 };
  const tech = isTechnicalText(text);
  const cd = shouldUpdateEmotion(baseDir, userId, policy);

  if (!cd.ok && tech.isTechnical) return "mood=neutral";

  const parsed = await parseEmotionFromText(text, callLLM);
  let conf = tech.isTechnical ? Math.min(parsed.confidence, 0.35) : parsed.confidence;

  const ema = updateEmotionState(baseDir, userId, parsed.labels, conf,text);
  return formatEmotionForPrompt(ema);
}