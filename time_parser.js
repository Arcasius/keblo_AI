function setTimeFromText(d, t) {
  const hm = t.match(/(?:alle\s+)?(\d{1,2})(?::(\d{2}))?/);
  if (hm) {
    let h = parseInt(hm[1], 10);
    const m = hm[2] ? parseInt(hm[2], 10) : 0;
    if (h >= 0 && h < 24) {
      d.setHours(h, m, 0, 0);
      return true;
    }
  }
  return false;
}

export function parseDueDate(text) {
  const now = new Date();
  const t = (text || "").toLowerCase().trim();
  let d = new Date(now);
  let isRecurring = null;

  // 🔄 1. Ricorrenze: "ogni X ore" o "ogni giorno"
  const everyH = t.match(/ogni\s+(\d+)\s+ore/);
  if (everyH) {
    const hours = parseInt(everyH[1], 10);
    d.setHours(d.getHours() + hours);
    return { date: d, recurring: { interval: hours, unit: 'hours' } };
  }
  if (t.includes("ogni giorno") || t.includes("quotidianamente")) {
    isRecurring = { interval: 1, unit: 'days' };
  }

  // 📅 2. Giorni specifici
  let dayFound = false;
  if (t.includes("dopodomani")) { d.setDate(d.getDate() + 2); dayFound = true; }
  else if (t.includes("domani")) { d.setDate(d.getDate() + 1); dayFound = true; }
  else if (t.includes("oggi")) { dayFound = true; }

  // Giorno settimana
  const days = { "lunedì": 1, "lunedi": 1, "martedì": 2, "martedi": 2, "mercoledì": 3, "mercoledi": 3, "giovedì": 4, "giovedi": 4, "venerdì": 5, "venerdi": 5, "sabato": 6, "domenica": 0 };
  for (const [name, idx] of Object.entries(days)) {
    if (t.includes(name)) {
      const diff = (idx + 7 - d.getDay()) % 7 || 7;
      d.setDate(d.getDate() + diff);
      dayFound = true; break;
    }
  }

  const hasTime = setTimeFromText(d, t);
  
  // LOGICA TESTER: Se l'ora è passata oggi, sposta a domani
  if (hasTime && !dayFound) {
    if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
  }

  if (!dayFound && !hasTime) return null;
  if (dayFound && !hasTime) {
    d.setHours(t.includes("oggi") ? now.getHours() + 1 : 9, 0, 0, 0);
  }

  return { date: d, recurring: isRecurring };
}