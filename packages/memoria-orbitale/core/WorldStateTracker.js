const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_CONFIDENCE = 0.75;

const QUESTION_PATTERNS = [
  /\bti\s+ricordi\b/,
  /\bricordi\b/,
  /\bsai\s+se\b/,
  /\bche\s+ne\s+pensi\b/,
  /\bsecondo\s+te\b/,
  /\bposso\s+farti\s+una\s+domanda\b/,
  /\bla\s+domanda\s+vera\b/,
  /\bquando\b/,
  /\bdove\b/,
  /\bcosa\b/,
  /\bcome\b/,
  /\bperche\b/,
  /\bquanto\b/,
  /\bquale\b/,
  /\bquali\b/
];

const TRIVIAL_INPUTS = new Set([
  'ciao', 'ola', ':d', 'bravo', 'grazie', 'ok', 'va bene', 'si', 'sì', 'no'
]);

const DISCOURSE_OR_THEORY_PATTERNS = [
  /\bla\s+domanda\s+vera\b/,
  /\bsecondo\s+te\b/,
  /\bche\s+ne\s+pensi\b/,
  /\bquale\s+differenza\b/,
  /\bi\s+due\s+\w+\s+sono\b/,
  /\b\w+\s+patern[oa]\b/,
  /\bterapia\b/,
  /\bgene\b/,
  /\bgeni\b/,
  /\bscientific\w*\b/,
  /\bteoric\w*\b/,
  /\be\s+affett[oa]\s+da\b/,
  /\bha\s+\d+\s+anni\b/
];

const SPATIAL_TRIGGER_PATTERNS = [
  /\bandare\b/,
  /\bandat[oaie]\b/,
  /\barrivat[oaie]\b/,
  /\btornat[oaie]\b/,
  /\brientrat[oaie]\b/,
  /\bpartire\b/,
  /\bpartit[oaie]\b/,
  /\bpartiamo\b/,
  /\bpartiremo\b/,
  /\bsiamo\s+a\b/,
  /\bsono\s+a\b/,
  /\be\s+a\b/,
  /\bsiamo\s+in\b/,
  /\bsono\s+in\b/,
  /\be\s+in\b/,
  /\bsto\s+a\b/,
  /\bstiamo\s+a\b/,
  /\bvado\s+a\b/,
  /\bvado\s+in\b/,
  /\bandiamo\s+a\b/,
  /\bandiamo\s+in\b/,
  /\bsiamo\s+qui\b/,
  /\bsono\s+qui\b/,
  /\bsiamo\s+arrivati\b/,
  /\bsono\s+arrivato\b/,
  /\bsiamo\s+tornati\b/,
  /\bsono\s+tornato\b/
];

const TRAVEL_STATE_PATTERNS = {
  completed: [
    /\bsono\s+tornat[oa]\b/,
    /\bsiamo\s+tornati\b/,
    /\bsono\s+rientrat[oa]\b/,
    /\bsiamo\s+rientrati\b/,
    /\btornat[oaie]\s+(da|dal|dalla|dall)\b/,
    /\brientrat[oaie]\s+(da|dal|dalla|dall)\b/,
    /\bsiamo\s+andati\b.*\bsiamo\s+tornati\b/,
    /\bsono\s+andat[oa]\b.*\bsono\s+tornat[oa]\b/
  ],
  arrived: [
    /\bsono\s+arrivat[oa]\b/,
    /\bsiamo\s+arrivati\b/,
    /\barrivat[oaie]\s+a\b/,
    /\bappena\s+arrivat[oaie]\b/
  ],
  current: [
    /\bsono\s+a\b/,
    /\bsiamo\s+a\b/,
    /\be\s+a\b/,
    /\bsono\s+in\b/,
    /\bsiamo\s+in\b/,
    /\be\s+in\b/,
    /\bsto\s+a\b/,
    /\bstiamo\s+a\b/,
    /\bsono\s+qui\b/,
    /\bsiamo\s+qui\b/
  ],
  planned: [
    /\bdomani\s+part[oi]\b/,
    /\bdomani\s+partiamo\b/,
    /\bdevo\s+andare\b/,
    /\bdobbiamo\s+andare\b/,
    /\bandremo\b/,
    /\bpartiremo\b/,
    /\bsto\s+per\s+partire\b/,
    /\bsi\s+parte\b/,
    /\bpartiamo\s+per\b/,
    /\bvado\s+(a|in)\b/,
    /\bandiamo\s+(a|in)\b/
  ]
};

