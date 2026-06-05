const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

function now() {
  return Date.now();
}

function timestampToMs(timestamp) {
  if (timestamp == null) return null;
  if (typeof timestamp === "number" && Number.isFinite(timestamp)) return timestamp;
  if (timestamp instanceof Date) {
    const value = timestamp.getTime();
    return Number.isFinite(value) ? value : null;
  }
  if (typeof timestamp === "string") {
    const numeric = Number(timestamp);
    if (Number.isFinite(numeric) && timestamp.trim() !== "") return numeric;
    const parsed = Date.parse(timestamp);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function getMemoryTimestamp(memory) {
  return (
    memory?.timestamp ??
    memory?.meta?.timestamp ??
    memory?.orbital?.birth ??
    memory?.created_at ??
    memory?.createdAt ??
    null
  );
}

function getAgeMs(timestamp) {
  const value = timestampToMs(timestamp);
  if (value == null) return 0;
  return Math.max(0, now() - value);
}

function isYesterday(timestampMs) {
  const current = new Date(now());
  const target = new Date(timestampMs);
  const yesterday = new Date(current);
  yesterday.setDate(current.getDate() - 1);
  return target.getFullYear() === yesterday.getFullYear() && target.getMonth() === yesterday.getMonth() && target.getDate() === yesterday.getDate();
}

function isToday(timestampMs) {
  const current = new Date(now());
  const target = new Date(timestampMs);
  return target.getFullYear() === current.getFullYear() && target.getMonth() === current.getMonth() && target.getDate() === current.getDate();
}

function pluralize(value, singular, plural) {
  return `${value} ${value === 1 ? singular : plural} fa`;
}

function formatTimeAgo(timestamp) {
  const timestampMs = timestampToMs(timestamp);
  if (timestampMs == null) return "adesso";
  const ageMs = getAgeMs(timestampMs);

  if (ageMs < MINUTE_MS) return "adesso";
  if (ageMs < HOUR_MS) return pluralize(Math.floor(ageMs / MINUTE_MS), "minuto", "minuti");
  if (ageMs < 6 * HOUR_MS) return pluralize(Math.floor(ageMs / HOUR_MS), "ora", "ore");
  if (isToday(timestampMs)) return "oggi";
  if (isYesterday(timestampMs)) return "ieri";
  if (ageMs < WEEK_MS) return pluralize(Math.floor(ageMs / DAY_MS), "giorno", "giorni");
  return pluralize(Math.floor(ageMs / WEEK_MS), "settimana", "settimane");
}

function normalizeText(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

const QUESTION_PATTERNS = [
  /\bti\s+ricordi\b/,
  /\bricordi\b/,
  /\bsai\s+se\b/,
  /\bpuoi\s+dirmi\b/,
  /\bmi\s+dici\b/,
  /\bsecondo\s+te\b/,
  /\bche\s+ne\s+pensi\b/,
  /\bposso\s+farti\s+una\s+domanda\b/,
  /\bla\s+domanda\s+e\b/,
  /\bla\s+domanda\s+vera\s+e\b/,
  /\bdevo\s+ancora\b/,
  /\bdobbiamo\s+ancora\b/,
  /\bsono\s+ancora\b/,
  /\bsiamo\s+ancora\b/,
  /\be\s+ancora\b/,
  /\bquando\b/,
  /\bdove\b/,
  /\bcosa\b/,
  /\bcome\b/,
  /\bperche\b/,
  /\bquanto\b/,
  /\bquale\b/,
  /\bquali\b/,
  /\bchi\b/
];

function isQuestion(text) {
  const source = String(text || "");
  if (source.includes("?")) return true;
  return includesAny(normalizeText(source), QUESTION_PATTERNS);
}

function memoryText(memory) {
  return memory?.content?.text || memory?.text || "";
}

function normalizeRoleValue(value) {
  const normalized = normalizeText(value).trim();
  if (["user", "utente", "human"].includes(normalized)) return "user";
  if (["assistant", "assistente", "ai", "bot"].includes(normalized)) return "assistant";
  if (normalized === "system") return "system";
  return null;
}

function normalizeMemoryRole(memory) {
  const candidates = [
    memory?.role,
    memory?.meta?.role,
    memory?.content?.role,
    memory?.sender,
    memory?.author,
    memory?.source
  ];

  for (const candidate of candidates) {
    const role = normalizeRoleValue(candidate);
    if (role) return role;
  }

  if (Array.isArray(memory?.tags)) {
    for (const tag of memory.tags) {
      const role = normalizeRoleValue(tag);
      if (role) return role;
    }
  }

  return "unknown";
}

function includesAny(text, patterns) {
  return patterns.some(pattern => pattern.test(text));
}

const COMPLETED_PATTERNS = [
  /\bho\s+finito\b/,
  /\babbiamo\s+finito\b/,
  /\bsiamo\s+tornati\b/,
  /\bsono\s+tornato\b/,
  /\bsiamo\s+rientrati\b/,
  /\bsono\s+rientrato\b/,
  /\be\s+passato\b/,
  /\bsta\s+meglio\b/,
  /\brisolto\b/,
  /\bho\s+chiamato\b/,
  /\babbiamo\s+chiamato\b/,
  /\bho\s+sentito\b/,
  /\babbiamo\s+sentito\b/,
  /\bho\s+parlato\b/,
  /\babbiamo\s+parlato\b/,
  /\bsono\s+andato\b/,
  /\bsiamo\s+andati\b/,
  /\bappuntamento\s+fatto\b/,
  /\bviaggio\s+finito\b/
];

const FUTURE_PATTERNS = [
  /\bdomani\b/,
  /\bdevo\b/,
  /\bdobbiamo\b/,
  /\bandremo\b/,
  /\bfaremo\b/,
  /\bpartiremo\b/,
  /\bsto\s+per\b/,
  /\bho\s+da\b/
];

const CURRENT_PATTERNS = [
  /\bora\b/,
  /\badesso\b/,
  /\boggi\b/,
  /\bsto\b/,
  /\bsta\b/,
  /\bsiamo\b/,
  /\bsono\s+qui\b/,
  /\bsiamo\s+qui\b/,
  /\bha\s+la\b/
];

const PAST_PATTERNS = [
  /\bieri\b/,
  /\bdue\s+giorni\s+fa\b/,
  /\bla\s+settimana\s+scorsa\b/,
  /\bho\s+visto\b/,
  /\bsono\s+stato\b/,
  /\bsono\s+stata\b/,
  /\bho\s+fatto\b/,
  /\babbiamo\s+fatto\b/
];

const ASSISTANT_SUMMARY_OR_NEGATION_PATTERNS = [
  /\bnon\s+devi\s+piu\b/,
  /\bnon\s+e\s+piu\b/,
  /\bhai\s+gia\s+detto\b/,
  /\bsei\s+gia\s+tornat[oa]\b/,
  /\be\s+gia\s+stato\s+fatto\b/,
  /\bhai\s+appena\s+detto\b/
];

function classifyTemporalIntent(text, role = "unknown") {
  const normalized = normalizeText(text);

  if (isQuestion(text)) return "query";

  if (role === "assistant" && includesAny(normalized, ASSISTANT_SUMMARY_OR_NEGATION_PATTERNS)) {
    if (/\b(tornat[oa]|rientrat[oa]|fatto|finito)\b/.test(normalized)) return "completed_event";
    return "generic";
  }

  if (includesAny(normalized, COMPLETED_PATTERNS)) return "completed_event";
  if (role === "assistant" && /\b(sei|siete|e)\s+gia\b/.test(normalized) && /\b(tornat[oa]|rientrat[oa]|fatto|finito)\b/.test(normalized)) return "completed_event";
  if (includesAny(normalized, PAST_PATTERNS)) return "past_event";
  if (includesAny(normalized, FUTURE_PATTERNS)) return role === "assistant" ? "generic" : "future_intent";
  if (includesAny(normalized, CURRENT_PATTERNS)) return "current_state";
  return "generic";
}
function classifyTemporalValidity(intent, ageHours) {
  if (intent === "query") return "query";
  if (intent === "past_event") return "historical";
  if (intent === "completed_event") return "completed";
  if (intent === "current_state") return ageHours > 24 ? "stale" : "current";
  if (intent === "future_intent") return ageHours > 36 ? "expired_future" : "future_pending";
  if (ageHours < 24) return "recent";
  if (ageHours > 72) return "stale";
  return "recent";
}

function temporalNoteFor(intent, validity) {
  if (validity === "query") return "Nota: domanda o richiesta; usare come query, non come fatto attuale.";
  if (validity === "expired_future") return "Nota: intenzione futura probabilmente scaduta.";
  if (validity === "future_pending") return "Nota: intenzione futura ancora potenzialmente pendente.";
  if (validity === "stale") return "Nota: stato non confermato da piu di 24 ore.";
  if (validity === "historical") return "Nota: evento passato, non stato attuale.";
  if (validity === "completed") return "Nota: evento concluso o stato aggiornato.";
  if (validity === "superseded") return "Nota: memoria probabilmente superata da un aggiornamento più recente.";
  if (intent === "generic") return "Nota: valore temporale non esplicito.";
  return "";
}

function classifyTemporalState(text, timestamp, role = "unknown") {
  const intent = classifyTemporalIntent(text, role);
  if (intent === "query") return "query";
  if (intent === "completed_event") return "completed";
  if (intent === "future_intent") return "future_intent";
  if (intent === "current_state") return "current";
  if (intent === "past_event") return "past";
  return getAgeMs(timestamp) >= DAY_MS ? "past" : "current";
}

function getEntityTokens(memory) {
  const tokens = new Set();
  const add = value => {
    const normalized = normalizeText(value).trim();
    if (normalized && normalized.length >= 3) tokens.add(normalized);
  };

  const text = memoryText(memory);
  const matches = text.match(/\b[A-ZÀ-ÖØ-Þ][\p{L}'-]{2,}\b/gu) || [];
  matches.forEach(add);

  if (Array.isArray(memory?.content?.entities)) memory.content.entities.forEach(entity => add(entity?.text || entity));
  if (Array.isArray(memory?.entities)) memory.entities.forEach(entity => add(entity?.text || entity));
  if (Array.isArray(memory?.tags)) memory.tags.forEach(add);

  return Array.from(tokens);
}

function domainTokens(memory) {
  const tokens = new Set();
  const add = value => {
    const normalized = normalizeText(value).trim();
    if (normalized && normalized.length >= 3) tokens.add(normalized);
  };
  if (Array.isArray(memory?.domains)) memory.domains.forEach(add);
  if (Array.isArray(memory?.tags)) memory.tags.forEach(add);
  if (Array.isArray(memory?.content?.context_tags)) memory.content.context_tags.forEach(add);
  return Array.from(tokens);
}

const SALIENT_STOPWORDS = new Set([
  "devo", "dobbiamo", "domani", "andare", "andremo", "faremo", "partire",
  "chiamare", "chiamato", "fatto", "visto", "sono", "siamo", "stato", "stata",
  "tornato", "tornati", "finito", "passato", "risolto", "meglio", "video"
]);

function salientWords(text) {
  return normalizeText(text)
    .split(/\s+/)
    .filter(word => word.length >= 4 && !SALIENT_STOPWORDS.has(word));
}

function sharedSignals(older, newer) {
  const oldEntities = getEntityTokens(older);
  const newEntities = new Set(getEntityTokens(newer));
  const sharedEntities = oldEntities.filter(entity => newEntities.has(entity));

  const oldDomains = domainTokens(older);
  const newDomains = new Set(domainTokens(newer));
  const sharedDomains = oldDomains.filter(domain => newDomains.has(domain));

  const oldWords = new Set(salientWords(memoryText(older)));
  const sharedWords = salientWords(memoryText(newer)).filter(word => oldWords.has(word));

  return { sharedEntities, sharedDomains, sharedWords };
}

function hasSharedContext(older, newer) {
  const signals = sharedSignals(older, newer);
  return signals.sharedEntities.length > 0 || signals.sharedDomains.length > 0 || signals.sharedWords.length > 0;
}

function relationResult(relation, confidence, reason) {
  return { relation, confidence, reason };
}

function extractPlaces(text) {
  const source = String(text || "");
  const places = [];
  const seen = new Set();
  const pattern = /\b(?:a|ad|da|dal|dalla|per|in|verso)\s+([A-ZÀ-ÖØ-Þ][\p{L}0-9'-]*(?:\s+[A-ZÀ-ÖØ-Þ][\p{L}0-9'-]*){0,2}|[\p{L}][\p{L}0-9'-]*)/gu;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const place = String(match[1] || "").replace(/[.,;:!?]+$/g, "").trim();
    const key = normalizeText(place);
    if (place && !seen.has(key)) {
      seen.add(key);
      places.push(key);
    }
  }
  return places;
}

function sharePlace(olderText, newerText) {
  const olderPlaces = new Set(extractPlaces(olderText));
  return extractPlaces(newerText).some(place => olderPlaces.has(place));
}

function isCallIntent(text) {
  const normalized = normalizeText(text);
  return /\b(devo|dobbiamo)\s+(chiamare|sentire|parlare\s+con)\b/.test(normalized);
}

function isCallCompletion(text) {
  const normalized = normalizeText(text);
  return /\b(ho|abbiamo)\s+chiamato\b/.test(normalized) ||
    /\bsentito\b/.test(normalized) ||
    /\bparlato\s+con\b/.test(normalized);
}

function isFeverState(text) {
  const normalized = normalizeText(text);
  return /\bfebbre\b/.test(normalized) || /\btemperatura\b/.test(normalized);
}

function isFeverUpdate(text) {
  const normalized = normalizeText(text);
  return /\bsta\s+meglio\b/.test(normalized) ||
    /\bfebbre\s+e\s+passata\b/.test(normalized) ||
    /\bnon\s+ha\s+piu\s+febbre\b/.test(normalized) ||
    /\btemperatura\s+scesa\b/.test(normalized) ||
    /\bsfebbrat[oa]\b/.test(normalized);
}

function isTravelIntent(text) {
  const normalized = normalizeText(text);
  return /\bdomani\b/.test(normalized) && /\b(devo|dobbiamo|andare|partire|partiamo)\b/.test(normalized);
}

function isTravelCompletion(text) {
  const normalized = normalizeText(text);
  return /\bsono\s+andato\b/.test(normalized) ||
    /\bsiamo\s+andati\b/.test(normalized) ||
    /\bsono\s+tornato\b/.test(normalized) ||
    /\bsiamo\s+tornati\b/.test(normalized) ||
    /\bviaggio\s+finito\b/.test(normalized) ||
    /\bappuntamento\s+fatto\b/.test(normalized);
}

function isExplicitCompletionForIntent(olderText, newerText) {
  if (isCallIntent(olderText) && isCallCompletion(newerText) && hasSharedContext({ content: { text: olderText } }, { content: { text: newerText } })) {
    return relationResult("completes", 0.9, "azione da fare completata da una frase di chiamata/sentito/parlato coerente");
  }

  if (isFeverState(olderText) && isFeverUpdate(newerText)) {
    const olderMemory = { content: { text: olderText } };
    const newerMemory = { content: { text: newerText } };
    const hasSharedSubject = sharedSignals(olderMemory, newerMemory).sharedEntities.length > 0;
    const feverExplicit = /\bfebbre\b|\btemperatura\b|\bsfebbrat[oa]\b/.test(normalizeText(newerText));
    if (hasSharedSubject || feverExplicit) {
      return relationResult("updates", hasSharedSubject ? 0.88 : 0.72, "stato di salute aggiornato da miglioramento o febbre risolta");
    }
  }

  if (isTravelIntent(olderText) && isTravelCompletion(newerText)) {
    if (sharePlace(olderText, newerText)) {
      return relationResult("completes", 0.9, "intenzione di viaggio completata con stesso luogo");
    }
    if (/\bviaggio\s+finito\b|\bappuntamento\s+fatto\b/.test(normalizeText(newerText)) && hasSharedContext({ content: { text: olderText } }, { content: { text: newerText } })) {
      return relationResult("completes", 0.68, "chiusura esplicita di viaggio/appuntamento con contesto condiviso");
    }
  }

  return null;
}

function adjustRelationForRoles(result, olderRole, newerRole) {
  if (newerRole === "assistant" && olderRole === "user") {
    const adjustedRelation = ["completes", "updates", "contradicts"].includes(result.relation) ? "confirms" : result.relation;
    return {
      relation: adjustedRelation,
      confidence: Math.max(0, result.confidence - 0.25),
      reason: `${result.reason}; confidence ridotta perche la memoria piu recente e assistant`
    };
  }

  if (newerRole === "user" && olderRole === "assistant" && ["completes", "updates", "contradicts"].includes(result.relation)) {
    return {
      ...result,
      confidence: Math.min(1, result.confidence + 0.05),
      reason: `${result.reason}; memoria user piu autorevole della traccia assistant`
    };
  }

  return result;
}

function detectTemporalRelation(olderMemory, newerMemory) {
  const olderText = memoryText(olderMemory);
  const newerText = memoryText(newerMemory);
  const olderRole = olderMemory?._role || normalizeMemoryRole(olderMemory);
  const newerRole = newerMemory?._role || normalizeMemoryRole(newerMemory);
  const olderIntent = olderMemory?._temporalIntent || classifyTemporalIntent(olderText, olderRole);
  const newerIntent = newerMemory?._temporalIntent || classifyTemporalIntent(newerText, newerRole);
  const signals = sharedSignals(olderMemory, newerMemory);
  const hasContext = signals.sharedEntities.length > 0 || signals.sharedDomains.length > 0 || signals.sharedWords.length > 0;

  if (olderMemory?._isQuestion || newerMemory?._isQuestion || olderIntent === "query" || newerIntent === "query") {
    if (!hasContext) return relationResult("none", 0, "domanda senza contesto condiviso");
    return relationResult("related", 0.2, "domanda correlata: usare come query, non come aggiornamento temporale");
  }

  if (!hasContext) {
    return relationResult("none", 0, "nessuna entita, dominio o parola saliente condivisa");
  }

  const explicit = isExplicitCompletionForIntent(olderText, newerText);
  if (explicit) return adjustRelationForRoles(explicit, olderRole, newerRole);

  if (olderIntent === "past_event") {
    return adjustRelationForRoles(relationResult("related", 0.35, "evento passato correlato, non aggiornabile come stato corrente"), olderRole, newerRole);
  }

  if (olderIntent === newerIntent && hasContext) {
    return adjustRelationForRoles(relationResult("confirms", 0.55, "memoria correlata con stesso intento temporale"), olderRole, newerRole);
  }

  if (newerIntent === "completed_event" && ["future_intent", "current_state"].includes(olderIntent)) {
    return adjustRelationForRoles(relationResult("related", 0.55, "evento conclusivo generico ma senza pattern abbastanza specifico"), olderRole, newerRole);
  }

  if (newerIntent === "current_state" && olderIntent === "current_state") {
    return adjustRelationForRoles(relationResult("updates", 0.6, "possibile aggiornamento di stato sotto soglia prudenziale"), olderRole, newerRole);
  }

  return adjustRelationForRoles(relationResult("related", 0.4, "contesto condiviso senza chiusura o contraddizione esplicita"), olderRole, newerRole);
}

function applySuperseding(memories) {
  const ordered = memories
    .map((memory, index) => ({ memory, index }))
    .sort((a, b) => (b.memory._ageMs || 0) - (a.memory._ageMs || 0));

  for (let i = 0; i < ordered.length; i++) {
    const older = ordered[i].memory;
    if (older._isQuestion) continue;
    if (["historical", "completed", "superseded"].includes(older._temporalValidity)) continue;

    for (let j = i + 1; j < ordered.length; j++) {
      const newer = ordered[j].memory;
      if ((newer._ageMs || 0) >= (older._ageMs || 0)) continue;
      if (newer._isQuestion) continue;

      const relation = detectTemporalRelation(older, newer);
      older._temporalRelations = older._temporalRelations || [];
      if (relation.relation !== "none") {
        older._temporalRelations.push({
          text: memoryText(newer),
          timeAgo: newer._timeAgo,
          relation: relation.relation,
          confidence: relation.confidence,
          reason: relation.reason
        });
      }

      if (["completes", "updates", "contradicts"].includes(relation.relation) && relation.confidence >= 0.65) {
        older._temporalValidity = "superseded";
        older._temporalNote = "Nota: memoria probabilmente superata da un aggiornamento più recente.";
        older._supersededBy = {
          text: memoryText(newer),
          timeAgo: newer._timeAgo,
          relation: relation.relation,
          confidence: relation.confidence,
          reason: relation.reason
        };
        break;
      }
    }
  }

  return memories;
}

function decorateMemoryWithTime(memory) {
  const timestamp = getMemoryTimestamp(memory);
  const text = memoryText(memory);
  const ageMs = getAgeMs(timestamp);
  const ageHours = ageMs / HOUR_MS;
  const role = normalizeMemoryRole(memory);
  const question = isQuestion(text);
  const temporalIntent = classifyTemporalIntent(text, role);
  const temporalValidity = classifyTemporalValidity(temporalIntent, ageHours);

  return {
    ...memory,
    _timeAgo: formatTimeAgo(timestamp),
    _ageMs: ageMs,
    _ageHours: ageHours,
    _role: role,
    _isQuestion: question,
    _temporalState: classifyTemporalState(text, timestamp, role),
    _temporalIntent: temporalIntent,
    _temporalValidity: temporalValidity,
    _temporalNote: temporalNoteFor(temporalIntent, temporalValidity)
  };
}

function decorateMemoriesWithTime(memories) {
  return applySuperseding((Array.isArray(memories) ? memories : []).map(decorateMemoryWithTime));
}

module.exports = {
  now,
  getAgeMs,
  formatTimeAgo,
  isQuestion,
  classifyTemporalState,
  classifyTemporalIntent,
  classifyTemporalValidity,
  normalizeMemoryRole,
  detectTemporalRelation,
  decorateMemoryWithTime,
  decorateMemoriesWithTime
};
