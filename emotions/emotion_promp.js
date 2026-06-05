export function formatEmotionForPrompt(ema){
  if (!ema) return "mood=neutral";
  const dominant = ema.dominant || ["neutral"];
  const moodLine = dominant[0] === "neutral" ? "mood=neutral" : `mood=${dominant.join("+")}`;
  return moodLine;
}