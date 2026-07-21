const DOMAIN_KEYWORDS = {
  family: [
    "famiglia", "familiare", "figlio", "figlia", "figli", "figlie", "madre", "mamma",
    "padre", "papa", "papà", "fratello", "sorella", "nonno", "nonna", "moglie",
    "marito", "compagno", "compagna", "partner", "parenti"
  ],
  health: [
    "salute", "malattia", "sindrome", "diagnosi", "terapia", "medico", "dottore",
    "ospedale", "farmaco", "farmaci", "dolore", "febbre", "mal", "gola", "schiena",
    "analisi", "visita", "cura", "sintomo", "sintomi", "ansia", "depressione"
  ],
  work: [
    "lavoro", "ufficio", "collega", "colleghi", "cliente", "clienti", "riunione",
    "contratto", "turno", "scadenza", "azienda", "business", "vendita", "fattura"
  ],
  routine: [
    "routine", "abitudine", "cena", "pranzo", "colazione", "spesa", "dormire",
    "sonno", "mangiare", "mangia", "camminare", "allenamento", "pulire", "casa"
  ],
  project: [
    "progetto", "progetti", "roadmap", "milestone", "task", "feature", "release",
    "piano", "obiettivo", "deadline", "sprint", "repository", "repo"
  ],
  place: [
    "casa", "ufficio", "scuola", "ospedale", "citta", "città", "paese", "stazione",
    "aeroporto", "negozio", "ristorante", "parco", "via", "piazza"
  ],
  emotion: [
    "felice", "triste", "preoccupato", "preoccupata", "ansioso", "ansiosa", "paura",
    "gioia", "rabbia", "sereno", "serena", "stanco", "stanca", "stress", "emozione",
    "contento", "contenta", "dispiace", "amore", "odio", "frustrato", "frustrata"
  ],
  finance: [
    "soldi", "denaro", "budget", "spesa", "spese", "conto", "banca", "stipendio",
    "investimento", "investimenti", "mutuo", "prestito", "tasse", "prezzo", "costo"
  ],
  learning: [
    "studiare", "studio", "imparare", "lezione", "corso", "libro", "esame",
    "formazione", "tutorial", "scuola", "universita", "università", "ricerca"
  ],
  technical: [
    "codice", "software", "bug", "debug", "api", "server", "database", "javascript",
    "node", "python", "json", "funzione", "classe", "modulo", "deploy", "test",
    "log", "errore", "repository", "git", "http", "llm", "modello"
  ]
};

