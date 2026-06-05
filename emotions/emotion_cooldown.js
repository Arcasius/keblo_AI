import fs from "fs";
import path from "path";

export function shouldUpdateEmotion(baseDir, userId, policy){
  const file = path.join(baseDir, "storage", "users", userId, "state", "emotion_cooldown.json");
  let data;
  try { data = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { data = { lastUpdateMs: 0, burstCount: 0, windowStartMs: 0 }; }
  
  const t = Date.now();
  if (!data.windowStartMs || (t - data.windowStartMs) > policy.burstWindowMs){
    data.windowStartMs = t; data.burstCount = 0;
  }
  const sinceLast = t - (data.lastUpdateMs || 0);
  const ok = sinceLast >= policy.minIntervalMs && data.burstCount < policy.burstMax;
  if (ok){
    data.lastUpdateMs = t; data.burstCount += 1;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data), "utf8");
  }
  return { ok };
}