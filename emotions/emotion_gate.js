export function isTechnicalText(text=""){
  const s = String(text).trim();
  if (!s) return { isTechnical:false, score:0 };
  let score = 0;
  if (s.includes("```")) score += 3;
  const errWords = /\b(error|exception|traceback|stack|failed|fatal|cannot|undefined|null)\b/i;
  if (errWords.test(s)) score += 2;
  const jsWords = /\b(const|let|var|function|import|export|async|await)\b/;
  if (jsWords.test(s)) score += 2;
  const symbolRatio = (s.replace(/[A-Za-z0-9\s]/g, "").length) / Math.max(1, s.length);
  if (symbolRatio > 0.22) score += 2;
  return { isTechnical: score >= 4, score };
}