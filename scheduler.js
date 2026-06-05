import fs from "fs";
import path from "path";
import { getReminders, updateReminder, addReminder } from "./reminders_repo.js";

const USERS_DIR = path.join(process.cwd(), "storage", "users");

export function startScheduler() {
  setInterval(() => {
    if (!fs.existsSync(USERS_DIR)) return;
    const now = Date.now();
    const users = fs.readdirSync(USERS_DIR);

    for (const userId of users) {
      const reminders = getReminders(userId);
      for (const r of reminders) {
        const due = new Date(r.dueAt).getTime();

        // 🔔 1. EMERSIONE (1h prima)
        if (r.status === "pending" && !r.notifiedBefore && now >= (due - 3600000) && now < due) {
          updateReminder(userId, r.id, { notifiedBefore: true });
        }

        // ⏰ 2. SCADENZA (Ora esatta)
        if (r.status === "pending" && now >= due) {
          updateReminder(userId, r.id, { status: "fired", firedAt: new Date().toISOString() });

          // Se è RICORRENTE, crea già la prossima istanza
          if (r.recurring) {
            const nextDue = new Date(due);
            if (r.recurring.unit === 'hours') nextDue.setHours(nextDue.getHours() + r.recurring.interval);
            if (r.recurring.unit === 'days') nextDue.setDate(nextDue.getDate() + r.recurring.interval);
            
            addReminder(userId, { ...r, id: "r_" + Date.now(), dueAt: nextDue.toISOString(), status: "pending", notifiedBefore: false });
          }
        }

        // 💬 3. FOLLOW-UP (Prepara il feedback 2 ore dopo)
        const twoHoursAfter = due + 7200000;
        if (r.status === "fired" && now >= twoHoursAfter && !r.followUpReady) {
          updateReminder(userId, r.id, { followUpReady: true });
        }
      }
    }
  }, 60000);
}