const STATUS_LABELS = {
  planned: 'pianificato',
  current: 'attualmente li / in corso',
  completed: 'concluso',
  stale_planned: 'pianificazione vecchia non confermata',
  stale_current: 'presenza vecchia non confermata'
};

const COMMON_PLACE_WORDS = new Set([
  'casa', 'lavoro', 'scuola', 'ospedale', 'aeroporto', 'stazione', 'ufficio',
  'universita', 'farmacia'
]);

const BAD_PLACE_WORDS = new Set([
  'io', 'tu', 'lui', 'lei', 'noi', 'voi', 'loro', 'mi', 'ti', 'si',
  'la', 'il', 'lo', 'le', 'gli', 'un', 'una', 'uno',
  'questa', 'questo', 'domanda', 'gene', 'geni', 'terapia', 'secondo', 'quale',
  'ecco', 'oggi', 'domani', 'ieri', 'ora', 'adesso', 'ciao', 'buongiorno', 'buonasera'
]);

const PLACE_CONNECTORS = new Set(['di', 'del', 'della', 'dei', 'degli', 'delle', 'san', 'santa', 'santo']);
const PLACE_BOUNDARIES = new Set(['e', 'poi', 'ma', 'pero', 'però', 'oppure', 'o', 'anche', 'quindi', 'dopo', 'prima']);
const SPATIAL_PREPOSITIONS = new Set(['a', 'ad', 'da', 'dal', 'dalla', 'dall', 'per', 'in', 'verso', 'dentro']);

