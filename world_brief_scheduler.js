import cron from "node-cron";
import { buildWorldBrief } from "./world_brief.js";

let task = null;

export function startWorldBriefScheduler() {
  if (task) return task;

  task = cron.schedule("5 7 * * *", async () => {
    try {
      console.log("[WORLD BRIEF] Avvio refresh schedulato...");
      const brief = await buildWorldBrief();
      console.log("[WORLD BRIEF] Completato:", brief.counts);
    } catch (err) {
      console.error("[WORLD BRIEF] Errore nel refresh schedulato:", err);
    }
  });

  console.log("[WORLD BRIEF] Scheduler attivo alle 07:05 ogni giorno.");
  return task;
}