const TIME_PATTERNS = [
  { tag: "today", pattern: /\b(oggi|stamattina|stasera|stanotte)\b/i },
  { tag: "tomorrow", pattern: /\b(domani|dopodomani)\b/i },
  { tag: "yesterday", pattern: /\b(ieri|l'altro ieri|altro ieri)\b/i },
  { tag: "recent", pattern: /\b(da poco|recentemente|ultimamente|questa settimana|questo mese)\b/i },
  { tag: "future", pattern: /\b(prossim[oaie]|tra\s+\d+\s+(giorni|settimane|mesi|anni)|fra\s+\d+\s+(giorni|settimane|mesi|anni))\b/i },
  { tag: "past", pattern: /\b(tempo fa|anni fa|mesi fa|settimane fa|scorsa|scorso)\b/i },
  { tag: "date", pattern: /\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/ },
  { tag: "time", pattern: /\b(?:alle|ore)\s+\d{1,2}(?::\d{2})?\b/i }
];

const TONE_PATTERNS = [
  { tag: "positive", pattern: /\b(bene|felice|content[oa]|seren[oa]|ottimo|bella|bello|grazie|perfetto)\b/i },
  { tag: "negative", pattern: /\b(male|triste|preoccupat[oa]|ansios[oa]|paura|stress|stanc[oa]|problema|dolore)\b/i },
  { tag: "urgent", pattern: /\b(urgente|subito|immediatamente|importante|emergenza|devo assolutamente)\b/i },
  { tag: "uncertain", pattern: /\b(forse|non so|credo|penso|probabilmente|dubito)\b/i },
  { tag: "request", pattern: /\b(puoi|potresti|mi aiuti|aiutami|come faccio|spiegami)\b/i }
];

const TRIVIAL_PHRASES = new Set([
  "ciao",
  "salve",
  "buongiorno",
  "buonasera",
  "buonanotte",
  "come stai",
  "ok",
  "okay",
  "grazie",
  "perfetto",
  "va bene"
]);

const STOP_CAPITALIZED = new Set([
  "Io", "Tu", "Lui", "Lei", "Noi", "Voi", "Loro", "Il", "Lo", "La", "I", "Gli", "Le",
  "Un", "Una", "Uno", "E", "Ma", "Però", "Pero", "Poi", "Quando", "Dove", "Come",
  "Cosa", "Che", "Se", "Perché", "Perche", "Oggi", "Ieri", "Domani"
]);

function normalizeText(text) {
  return String(text || "")
    .normalize("NFC")
    .trim()
    .toLowerCase()
    .replace(/[“”]/g, "\"")
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ");
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function includesKeyword(normalizedText, keyword) {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-zà-ÿ0-9])${escaped}([^a-zà-ÿ0-9]|$)`, "i").test(normalizedText);
}

function slug(value) {
  return normalizeText(value)
    .replace(/[^a-z0-9à-ÿ]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function extractEntities(text) {
  const raw = String(text || "");
  const entities = [];
  const occurrences = new Map();
  const sentenceStartIndexes = new Set([0]);
  const sentencePattern = /[.!?]\s+([A-ZÀ-Ý])/g;
  let sentenceMatch;

  while ((sentenceMatch = sentencePattern.exec(raw)) !== null) {
    sentenceStartIndexes.add(sentenceMatch.index + sentenceMatch[0].length - 1);
  }

  const capitalizedPattern = /\b[A-ZÀ-Ý][a-zà-ÿ]+(?:\s+[A-ZÀ-Ý][a-zà-ÿ]+){0,2}\b/g;
  let match;

  while ((match = capitalizedPattern.exec(raw)) !== null) {
    const words = match[0].trim().split(/\s+/);
    const firstWord = words[0];
    const value = STOP_CAPITALIZED.has(firstWord) && words.length > 1
      ? words.slice(1).join(" ")
      : words.join(" ");
    const startsSentence = sentenceStartIndexes.has(match.index);
    const probableSubject = startsSentence && /\s+(ha|è|sta|sono|si|deve|vuole|può|puo|andrà|andra|farà|fara)\b/i.test(raw.slice(match.index + match[0].length));

    if (STOP_CAPITALIZED.has(value) || (STOP_CAPITALIZED.has(firstWord) && words.length === 1)) continue;
    if (startsSentence && !value.includes(" ") && !probableSubject) continue;

    occurrences.set(value, (occurrences.get(value) || 0) + 1);
  }
  for (const [value, count] of occurrences.entries()) {
    entities.push({
      text: value,
      type: count > 1 ? "recurring_proper_noun" : "probable_proper_noun",
      count
    });
  }

  const placePattern = /\b(?:a|ad|in|da|verso|presso|vicino a)\s+([A-ZÀ-Ý][a-zà-ÿ]+(?:\s+[A-ZÀ-Ý][a-zà-ÿ]+){0,2})\b/g;
  while ((match = placePattern.exec(raw)) !== null) {
    const value = match[1].trim();
    const existing = entities.find(entity => entity.text === value);
    if (existing) {
      existing.type = "place";
    } else if (!STOP_CAPITALIZED.has(value.split(/\s+/)[0])) {
      entities.push({ text: value, type: "place", count: 1 });
    }
  }

  return entities;
}

function detectDomains(text) {
  const normalized = normalizeText(text);
  const domains = [];

  for (const [domain, keywords] of Object.entries(DOMAIN_KEYWORDS)) {
    if (keywords.some(keyword => includesKeyword(normalized, keyword))) {
      domains.push(domain);
    }
  }

  return domains;
}

function detectTimeHints(text) {
  const raw = String(text || "");
  return TIME_PATTERNS
    .filter(({ pattern }) => pattern.test(raw))
    .map(({ tag }) => tag);
}

function detectToneHints(text) {
  const raw = String(text || "");
  return TONE_PATTERNS
    .filter(({ pattern }) => pattern.test(raw))
    .map(({ tag }) => tag);
}

function isTrivialText(normalizedText, signals) {
  const compact = normalizedText.replace(/[.!?]+$/g, "");
  const hasSignal = signals.entities.length > 0 || signals.domains.length > 0 || signals.timeHints.length > 0;

  return TRIVIAL_PHRASES.has(compact) || (compact.length < 20 && !hasSignal);
}

function estimateImportance(signals) {
  if (signals.isTrivial) return 0.1;

  const domains = new Set(signals.domains);
  let importance = 0.5;

  if (domains.has("health")) importance += signals.entities.length > 0 ? 0.35 : 0.2;
  if (domains.has("project") && domains.has("technical")) importance += 0.2;
  if (domains.has("family") && domains.has("emotion")) importance += 0.2;
  if (domains.has("finance") || domains.has("work")) importance += 0.1;
  if (signals.timeHints.includes("future") || signals.toneHints.includes("urgent")) importance += 0.1;
  if (signals.entities.length >= 2) importance += 0.05;
  if (signals.toneHints.includes("negative")) importance += 0.05;

  return Math.max(0.1, Math.min(0.95, Number(importance.toFixed(2))));
}

function determineMemoryDepth(importance, signals) {
  const domains = new Set(signals.domains || []);

  if (signals.isTrivial || importance < 0.3) return "temporary";
  if (domains.has("health") && (signals.entities || []).length > 0) return "deep";
  if (domains.has("project") && domains.has("technical")) return importance >= 0.7 ? "deep" : "normal";
  if (domains.has("family") && domains.has("emotion")) return importance >= 0.7 ? "deep" : "normal";
  if (importance >= 0.75) return "deep";

  return "normal";
}

function extractMemorySignals(text) {
  const normalizedText = normalizeText(text);
  const entities = extractEntities(text);
  const domains = detectDomains(text);
  const timeHints = detectTimeHints(text);
  const toneHints = detectToneHints(text);
  const baseSignals = { normalizedText, entities, domains, timeHints, toneHints };
  const isTrivial = isTrivialText(normalizedText, baseSignals);
  const importance = estimateImportance({ ...baseSignals, isTrivial });
  const memoryDepth = determineMemoryDepth(importance, { ...baseSignals, isTrivial });
  const tags = unique([
    ...domains,
    ...timeHints.map(hint => `time_${hint}`),
    ...toneHints.map(hint => `tone_${hint}`),
    ...entities.map(entity => `entity_${slug(entity.text)}`),
    isTrivial ? "temporary" : null
  ]);

  return {
    normalizedText,
    entities,
    domains,
    timeHints,
    toneHints,
    tags,
    importance,
    memoryDepth,
    isTrivial
  };
}

module.exports = {
  normalizeText,
  extractEntities,
  detectDomains,
  detectTimeHints,
  detectToneHints,
  estimateImportance,
  determineMemoryDepth,
  extractMemorySignals
};