function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function normalizePlace(place) {
  return String(place || '')
    .replace(/[.,;:!?()[\]{}"']+$/g, '')
    .replace(/^\s+|\s+$/g, '')
    .replace(/\s+/g, ' ');
}

function stripLeadingSpatialPrefix(token) {
  const cleaned = normalizePlace(token).replace(/[’']/g, "'");
  const normalized = normalizeText(cleaned);
  const prefixMatch = normalized.match(/^(dall|all|nell|dal|dalla|alla|nella)(.+)$/);
  if (!prefixMatch) return null;

  const rawPrefix = prefixMatch[1];
  const prefixLength = rawPrefix.length;
  return cleaned.slice(prefixLength).replace(/^['’]/, '');
}

function isQuestion(text) {
  const normalized = normalizeText(text);
  return String(text || '').includes('?') || QUESTION_PATTERNS.some(pattern => pattern.test(normalized));
}

function isTrivialInput(text) {
  const normalized = normalizeText(text).replace(/[.!?]+$/g, '').trim();
  return TRIVIAL_INPUTS.has(normalized);
}

function isTheoreticalOrDescriptive(text) {
  const normalized = normalizeText(text);
  return DISCOURSE_OR_THEORY_PATTERNS.some(pattern => pattern.test(normalized));
}

function hasSpatialTrigger(text) {
  const normalized = normalizeText(text);
  return SPATIAL_TRIGGER_PATTERNS.some(pattern => pattern.test(normalized));
}

function isCapitalizedToken(token) {
  return /^[A-ZÀ-ÖØ-Þ][\p{L}0-9'-]*$/u.test(token);
}

function isCommonPlaceToken(token) {
  return COMMON_PLACE_WORDS.has(normalizeText(token));
}

function isBadPlaceToken(token) {
  return BAD_PLACE_WORDS.has(normalizeText(token));
}

function isPlaceStartToken(token) {
  const cleaned = normalizePlace(token);
  if (!cleaned || isBadPlaceToken(cleaned)) return false;
  return isCommonPlaceToken(cleaned) || isCapitalizedToken(cleaned);
}

function isPlaceContinuationToken(token) {
  const cleaned = normalizePlace(token);
  const normalized = normalizeText(cleaned);
  if (!cleaned || isBadPlaceToken(cleaned)) return false;
  return isCapitalizedToken(cleaned) || PLACE_CONNECTORS.has(normalized);
}

function isCleanPlace(place) {
  const tokens = normalizePlace(place).split(' ').filter(Boolean);
  if (tokens.length === 0) return false;
  if (tokens.some(isBadPlaceToken)) return false;
  if (tokens.length === 1 && PLACE_CONNECTORS.has(normalizeText(tokens[0]))) return false;
  return true;
}

function addPlace(places, seen, tokens) {
  while (tokens.length > 0 && PLACE_CONNECTORS.has(normalizeText(tokens[tokens.length - 1]))) {
    tokens.pop();
  }

  const place = normalizePlace(tokens.join(' '));
  const key = normalizeText(place);
  if (isCleanPlace(place) && !seen.has(key)) {
    seen.add(key);
    places.push(place);
  }
}

function extractPlaces(text) {
  const source = String(text || '');
  const words = source.split(/\s+/).filter(Boolean);
  const places = [];
  const seen = new Set();

  for (let i = 0; i < words.length; i++) {
    const firstRaw = normalizePlace(words[i]);
    const first = normalizeText(firstRaw.replace(/[’']/g, ''));
    const second = normalizeText(normalizePlace(words[i + 1] || ''));
    let start = -1;
    let forcedFirstToken = null;

    if (first === 'fuori' && second === 'da') {
      start = i + 2;
    } else if (SPATIAL_PREPOSITIONS.has(first)) {
      start = i + 1;
    } else {
      const stripped = stripLeadingSpatialPrefix(firstRaw);
      if (stripped) {
        start = i;
        forcedFirstToken = stripped;
      }
    }

    if (start < 0 || start >= words.length) continue;

    const firstToken = forcedFirstToken || normalizePlace(words[start]);
    if (!isPlaceStartToken(firstToken)) continue;

    const tokens = [firstToken];
    const firstIsCommonOnly = isCommonPlaceToken(firstToken) && !isCapitalizedToken(firstToken);

    if (!firstIsCommonOnly) {
      for (let j = start + 1; j < words.length && tokens.length < 3; j++) {
        const token = normalizePlace(words[j]);
        const normalized = normalizeText(token.replace(/[’']/g, ''));
        if (PLACE_BOUNDARIES.has(normalized) || SPATIAL_PREPOSITIONS.has(normalized) || stripLeadingSpatialPrefix(token)) break;
        if (!isPlaceContinuationToken(token)) break;
        tokens.push(token);
      }
    }

    addPlace(places, seen, tokens);
  }

  return places;
}

function detectTravelState(text) {
  if (!hasSpatialTrigger(text) || isQuestion(text) || isTrivialInput(text) || isTheoreticalOrDescriptive(text)) {
    return null;
  }

  const normalized = normalizeText(text);
  for (const [state, patterns] of Object.entries(TRAVEL_STATE_PATTERNS)) {
    if (patterns.some(pattern => pattern.test(normalized))) return state;
  }

  return null;
}

function memoryText(memory) {
  return memory?.content?.text || memory?.text || '';
}

function eventTimestamp(memory, ageMs) {
  if (typeof memory?.timestamp === 'number') return memory.timestamp;
  if (typeof memory?.meta?.timestamp === 'number') return memory.meta.timestamp;
  if (typeof ageMs === 'number' && Number.isFinite(ageMs)) return Date.now() - ageMs;
  return null;
}

function toEvent(memory, index) {
  const text = memoryText(memory);
  const travelState = detectTravelState(text);
  const ageMs = typeof memory?._ageMs === 'number' ? memory._ageMs : Number.MAX_SAFE_INTEGER;
  return {
    text,
    places: extractPlaces(text),
    travelState,
    ageMs,
    timeAgo: memory?._timeAgo || 'adesso',
    timestamp: eventTimestamp(memory, ageMs),
    order: index,
    source: 'memory',
    inferred: false
  };
}

function inputToEvent(currentInput, order) {
  if (isQuestion(currentInput) || isTrivialInput(currentInput)) return null;
  return {
    text: currentInput || '',
    places: extractPlaces(currentInput),
    travelState: detectTravelState(currentInput),
    ageMs: 0,
    timeAgo: 'adesso',
    timestamp: Date.now(),
    order,
    source: 'input',
    inferred: false
  };
}

function statusFromEvent(event) {
  if (event.travelState === 'planned') return event.ageMs > DAY_MS ? 'stale_planned' : 'planned';
  if (event.travelState === 'current' || event.travelState === 'arrived') return event.ageMs > DAY_MS ? 'stale_current' : 'current';
  if (event.travelState === 'completed') return 'completed';
  return null;
}

function confidenceFor(status, explicitPlace) {
  if (status === 'stale_planned' || status === 'stale_current') return 0.4;
  if (status === 'completed' && explicitPlace) return 0.95;
  if (status === 'current' && explicitPlace) return 0.85;
  if (status === 'planned' && explicitPlace) return 0.75;
  return 0.5;
}

function noteFor(status) {
  if (status === 'stale_planned') return 'Questo piano non e confermato perche l evidenza e vecchia.';
  if (status === 'stale_current') return 'Questa presenza non e confermata perche l evidenza e vecchia.';
  if (status === 'completed') return 'Evento concluso; memorie precedenti su partenza o arrivo sono storiche se precedenti.';
  return '';
}

function applyPlaceEvent(worldState, place, event, explicitPlace) {
  const status = statusFromEvent(event);
  if (!status) return;
  const confidence = confidenceFor(status, explicitPlace);
  if (confidence < MIN_CONFIDENCE) return;

  const existing = worldState.travel[place];
  const historyEntry = {
    status,
    confidence,
    evidence: event.text,
    timeAgo: event.timeAgo,
    ageMs: event.ageMs,
    timestamp: event.timestamp,
    explicitPlace
  };

  worldState.travel[place] = {
    place,
    status,
    confidence,
    evidence: event.text,
    timeAgo: event.timeAgo,
    ageMs: event.ageMs,
    note: noteFor(status),
    history: existing ? [...existing.history, historyEntry] : [historyEntry]
  };
}

function buildWorldStateFromMemories(memories, currentInput) {
  const isCurrentInputQuestion = isQuestion(currentInput);
  const worldState = {
    generatedAt: new Date().toISOString(),
    isCurrentInputQuestion,
    travel: {}
  };

  if (isCurrentInputQuestion) return worldState;

  const recalledEvents = (Array.isArray(memories) ? memories : []).map(toEvent);
  const inputEvent = inputToEvent(currentInput, recalledEvents.length);
  const events = [...recalledEvents, inputEvent]
    .filter(Boolean)
    .filter(event => event.text && event.travelState && event.places.length > 0)
    .sort((a, b) => b.ageMs - a.ageMs || a.order - b.order);

  for (const event of events) {
    for (const place of event.places) {
      applyPlaceEvent(worldState, place, event, true);
    }
  }

  return worldState;
}

function formatWorldStateForPrompt(worldState) {
  const travel = worldState?.travel || {};
  const places = Object.keys(travel).filter(place => (travel[place].confidence || 0) >= MIN_CONFIDENCE);
  if (places.length === 0) return '';

  const lines = ['STATO TEMPORALE ATTUALE:'];
  for (const place of places) {
    const item = travel[place];
    const label = STATUS_LABELS[item.status] || item.status;
    lines.push(`- Viaggio/Luogo ${place}: ${label}. Evidenza: "${item.evidence}" (${item.timeAgo}).`);
    if (item.status === 'stale_planned' || item.status === 'stale_current') {
      lines.push('- Nota: questo stato non e confermato perche l evidenza e vecchia.');
    }
    if (item.status === 'completed') {
      lines.push('- Le memorie precedenti su partenza/arrivo per questo luogo sono storiche, non piu attuali se precedenti.');
    }
  }
  return lines.join('\n');
}

module.exports = {
  isQuestion,
  extractPlaces,
  detectTravelState,
  buildWorldStateFromMemories,
  formatWorldStateForPrompt
};
