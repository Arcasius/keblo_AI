// cards.js - versione migliorata
export function maybeShowCard(text, state) {
  const t = (text || "").trim().toLowerCase();

  // Escludi contesti di conferma/annullamento
  if (state && state.activeCard) {
    const confirmWords = ["si", "sì", "conferma", "ok", "va bene", "yes", "no", "annulla", "cancella"];
    if (confirmWords.includes(t)) {
      return null;
    }
  }

  // 🔎 RICERCA
  if (t.startsWith("cerca") || t.startsWith("trova") || t.startsWith("ricerca")) {
    return {
      type: "search",
      title: "Ricerca",
      content: text,
      status: "pending"
    };
  }

  // 📰 NEWS
  if (t.includes("news") || t.includes("novità") || t.includes("aggiornami")) {
    return {
      type: "news",
      title: "News",
      content: text,
      status: "pending"
    };
  }
  // In cards.js
  if (t.includes("carica file") || t.includes("analizza documento") || t.includes("leggi pdf")) {
    return {
      type: "file_upload",
      title: "Carica I Tuoi File",
      content: "Seleziona un file (PDF, TXT, DOCX) per la tua sandbox.",
      status: "pending"
    };
  }

  // ⏰ PROMEMORIA (tutto ciò che sembra un promemoria)
  /*const reminderPatterns = [
    /\b(promemoria|ricordami|ricorda|avvisami|fammi ricordare)\b/,
    /\b(ho un|ho una|ho lo|devo)\s+(promemoria|appuntamento|riunione|evento)/,
    /\b(domani|oggi|lunedì|martedì|mercoledì|giovedì|venerdì|sabato|domenica)\b/,
    /\b(alle|a mezzogiorno|a mezzanotte|di mattina|di pomeriggio|di sera)\b/,
    /\b(per domani|per oggi|per stasera|per mattina)\b/
  ];

  const isReminder = reminderPatterns.some(pattern => pattern.test(t));
  
  if (isReminder) {
    return {
      type: "reminder",  // SEMPRE "reminder" non "event"
      title: "Appuntamenti - Eventi - Promemoria",
      content: text,
      status: "pending"
    };
  }*/

  return null;
}