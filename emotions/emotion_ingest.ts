import { parseEmotionFromText } from "./emotion_parse.js";
import { updateEmotionState } from "./emotion_update.js";

export async function ingestEmotionFromUserText(baseDir, userId, text, callLLM){
  const parsed = await parseEmotionFromText(text, callLLM);
  const ema = updateEmotionState(baseDir, userId, parsed.labels, parsed.confidence);
  return { parsed, ema };
}
