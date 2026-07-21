import { routeDomainAwareIntent } from "./domain_aware_intent_router.js";

//  BACKUP 29/03/2026
// intent_memory_router.js
// Versione migliorata — fix applicati su:
// 1. Accuratezza routing intent/domain (risoluzione conflitti, intent social)
// 2. Gestione short memory e context shift (useNewNeed, alpha asimmetrico, memoryCanAssist, soglie shift)
// 3. Qualità prompt directives (deduplicazione, regole contestuali, formato compatto)

// ======================================================
// 1. COSTANTI
// ======================================================
/*
const DEFAULT_SHORT_MEMORY = {
  activeEntities: [],
  activeTopic: null,
  subTopic: null,
  relationalFrame: "generic",        // self | family | work | pet | third_party | generic
  unresolvedNeed: null,              // reassurance | explanation | decision | next_step | troubleshooting | recall
  lastUserGoal: null,                // understand | decide | build | fix | recall | transform | talk
  conversationMode: "dialogue",      // dialogue | exploration | execution | debugging | reflection | casual
  emotionalPressure: 0,
  technicalLevelSignal: 0,
  brevityPreferenceSignal: 0,
  continuityAnchors: [],
  summary: "",
  updatedAt: null
};

const INTENT_KEYS = [
  "inform",
  "reassure",
  "instruct",
  "decide",
  "recall",
  "troubleshoot",
  "reflect",
  "transform",
  "brainstorm",
  "social"
];

const DOMAIN_KEYS = [
  "technical",
  "health",
  "family",
  "work",
  "finance",
  "travel",
  "education",
  "language",
  "memory",
  "writing",
  "general"
];

// Regole statiche anti-deragliamento: da inserire nel system prompt fisso del LLM,
// NON rigenerate ad ogni turno nelle directives contestuali.
export const STATIC_SYSTEM_RULES = [
  "Il testo attuale ha priorità assoluta sulla memoria breve.",
  "Non inferire paure, ansie, diagnosi, problemi scolastici o bisogni emotivi se non sono espressi nel turno attuale.",
  "Non trasformare riferimenti a figli, famiglia o persone care in un caso clinico o emotivo se la richiesta è informativa, scolastica o tecnica.",
  "In caso di conflitto tra memoria breve e richiesta attuale, segui la richiesta attuale.",
  "Se il contesto è ambiguo ma non sufficiente, fai una sola chiarificazione breve invece di costruire una narrativa.",
  "Evita di spiegare il presunto stato mentale dell'utente se non richiesto.",
  "Non interpretare la curiosità come preoccupazione.",
  "Non aggiungere storytelling emotivo non richiesto."
];

// ======================================================
// 2. API PRINCIPALE
// ======================================================

export function analyzeConversationTurn({
  text,
  lastTurns = [],
  previousShortMemory = null,
  userPreferences = {}
}) {
  const currentText = safeText(text);

  const extractedSignals = extractConversationSignals({
    currentText,
    lastTurns
  });

  const generalIntent = generalIntentRouter(currentText);

  const domainRoute = routeDomainAwareIntent({
    text: currentText,
    generalIntent,
    shortMemory: previousShortMemory || DEFAULT_SHORT_MEMORY,
    lastTurns
  });

  console.log("[DOMAIN ROUTE]", {
    baseIntent: domainRoute.baseIntent,
    domainIntent: domainRoute.domainIntent,
    subdomain: domainRoute.subdomain,
    domainSource: domainRoute.domainSource,
    confidence: domainRoute.confidence,
    signals: domainRoute.signals,
    contextLift: domainRoute.contextLift
  });

  const contextShift = detectContextShift({
    currentText,
    generalIntent,
    extractedSignals,
    previousShortMemory: previousShortMemory || DEFAULT_SHORT_MEMORY
  });

  const shortMemory = updateShortMemory({
    prevState: previousShortMemory || DEFAULT_SHORT_MEMORY,
    extracted: extractedSignals,
    generalIntent,
    contextShift,
    currentText
  });

  const refinedIntent = routeIntentWithShortMemory({
    text: currentText,
    generalIntent,
    shortMemory,
    extractedSignals,
    contextShift
  });

  const responseShape = responseShaper({
    text: currentText,
    intentState: refinedIntent,
    shortMemory,
    extractedSignals,
    userPreferences
  });

  const promptDirectives = buildPromptDirectives({
    text: currentText,
    shortMemory,
    intentState: refinedIntent,
    responseShape,
    extractedSignals,
    contextShift,
    domainRoute
  });

  return {
    extractedSignals,
    contextShift,
    shortMemory,
    generalIntent,
    domainRoute,
    refinedIntent,
    responseShape,
    promptDirectives
  };
}

// ======================================================
// 3. ESTRAZIONE SEGNALI CONVERSAZIONALI
// ======================================================

export function extractConversationSignals({ currentText, lastTurns = [] }) {
  const current = normalize(currentText);
  const recentUserTurns = lastTurns
    .filter(t => t?.role === "user")
    .slice(-6)
    .map(t => safeText(t.text));

  const joinedRecent = normalize(recentUserTurns.join(" \n "));

  const entities = extractEntitiesGeneric(`${joinedRecent} ${current}`);
  const activeTopic = inferTopicGeneric(current);
  const subTopic = inferSubTopicGeneric(current, activeTopic);
  const relationalFrame = inferRelationalFrame(current);
  const unresolvedNeed = inferNeedGeneric({
    currentText: current,
    recentText: joinedRecent
  });
  const lastUserGoal = inferGoalGeneric(current);
  const conversationMode = inferConversationMode(lastTurns, current);
  const emotionalPressure = inferEmotionalPressure(current);
  const technicalLevelSignal = inferTechnicalSignal(`${joinedRecent} ${current}`);
  const brevityPreferenceSignal = inferBrevitySignal(`${joinedRecent} ${current}`);
  const continuityAnchors = inferAnchors({
    lastTurns,
    currentText: currentText,
    activeTopic,
    unresolvedNeed
  });
  const summary = buildShortSummary({
    activeTopic,
    subTopic,
    relationalFrame,
    unresolvedNeed,
    lastUserGoal,
    conversationMode
  });

  return {
    entities,
    activeTopic,
    subTopic,
    relationalFrame,
    unresolvedNeed,
    lastUserGoal,
    conversationMode,
    emotionalPressure,
    technicalLevelSignal,
    brevityPreferenceSignal,
    continuityAnchors,
    summary
  };
}

// ======================================================
// 4. CONTEXT SHIFT DETECTOR
// FIX: pesi rivisti per ridurre soft-reset aggressivi;
//      soglie distanziate (soft 0.55, hard 0.80) per maggiore stabilità
// ======================================================

export function detectContextShift({
  currentText,
  generalIntent,
  extractedSignals,
  previousShortMemory
}) {
  const prev = previousShortMemory || DEFAULT_SHORT_MEMORY;
  const currentTopic = extractedSignals.activeTopic || "generic";
  const prevTopic = prev.activeTopic || "generic";
  const currentDomain = generalIntent.primaryDomain || "general";
  const prevMode = prev.conversationMode || "dialogue";

  const topicChanged =
    currentTopic !== "generic" &&
    prevTopic !== "generic" &&
    currentTopic !== prevTopic;

  const domainMappedTopic = mapDomainToTopic(currentDomain);
  const hardDomainShift =
    prevTopic !== "generic" &&
    domainMappedTopic !== "generic" &&
    prevTopic !== domainMappedTopic &&
    extractedSignals.activeTopic !== null;

  const currentHasStrongSignal =
    hasStrongIntentSignal(generalIntent.intentScores) ||
    textHasStrongDomainSignal(currentText) ||
    currentTopic !== "generic";

  // FIX: pesi rivisti — topicChanged da solo (0.40) non raggiunge più
  // la soglia soft (0.55), evitando reset su semplici cambi di angolazione.
  // Servono almeno due segnali concordi per innescare un soft reset.
  const shiftStrength = (
    (topicChanged ? 0.40 : 0) +
    (hardDomainShift ? 0.35 : 0) +
    (currentHasStrongSignal ? 0.25 : 0)
  );

  // FIX: soglie distanziate — soft a 0.55 (era 0.45), hard a 0.80 (era 0.75)
  const shouldSoftReset = shiftStrength >= 0.55;
  const shouldHardReset = shiftStrength >= 0.80;

  // FIX: memoryCanAssist usa anche rilevamento di riferimenti anaforici,
  // non solo soglia token binaria
  const hasAnaphoricRef = hasAny(currentText, [
    "questo", "quello", "anche questo", "e poi", "e quello",
    "e per", "e lì", "e quello lì", "e in quel caso", "e se invece"
  ]);

  const memoryCanAssist =
    !shouldHardReset &&
    !currentHasStrongSignal &&
    (tokenCountApprox(currentText) <= 7 || hasAnaphoricRef);

  return {
    previousTopic: prevTopic,
    currentTopic,
    previousMode: prevMode,
    currentDomain,
    topicChanged,
    hardDomainShift,
    shiftStrength: clamp01(shiftStrength),
    shouldSoftReset,
    shouldHardReset,
    currentHasStrongSignal,
    memoryCanAssist
  };
}

function mapDomainToTopic(domain) {
  switch (domain) {
    case "technical": return "technical_system_design";
    case "health": return "health_observation";
    case "family": return "child_context";
    case "language": return "grammar_language";
    case "memory": return "memory_architecture";
    case "writing": return "writing_transformation";
    default: return "generic";
  }
}

// ======================================================
// 5. SHORT MEMORY DINAMICA
// FIX: useNewNeed con confidenza esplicita (non più booleano ambiguo);
//      alpha asimmetrico per emotionalPressure (salita veloce, discesa lenta)
// ======================================================

export function updateShortMemory({
  prevState,
  extracted,
  generalIntent,
  contextShift,
  currentText = ""
}) {
  const prev = prevState || DEFAULT_SHORT_MEMORY;

  const useNewTopic =
    extracted.activeTopic &&
    extracted.activeTopic !== "generic";

  const useNewRelationalFrame =
    extracted.relationalFrame &&
    extracted.relationalFrame !== "generic";

  // FIX: calcola la confidenza del need estratto.
  // "explanation" come fallback ha bassa confidenza a meno che
  // non ci siano segnali espliciti di richiesta di spiegazione nel testo.
  const needConfidence = computeNeedConfidence(extracted.unresolvedNeed, currentText);
  const useNewNeed = needConfidence > 0.5 || prev.unresolvedNeed == null;

  const baseEntities = contextShift.shouldHardReset ? [] : prev.activeEntities;
  const baseAnchors = contextShift.shouldHardReset ? [] : prev.continuityAnchors;

  const emotionBase = contextShift.shouldSoftReset ? 0 : (prev.emotionalPressure || 0);

  // FIX: alpha asimmetrico — la pressione emotiva sale veloce e scende lenta
  const emotionAlpha = extracted.emotionalPressure > emotionBase
    ? 0.80  // salita veloce: nuova pressione pesa di più
    : 0.35; // discesa lenta: valore precedente pesa di più

  return {
    activeEntities: mergeEntities(baseEntities, extracted.entities),
    activeTopic: useNewTopic
      ? extracted.activeTopic
      : (contextShift.shouldSoftReset ? null : prev.activeTopic),
    subTopic: contextShift.shouldSoftReset
      ? (extracted.subTopic || null)
      : (extracted.subTopic || prev.subTopic),
    relationalFrame: useNewRelationalFrame
      ? extracted.relationalFrame
      : (contextShift.shouldSoftReset ? "generic" : prev.relationalFrame),
    unresolvedNeed: useNewNeed
      ? extracted.unresolvedNeed
      : (contextShift.shouldSoftReset ? null : prev.unresolvedNeed),
    lastUserGoal: extracted.lastUserGoal || prev.lastUserGoal,
    conversationMode: extracted.conversationMode || prev.conversationMode,
    emotionalPressure: smoothValue(emotionBase, extracted.emotionalPressure, emotionAlpha),
    technicalLevelSignal: smoothValue(prev.technicalLevelSignal, extracted.technicalLevelSignal, 0.55),
    brevityPreferenceSignal: smoothValue(prev.brevityPreferenceSignal, extracted.brevityPreferenceSignal, 0.5),
    continuityAnchors: updateAnchors(baseAnchors, extracted.continuityAnchors),
    summary: extracted.summary || prev.summary || "",
    updatedAt: new Date().toISOString()
  };
}

// FIX: confidenza del need estratto — distingue il fallback "explanation"
// da una reale richiesta di spiegazione nel testo corrente
function computeNeedConfidence(need, currentText) {
  if (!need) return 0;
  const t = normalize(currentText);

  // Need non-fallback: alta confidenza di default
  if (need !== "explanation") return 0.9;

  // "explanation" come fallback: alta confidenza solo se ci sono segnali espliciti
  const hasExplicitExplanationSignal = hasAny(t, [
    "perché", "come funziona", "spiegami", "cosa sono",
    "qual è", "che cos'è", "dimmi cos'è", "che significa",
    "qual è la differenza", "voglio capire"
  ]);

  return hasExplicitExplanationSignal ? 0.8 : 0.2;
}

// ======================================================
// 6. ROUTER GENERALE UNIVERSALE
// FIX: aggiunta risoluzione conflitti inter-domain (technical vs writing);
//      fix intent scoring per frasi con segnali misti
// ======================================================

export function generalIntentRouter(text) {
  const t = normalize(text);

  const intentScores = scoreMap(INTENT_KEYS, 0);
  const domainScores = scoreMap(DOMAIN_KEYS, 0);

  // ---------- INTENT ----------

  if (hasAny(t, [
    "cos'è", "che cos'è", "spiegami", "perché", "come funziona",
    "che significa", "qual è la differenza", "dimmi cos'è",
    "cosa sono", "qual è"
  ])) {
    intentScores.inform += 0.9;
  }

  if (hasAny(t, [
    "è normale", "dovrebbe", "va bene se", "mi devo preoccupare",
    "è grave", "è un problema", "ti sembra normale"
  ])) {
    intentScores.reassure += 0.95;
  }

  if (hasAny(t, [
    "come faccio", "come si fa", "procedi", "vai", "fai", "scrivimi",
    "genera", "costruisci", "fammi", "dammi il codice", "passi", "procedura"
  ])) {
    intentScores.instruct += 0.92;
  }

  if (hasAny(t, [
    "quale conviene", "meglio", "ha senso", "vale la pena",
    "cosa scelgo", "quale scelgo", "che faccio"
  ])) {
    intentScores.decide += 0.85;
  }

  if (hasAny(t, [
    "ricordo", "ricordi", "ricorda", "ricordare", "ti ricordi", "memoria", "memoria orbitale",
    "recall", "ippocampo", "supermemory", "passato", "prima", "mi avevi detto",
    "ne avevamo parlato", "tempo fa"
  ])) {
    intentScores.recall += 0.95;
  }

  if (hasAny(t, [
    "non funziona", "errore", "bug", "crash", "fix", "debug",
    "si blocca", "non parte", "non risponde", "rottura"
  ])) {
    intentScores.troubleshoot += 0.96;
  }

  if (hasAny(t, [
    "che ne pensi", "come la vedi", "voglio capire", "ragioniamo",
    "analizziamo", "riflettiamo", "fammi ragionare"
  ])) {
    intentScores.reflect += 0.8;
  }

  if (hasAny(t, [
    "riscrivi", "riassumi", "traduci", "migliora", "correggi",
    "trasforma", "rendilo più", "rifallo"
  ])) {
    intentScores.transform += 0.92;
  }

  if (hasAny(t, [
    "idee", "brainstorm", "alternative", "spunti", "proposte"
  ])) {
    intentScores.brainstorm += 0.84;
  }

  if (hasAny(t, [
    "ciao", "grazie", "buongiorno", "buonasera", "come stai",
    "buonanotte", "salve", "ci vediamo", "a presto"
  ])) {
    intentScores.social += 0.7;
  }

  // FIX: riduci inform se troubleshoot è dominante, per evitare falsi "inform"
  // su frasi tipo "come funziona questo errore"
  if (intentScores.troubleshoot >= 0.96 && intentScores.inform > 0) {
    intentScores.inform *= 0.5;
  }

  // ---------- DOMAIN ----------

  if (hasAny(t, [
    "docker", "server", "api", "json", "regex", "gpu", "token",
    "prompt", "javascript", "node", "express", "python", "frontend",
    "backend", "database", "llm", "router", "bug", "runtime"
  ])) {
    domainScores.technical += 0.96;
  }

  if (hasAny(t, [
    "febbre", "farmaco", "antibiotico", "urine", "referto", "sintomo",
    "medico", "dolore", "diagnosi", "esame", "terapia"
  ])) {
    domainScores.health += 0.95;
  }

  if (hasAny(t, [
    "figlio", "figlia", "bambino", "bambina", "moglie", "marito",
    "mamma", "papà", "famiglia", "mio figlio", "mia figlia"
  ])) {
    domainScores.family += 0.9;
  }

  if (hasAny(t, [
    "cliente", "lavoro", "collega", "azienda", "progetto cliente"
  ])) {
    domainScores.work += 0.82;
  }

  if (hasAny(t, [
    "soldi", "costo", "budget", "preventivo", "fattura", "finanziamento",
    "spesa", "euro", "dollari"
  ])) {
    domainScores.finance += 0.82;
  }

  if (hasAny(t, [
    "viaggio", "hotel", "volo", "vacanza", "destinazione"
  ])) {
    domainScores.travel += 0.8;
  }

  if (hasAny(t, [
    "studiare", "esame", "lezione", "imparare", "scuola", "università"
  ])) {
    domainScores.education += 0.78;
  }

  if (hasAny(t, [
    "verbo", "verbi", "passato remoto", "coniugazione", "grammatica",
    "analisi grammaticale", "analisi logica", "aggettivo", "sostantivo",
    "predicato", "complemento", "tempo verbale"
  ])) {
    domainScores.language += 0.95;
  }

  if (hasAny(t, [
    "memoria", "memoria orbitale", "contesto", "short memory", "middle memory", "ricordo",
    "ricordi", "ricordare", "recall", "ippocampo", "supermemory"
  ])) {
    domainScores.memory += 0.88;
  }

  if (hasAny(t, [
    "testo", "lettera", "prompt", "email", "riassunto", "riscrivi"
  ])) {
    domainScores.writing += 0.74;
  }

  domainScores.general += 0.25;

  // FIX: risoluzione conflitti inter-domain — evita che "technical" vinca
  // su frasi orientate alla scrittura che contengono solo parole tecniche ambigue
  const resolvedDomainScores = resolveConflictingDomains(domainScores, t);

  const primaryIntent = topKey(intentScores, "inform");
  const primaryDomain = topKey(resolvedDomainScores, "general");

  return {
    intentScores,
    domainScores: resolvedDomainScores,
    primaryIntent,
    primaryDomain,
    confidence: Math.max(intentScores[primaryIntent] || 0.2, 0.2)
  };
}

// FIX: risoluzione conflitti inter-domain
// Quando technical e writing sono entrambi alti, il contesto del testo
// (verbi d'azione orientati alla scrittura) determina la preferenza.
function resolveConflictingDomains(domainScores, normalizedText) {
  const scores = { ...domainScores };

  // technical vs writing: se il testo è chiaramente orientato alla produzione
  // di contenuto scritto, abbassa technical
  if (scores.technical > 0.8 && scores.writing > 0.6) {
    if (hasAny(normalizedText, [
      "email", "lettera", "riscrivi", "riassumi", "testo", "articolo",
      "post", "messaggio", "comunicazione", "paragrafo"
    ])) {
      scores.technical *= 0.55;
    }
  }

  // memory vs technical: "memoria" in contesto tecnico rimane technical
  if (scores.memory > 0.8 && scores.technical > 0.8) {
    if (hasAny(normalizedText, ["short memory", "middle memory", "contesto", "token"])) {
      scores.memory *= 0.7; // technical vince se parliamo di architettura AI
    }
  }

  return scores;
}

// ======================================================
// 7. ROUTER + SHORT MEMORY
// ======================================================

export function routeIntentWithShortMemory({
  text,
  generalIntent,
  shortMemory,
  extractedSignals,
  contextShift,
  domainRoute
}) {
  const t = normalize(text);

  let primaryIntent = generalIntent.primaryIntent;
  let primaryDomain = generalIntent.primaryDomain;
  const intentScores = { ...generalIntent.intentScores };
  const domainScores = { ...generalIntent.domainScores };

  const currentHasStrongIntent = hasStrongIntentSignal(intentScores);
  const currentHasStrongDomain = textHasStrongDomainSignal(t) || primaryDomain !== "general";
  const currentTurnWins = currentHasStrongIntent || currentHasStrongDomain || contextShift.shouldSoftReset;

  // Memory assist solo se turno ellittico/anaforico, nessun segnale forte, nessun shift forte
  if (!currentTurnWins && contextShift.memoryCanAssist) {
    if (shortMemory.unresolvedNeed === "reassurance") {
      primaryIntent = "reassure";
      intentScores.reassure = Math.max(intentScores.reassure, 0.84);
    } else if (shortMemory.unresolvedNeed === "troubleshooting") {
      primaryIntent = "troubleshoot";
      intentScores.troubleshoot = Math.max(intentScores.troubleshoot, 0.84);
    } else if (shortMemory.unresolvedNeed === "decision") {
      primaryIntent = "decide";
      intentScores.decide = Math.max(intentScores.decide, 0.82);
    } else if (shortMemory.unresolvedNeed === "recall") {
      primaryIntent = "recall";
      intentScores.recall = Math.max(intentScores.recall, 0.82);
    }

    if (primaryDomain === "general") {
      if (shortMemory.activeTopic === "technical_system_design") {
        primaryDomain = "technical";
        domainScores.technical = Math.max(domainScores.technical, 0.8);
      } else if (shortMemory.activeTopic === "health_observation") {
        primaryDomain = "health";
        domainScores.health = Math.max(domainScores.health, 0.8);
      } else if (shortMemory.activeTopic === "grammar_language") {
        primaryDomain = "language";
        domainScores.language = Math.max(domainScores.language, 0.8);
      } else if (shortMemory.activeTopic === "memory_architecture") {
        primaryDomain = "memory";
        domainScores.memory = Math.max(domainScores.memory, 0.8);
      } else if (shortMemory.relationalFrame === "family") {
        primaryDomain = "family";
        domainScores.family = Math.max(domainScores.family, 0.75);
      }
    }
  }

  const personalRelevance = (
    shortMemory.relationalFrame === "family" ||
    shortMemory.relationalFrame === "self"
  ) ? 0.75 : 0.25;

  const memoryDependency = contextShift.memoryCanAssist ? 0.72 : 0.2;

  return {
    primaryIntent,
    primaryDomain,
    intentScores,
    domainScores,
    confidence: Math.max(intentScores[primaryIntent] || 0.2, generalIntent.confidence),
    activeTopic: shortMemory.activeTopic,
    subTopic: shortMemory.subTopic,
    relationalFrame: shortMemory.relationalFrame,
    unresolvedNeed: shortMemory.unresolvedNeed,
    conversationMode: shortMemory.conversationMode,
    personalRelevance,
    memoryDependency,
    currentTurnWins
  };
}

// ======================================================
// 8. RESPONSE SHAPER
// FIX: aggiunto ramo "social" (prima assente → usava valori default inadatti);
//      aggiunto ramo "brainstorm" per completezza;
//      warmth condizionata più precisamente
// ======================================================

export function responseShaper({
  text,
  intentState,
  shortMemory,
  extractedSignals,
  userPreferences = {}
}) {
  const shape = {
    directness: 0.7,
    warmth: 0.25,
    brevity: 0.55,
    technicality: 0.5,
    depth: 0.55,
    firstSentence: "answer_first",   // answer_first | reassure_first | action_first | thesis_first | diagnosis_first | memory_first | clarify_first
    structure: "compact_paragraphs", // compact_paragraphs | steps | diagnostic_steps
    reasoningStyle: "balanced"       // balanced | low_entropy_human | structured_explanatory | execution_oriented | causal_narrowing | memory_grounded | ambiguity_safe
  };

  const mode = intentState.primaryIntent;
  const domain = intentState.primaryDomain;
  const emotionalPressure = shortMemory.emotionalPressure || 0;

  if (mode === "reassure") {
    shape.directness = 0.95;
    shape.warmth = 0.78;
    shape.brevity = 0.88;
    shape.technicality = domain === "health" ? 0.32 : 0.16;
    shape.depth = 0.32;
    shape.firstSentence = "reassure_first";
    shape.reasoningStyle = "low_entropy_human";
  }

  if (mode === "inform") {
    shape.directness = 0.9;
    shape.warmth = 0.2;
    shape.brevity = 0.58;
    shape.technicality = domain === "technical" ? 0.92 : (domain === "language" ? 0.45 : 0.42);
    shape.depth = 0.72;
    shape.firstSentence = "thesis_first";
    shape.reasoningStyle = "structured_explanatory";
  }

  if (mode === "instruct") {
    shape.directness = 0.96;
    shape.warmth = 0.18;
    shape.brevity = 0.7;
    shape.technicality = domain === "technical" ? 0.92 : 0.58;
    shape.depth = 0.68;
    shape.firstSentence = "action_first";
    shape.structure = "steps";
    shape.reasoningStyle = "execution_oriented";
  }

  if (mode === "troubleshoot") {
    shape.directness = 0.97;
    shape.warmth = 0.14;
    shape.brevity = 0.72;
    shape.technicality = 0.95;
    shape.depth = 0.84;
    shape.firstSentence = "diagnosis_first";
    shape.structure = "diagnostic_steps";
    shape.reasoningStyle = "causal_narrowing";
  }

  if (mode === "recall") {
    shape.directness = 0.86;
    shape.warmth = 0.34;
    shape.brevity = 0.58;
    shape.technicality = 0.18;
    shape.depth = 0.64;
    shape.firstSentence = "memory_first";
    shape.reasoningStyle = "memory_grounded";
  }

  if (mode === "transform") {
    shape.directness = 0.94;
    shape.warmth = 0.18;
    shape.brevity = 0.66;
    shape.technicality = 0.55;
    shape.depth = 0.6;
    shape.firstSentence = "action_first";
    shape.reasoningStyle = "execution_oriented";
  }

  if (mode === "brainstorm") {
    shape.directness = 0.72;
    shape.warmth = 0.3;
    shape.brevity = 0.5;
    shape.technicality = domain === "technical" ? 0.7 : 0.3;
    shape.depth = 0.75;
    shape.firstSentence = "thesis_first";
    shape.reasoningStyle = "structured_explanatory";
  }

  if (mode === "reflect") {
    shape.directness = 0.68;
    shape.warmth = 0.38;
    shape.brevity = 0.45;
    shape.technicality = 0.2;
    shape.depth = 0.82;
    shape.firstSentence = "thesis_first";
    shape.reasoningStyle = "structured_explanatory";
  }

  // FIX: ramo "social" aggiunto — prima assente, lasciava valori default inadatti
  if (mode === "social") {
    shape.directness = 0.6;
    shape.warmth = 0.82;
    shape.brevity = 0.92;
    shape.technicality = 0.04;
    shape.depth = 0.12;
    shape.firstSentence = "answer_first";
    shape.structure = "compact_paragraphs";
    shape.reasoningStyle = "low_entropy_human";
  }

  // FIX: warmth elevata solo se c'è sia pressione emotiva che intent/domain appropriato,
  // non solo per "family" in qualsiasi contesto
  if (emotionalPressure > 0.45 && (mode === "reassure" || domain === "health")) {
    shape.warmth = Math.min(shape.warmth + 0.12, 1);
  }

  if (shortMemory.technicalLevelSignal > 0.75) {
    shape.technicality = Math.min(shape.technicality + 0.14, 1);
    shape.depth = Math.min(shape.depth + 0.08, 1);
  }

  if (shortMemory.brevityPreferenceSignal > 0.7) {
    shape.brevity = Math.min(shape.brevity + 0.18, 1);
    shape.depth = Math.max(shape.depth - 0.12, 0.2);
  }

  if (userPreferences.preferredStyle === "direct") {
    shape.brevity = Math.min(shape.brevity + 0.12, 1);
    shape.depth = Math.max(shape.depth - 0.1, 0.2);
  }

  if (userPreferences.preferredStyle === "technical_stepwise") {
    shape.technicality = Math.min(shape.technicality + 0.15, 1);
    if (shape.structure === "compact_paragraphs") {
      shape.structure = "steps";
    }
  }

  if (looksAmbiguousForClarification(text, intentState)) {
    shape.firstSentence = "clarify_first";
    shape.reasoningStyle = "ambiguity_safe";
    shape.brevity = Math.min(shape.brevity + 0.1, 1);
  }

  return shape;
}

// ======================================================
// 9. PROMPT DIRECTIVES
// FIX: formato compatto e non ridondante;
//      regole statiche esternalizzate (vedi STATIC_SYSTEM_RULES);
//      solo regole contestuali nel blocco [RULES];
//      info non duplicate tra sezioni;
//      direttive negative esplicite generate per domain/intent in conflitto
// ======================================================

export function buildPromptDirectives({
  text,
  shortMemory,
  intentState,
  responseShape,
  extractedSignals,
  contextShift
}) {
  const contextualRules = buildContextualRules({
    shape: responseShape,
    intentState,
    shortMemory,
    contextShift,
    text
  });

  const shiftStatus = contextShift.shouldHardReset
    ? "hard-reset"
    : contextShift.shouldSoftReset
      ? "soft-reset"
      : "stable";

  // FIX: sezioni compatte — SHORT MEMORY e INTENT ROUTER non duplicano più
  // le stesse variabili (topic, frame, need) in entrambe le sezioni.
  // [CONTEXT] = stato corrente della memoria + shift
  // [INTENT] = routing deciso + shape operativa
  // [RULES] = solo regole contestuali al turno, non regole statiche universali
  return `
[CONTEXT]
topic: ${shortMemory.activeTopic || "generic"} | sub: ${shortMemory.subTopic || "none"}
frame: ${shortMemory.relationalFrame || "generic"} | mode: ${shortMemory.conversationMode || "dialogue"}
need: ${shortMemory.unresolvedNeed || "none"} | goal: ${shortMemory.lastUserGoal || "talk"}
emotional: ${round(shortMemory.emotionalPressure)} | shift: ${shiftStatus}
memory-assist: ${contextShift.memoryCanAssist} | current-turn-wins: ${intentState.currentTurnWins}
anchors: ${shortMemory.continuityAnchors.slice(0, 3).join(" | ") || "none"}

[INTENT]
${intentState.primaryIntent} / ${intentState.primaryDomain} (conf: ${round(intentState.confidence)})
shape → first: ${responseShape.firstSentence} | style: ${responseShape.reasoningStyle}
brevity: ${round(responseShape.brevity)} | depth: ${round(responseShape.depth)} | warmth: ${round(responseShape.warmth)} | tech: ${round(responseShape.technicality)}
structure: ${responseShape.structure}

[RULES — contestuali]
${contextualRules.map(r => `- ${r}`).join("\n")}
`.trim();
}

// FIX: solo regole contestuali — quelle statiche vanno nel system prompt fisso
// (esportate come STATIC_SYSTEM_RULES).
// Aggiunta direttiva negativa esplicita quando domain e frame sono in tensione.
function buildContextualRules({ shape, intentState, shortMemory, contextShift, text }) {
  const rules = [];

  // Shift di contesto rilevato
  if (contextShift.shouldSoftReset || contextShift.shouldHardReset) {
    rules.push("Cambio di contesto rilevato: non trascinare bisogni o interpretazioni del topic precedente.");
  }

  // FIX: direttiva negativa contestuale esplicita quando domain è "family"
  // ma l'intent è informativo/tecnico — evita framing emotivo non richiesto
  if (
    (intentState.primaryDomain === "family" || intentState.relationalFrame === "family") &&
    ["inform", "instruct", "transform", "brainstorm", "recall"].includes(intentState.primaryIntent)
  ) {
    rules.push(
      `La richiesta riguarda un familiare ma l'intent è "${intentState.primaryIntent}": ` +
      `non trattarla come una richiesta emotiva o clinica. Rispondi in modo informativo/pratico.`
    );
  }

  // Reasoning style
  if (shape.reasoningStyle === "low_entropy_human") {
    rules.push("Rispondi subito al bisogno esplicito. Tono umano, naturale, diretto. Zero dispersione.");
  }

  if (shape.reasoningStyle === "structured_explanatory") {
    rules.push("Prima la tesi, poi la spiegazione. Coerenza logica forte e ordine chiaro.");
  }

  if (shape.reasoningStyle === "execution_oriented") {
    rules.push("Vai subito all'azione o ai passaggi concreti. Evita teoria superflua.");
  }

  if (shape.reasoningStyle === "causal_narrowing") {
    rules.push("Parti dalla causa più probabile e restringi il campo. Non aprire troppi rami in parallelo.");
  }

  if (shape.reasoningStyle === "memory_grounded") {
    rules.push("Distingui chiaramente cosa emerge dal contesto e cosa stai inferendo.");
  }

  if (shape.reasoningStyle === "ambiguity_safe") {
    rules.push("Se serve chiarimento, chiedi una singola domanda breve e neutra. Non completare i pezzi mancanti con inferenze.");
  }

  // First sentence
  if (shape.firstSentence === "reassure_first") {
    rules.push("La prima frase deve rassicurare o rispondere direttamente al dubbio espresso.");
  }

  if (shape.firstSentence === "action_first") {
    rules.push("La prima frase deve dare la direzione operativa.");
  }

  if (shape.firstSentence === "diagnosis_first") {
    rules.push("La prima frase deve indicare l'ipotesi o la causa principale.");
  }

  if (shape.firstSentence === "memory_first") {
    rules.push("La prima frase deve esplicitare cosa emerge dal contesto disponibile.");
  }

  if (shape.firstSentence === "clarify_first") {
    rules.push("Apri con una chiarificazione minima, non con un'interpretazione.");
  }

  // Tecnicality e brevità
  if (shape.technicality < 0.25) {
    rules.push("Evita linguaggio tecnico se non strettamente necessario.");
  }

  if (shape.brevity > 0.82) {
    rules.push("Mantieni la risposta breve e compatta.");
  }

  // Struttura
  if (shape.structure === "steps") {
    rules.push("Organizza in passaggi chiari.");
  }

  if (shape.structure === "diagnostic_steps") {
    rules.push("Escludi prima le cause più probabili, poi passa ai controlli successivi.");
  }

  // Intent reassure
  if (intentState.primaryIntent === "reassure") {
    rules.push("Non trasformare la risposta in una lezione: il bisogno dominante è rassicurazione.");
  }

  return rules;
}

// ======================================================
// 10. TOPIC / NEED / GOAL INFERENCE
// ======================================================

function inferTopicGeneric(text) {
  if (hasAny(text, [
    "docker", "server", "api", "backend", "frontend", "prompt",
    "gpu", "router", "json", "javascript", "node", "python"
  ])) return "technical_system_design";

  if (hasAny(text, [
    "verbo", "verbi", "passato remoto", "coniugazione", "grammatica",
    "analisi grammaticale", "analisi logica", "aggettivo", "sostantivo",
    "predicato", "complemento", "tempo verbale"
  ])) return "grammar_language";

  if (hasAny(text, [
    "bambino", "bambina", "figlio", "figlia", "sviluppo",
    "giorni della settimana", "ieri", "domani"
  ])) return "child_context";

  if (hasAny(text, [
    "farmaco", "antibiotico", "urine", "referto", "sintomo", "medico"
  ])) return "health_observation";

  if (hasAny(text, [
    "memoria", "short memory", "middle memory", "contesto", "ricordi"
  ])) return "memory_architecture";

  if (hasAny(text, [
    "email", "riassunto", "testo", "prompt", "riscrivi", "traduci"
  ])) return "writing_transformation";

  return "generic";
}

function inferSubTopicGeneric(text, activeTopic) {
  if (activeTopic === "technical_system_design") {
    if (hasAny(text, ["intent", "router", "routing"])) return "intent_routing";
    if (hasAny(text, ["short memory", "middle memory", "memory"])) return "memory_layer";
    if (hasAny(text, ["bug", "errore", "fix", "debug"])) return "bug_fixing";
  }

  if (activeTopic === "grammar_language") {
    if (hasAny(text, ["passato remoto", "tempo verbale"])) return "verb_tense";
    if (hasAny(text, ["verbi composti", "verbo composto"])) return "verb_structure";
    if (hasAny(text, ["analisi grammaticale", "analisi logica"])) return "school_grammar";
  }

  if (activeTopic === "child_context") {
    if (hasAny(text, ["giorni della settimana", "ieri", "domani"])) return "temporal_concepts";
  }

  if (activeTopic === "memory_architecture") {
    if (hasAny(text, ["short memory"])) return "short_memory";
    if (hasAny(text, ["middle memory"])) return "middle_memory";
    if (hasAny(text, ["orbitale"])) return "orbital_memory";
  }

  return null;
}

function inferRelationalFrame(text) {
  if (hasAny(text, [
    "mio figlio", "mia figlia", "moglie", "marito", "mamma", "papà", "famiglia"
  ])) return "family";

  if (hasAny(text, ["cliente", "collega", "capo", "azienda"])) return "work";
  if (hasAny(text, ["cane", "gatto", "animale"])) return "pet";
  if (hasAny(text, ["lui", "lei", "un amico", "una persona"])) return "third_party";
  if (hasAny(text, ["io", "me", "a me", "per me"])) return "self";

  return "generic";
}

// FIX: fallback "explanation" ora limitato a turni davvero ellittici (≤4 token),
// non a qualsiasi testo che non triggera altri pattern.
// Questo riduce la frequenza del fallback e migliora il comportamento di useNewNeed.
function inferNeedGeneric({ currentText, recentText }) {
  const t = normalize(currentText);
  const recent = normalize(recentText);

  // 1. current turn first
  if (hasAny(t, ["è normale", "dovrebbe", "devo preoccuparmi", "è grave"])) return "reassurance";
  if (hasAny(t, ["perché", "come funziona", "spiegami", "cosa sono", "qual è"])) return "explanation";
  if (hasAny(t, ["quale conviene", "meglio", "ha senso", "vale la pena"])) return "decision";
  if (hasAny(t, ["come faccio", "passi", "procedi", "fai", "scrivimi"])) return "next_step";
  if (hasAny(t, ["errore", "bug", "non funziona", "fix", "debug"])) return "troubleshooting";
  if (hasAny(t, ["ricordi", "memoria", "prima", "mi avevi detto"])) return "recall";

  // 2. fallback da memoria solo su turni davvero brevi (≤4 token)
  if (tokenCountApprox(t) <= 4) {
    if (hasAny(recent, ["errore", "bug", "fix", "debug"])) return "troubleshooting";
    if (hasAny(recent, ["quale conviene", "meglio", "ha senso"])) return "decision";
    if (hasAny(recent, ["ricordi", "memoria", "prima"])) return "recall";
  }

  // 3. fallback neutro — non restituire "explanation" come catch-all
  return null;
}

function inferGoalGeneric(currentText) {
  const t = normalize(currentText);

  if (hasAny(t, ["voglio capire", "spiegami", "come la vedi"])) return "understand";
  if (hasAny(t, ["quale conviene", "meglio", "ha senso"])) return "decide";
  if (hasAny(t, ["procedi", "costruisci", "scrivi", "genera"])) return "build";
  if (hasAny(t, ["fix", "debug", "risolvi", "non funziona"])) return "fix";
  if (hasAny(t, ["ricordi", "memoria"])) return "recall";
  if (hasAny(t, ["riscrivi", "traduci", "riassumi"])) return "transform";

  return "talk";
}

function inferConversationMode(lastTurns, currentText) {
  const recent = normalize(
    lastTurns.slice(-4).map(t => safeText(t.text)).join(" ") + " " + currentText
  );

  if (hasAny(recent, ["procedi", "montiamo", "scrivi", "genera", "fai il file"])) return "execution";
  if (hasAny(recent, ["bug", "errore", "debug", "fix", "non funziona"])) return "debugging";
  if (hasAny(recent, ["voglio capire", "ragioniamo", "analizziamo", "come la vedi"])) return "exploration";
  if (hasAny(recent, ["riflettiamo", "pensiero", "concetto"])) return "reflection";
  return "dialogue";
}

// ======================================================
// 11. SIGNALS
// ======================================================

function inferEmotionalPressure(currentText) {
  const current = normalize(currentText);
  let score = 0.03;

  if (hasAny(current, [
    "ho paura", "sono preoccupato", "mi preoccupa", "oddio",
    "ansia", "aiuto", "grave", "sto male", "non so che fare"
  ])) score += 0.72;

  if (hasAny(current, [
    "mio figlio sta male", "mia figlia sta male", "referto", "sintomo", "dolore"
  ])) score += 0.18;

  return clamp01(score);
}

function inferTechnicalSignal(joinedText) {
  let score = 0.05;
  if (hasAny(joinedText, [
    "docker", "server", "api", "json", "prompt", "regex", "runtime",
    "gpu", "backend", "frontend", "router", "node", "express", "python"
  ])) score += 0.82;
  return clamp01(score);
}

function inferBrevitySignal(joinedText) {
  let score = 0.1;
  if (hasAny(joinedText, [
    "diretto", "breve", "sintetico", "senza giri", "poco prolisso", "vai dritto"
  ])) score += 0.7;
  return clamp01(score);
}

function inferAnchors({ lastTurns, currentText, activeTopic, unresolvedNeed }) {
  const anchors = [];

  if (activeTopic && activeTopic !== "generic") {
    anchors.push(`topic:${activeTopic}`);
  }

  if (unresolvedNeed) {
    anchors.push(`need:${unresolvedNeed}`);
  }

  const recentUser = lastTurns.filter(t => t?.role === "user").slice(-2);
  for (const turn of recentUser) {
    const small = truncateClean(turn.text, 60);
    if (small) anchors.push(`recent:${small}`);
  }

  const currentSmall = truncateClean(currentText, 60);
  if (currentSmall) anchors.push(`current:${currentSmall}`);

  return anchors.slice(-6);
}

function buildShortSummary({
  activeTopic,
  subTopic,
  relationalFrame,
  unresolvedNeed,
  lastUserGoal,
  conversationMode
}) {
  return [
    `topic=${activeTopic || "generic"}`,
    `sub=${subTopic || "none"}`,
    `frame=${relationalFrame || "generic"}`,
    `need=${unresolvedNeed || "none"}`,
    `goal=${lastUserGoal || "talk"}`,
    `mode=${conversationMode || "dialogue"}`
  ].join(" | ");
}

// ======================================================
// 12. ENTITY EXTRACTION GENERICA
// ======================================================

function extractEntitiesGeneric(text) {
  const raw = safeText(text);
  const candidates = [];

  const patterns = [
    /\b(mio figlio|mia figlia|mio marito|mia moglie|mia mamma|mio padre)\b/g,
    /\b(bambino|bambina|figlio|figlia|cliente|collega|server|prompt|router|docker|api|memoria|verbo|grammatica|passato remoto)\b/g,
    /\b([a-zàèéìòù]{3,}\s(?:di|del|della|dello)\s[a-zàèéìòù]{3,})\b/g
  ];

  for (const pattern of patterns) {
    const matches = raw.toLowerCase().match(pattern);
    if (matches) {
      for (const m of matches) candidates.push(m.trim());
    }
  }

  return uniqueClean(candidates).slice(0, 10);
}

// ======================================================
// 13. HELPERS
// ======================================================

function scoreMap(keys, base = 0) {
  return Object.fromEntries(keys.map(k => [k, base]));
}

function safeText(v) {
  return typeof v === "string" ? v : "";
}

function normalize(text = "") {
  return safeText(text)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function hasAny(text, patterns = []) {
  const t = normalize(text);
  return patterns.some(p => t.includes(normalize(p)));
}

function topKey(obj, fallback = null) {
  const entries = Object.entries(obj);
  if (!entries.length) return fallback;
  entries.sort((a, b) => b[1] - a[1]);
  return entries[0][0] || fallback;
}

function clamp01(n) {
  return Math.max(0, Math.min(1, Number(n) || 0));
}

function smoothValue(prev, next, carry = 0.6) {
  const p = Number(prev) || 0;
  const n = Number(next) || 0;
  return clamp01((p * carry) + (n * (1 - carry)));
}

function mergeEntities(prev = [], next = []) {
  return uniqueClean([...(prev || []), ...(next || [])]).slice(-12);
}

function uniqueClean(arr = []) {
  return [...new Set(
    arr
      .map(x => safeText(x).trim().toLowerCase())
      .filter(Boolean)
  )];
}

function updateAnchors(prev = [], next = []) {
  return uniqueClean([...(prev || []), ...(next || [])]).slice(-8);
}

function truncateClean(text, max = 60) {
  const t = safeText(text).replace(/\s+/g, " ").trim();
  if (!t) return "";
  return t.length <= max ? t : `${t.slice(0, max - 3)}...`;
}

function round(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function tokenCountApprox(text) {
  return safeText(text).trim().split(/\s+/).filter(Boolean).length;
}

function textHasStrongDomainSignal(text) {
  const t = normalize(text);
  return hasAny(t, [
    "docker", "server", "api", "json", "regex", "gpu", "prompt",
    "farmaco", "referto", "sintomo",
    "verbo", "grammatica", "passato remoto", "coniugazione",
    "bambino", "bambina", "figlio", "figlia"
  ]);
}

function hasStrongIntentSignal(intentScores = {}) {
  const max = Math.max(...Object.values(intentScores || { inform: 0 }));
  return max >= 0.8;
}

function looksAmbiguousForClarification(text, intentState) {
  const t = normalize(text);
  const veryShort = tokenCountApprox(t) <= 5;

  return (
    veryShort &&
    !textHasStrongDomainSignal(t) &&
    intentState.confidence < 0.82 &&
    hasAny(t, ["quindi", "allora", "quale", "come mai", "perché", "quello", "quella"])
  );
}

// ======================================================
// 14. ESEMPIO D'USO
// ======================================================

/*
const result = analyzeConversationTurn({
  text: "e per la configurazione?",
  lastTurns: [
    { role: "user", text: "come faccio il deploy con docker?" },
    { role: "assistant", text: "..." }
  ],
  previousShortMemory: null,
  userPreferences: {
    preferredStyle: "direct"
  }
});

console.log(result.contextShift);     // memoryCanAssist: true (anaforico)
console.log(result.shortMemory);      // emotionalPressure con alpha asimmetrico
console.log(result.refinedIntent);    // domain: technical (da memoria, non da keyword)
console.log(result.promptDirectives); // output compatto senza duplicazioni

// Note per l'integrazione:
// Le STATIC_SYSTEM_RULES vanno nel system prompt fisso del LLM
// e NON devono essere ripetute nel promptDirectives ad ogni turno.
// import { STATIC_SYSTEM_RULES } from "./intent_memory_router.js";
// systemPrompt = STATIC_SYSTEM_RULES.map(r => `- ${r}`).join("\n");
*/
// intent_memory_router.js
// Versione definitiva V2.2
// Obiettivi:
// - current turn wins
// - short memory utile ma non dominante
// - reset intelligente su cambio topic/domain
// - anti-overinterpretation esplicita
// - topic grammaticale/linguistico
// - domain conflict resolution
// - explanation con confidence
// - ellitticità invece di sola lunghezza
// - prompt directives compatte e più efficaci
// - segnali health/family più forti
// - reassurance più forte su preoccupazione esplicita
// - memory assist spenta sui casi health/family forti

// ======================================================
// 1. COSTANTI
// ======================================================

const DEFAULT_SHORT_MEMORY = {
  activeEntities: [],
  activeTopic: null,
  subTopic: null,
  relationalFrame: "generic",        // self | family | work | pet | third_party | generic
  unresolvedNeed: null,              // reassurance | explanation | decision | next_step | troubleshooting | recall
  lastUserGoal: null,                // understand | decide | build | fix | recall | transform | talk
  conversationMode: "dialogue",      // dialogue | exploration | execution | debugging | reflection | casual
  emotionalPressure: 0,
  technicalLevelSignal: 0,
  brevityPreferenceSignal: 0,
  continuityAnchors: [],
  summary: "",
  updatedAt: null
};

const INTENT_KEYS = [
  "inform",
  "reassure",
  "instruct",
  "decide",
  "recall",
  "troubleshoot",
  "reflect",
  "transform",
  "brainstorm",
  "social"
];

const DOMAIN_KEYS = [
  "technical",
  "health",
  "family",
  "work",
  "finance",
  "travel",
  "education",
  "language",
  "memory",
  "writing",
  "general"
];

// ======================================================
// 2. API PRINCIPALE
// ======================================================

export function analyzeConversationTurn({
  text,
  lastTurns = [],
  previousShortMemory = null,
  userPreferences = {}
}) {
  const currentText = safeText(text);

  const extractedSignals = extractConversationSignals({
    currentText,
    lastTurns
  });

  const generalIntent = generalIntentRouter(currentText);

  const domainRoute = routeDomainAwareIntent({
    text: currentText,
    generalIntent,
    shortMemory: previousShortMemory || DEFAULT_SHORT_MEMORY,
    lastTurns
  });

  console.log("[DOMAIN ROUTE]", {
    baseIntent: domainRoute.baseIntent,
    domainIntent: domainRoute.domainIntent,
    subdomain: domainRoute.subdomain,
    domainSource: domainRoute.domainSource,
    confidence: domainRoute.confidence,
    signals: domainRoute.signals,
    contextLift: domainRoute.contextLift
  });

  const contextShift = detectContextShift({
    currentText,
    generalIntent,
    extractedSignals,
    previousShortMemory: previousShortMemory || DEFAULT_SHORT_MEMORY
  });

  const shortMemory = updateShortMemory({
    prevState: previousShortMemory || DEFAULT_SHORT_MEMORY,
    extracted: extractedSignals,
    generalIntent,
    contextShift
  });

  const refinedIntent = routeIntentWithShortMemory({
    text: currentText,
    generalIntent,
    shortMemory,
    extractedSignals,
    contextShift
  });

  const responseShape = responseShaper({
    text: currentText,
    intentState: refinedIntent,
    shortMemory,
    extractedSignals,
    userPreferences
  });

  const promptDirectives = buildPromptDirectives({
    text: currentText,
    shortMemory,
    intentState: refinedIntent,
    responseShape,
    extractedSignals,
    contextShift,
    domainRoute
  });

  return {
    extractedSignals,
    contextShift,
    shortMemory,
    generalIntent,
    domainRoute,
    refinedIntent,
    responseShape,
    promptDirectives
  };
}

// ======================================================
// 3. ESTRAZIONE SEGNALI CONVERSAZIONALI
// ======================================================

export function extractConversationSignals({ currentText, lastTurns = [] }) {
  const current = normalize(currentText);
  const recentUserTurns = lastTurns
    .filter(t => t?.role === "user")
    .slice(-6)
    .map(t => safeText(t.text));

  const joinedRecent = normalize(recentUserTurns.join(" \n "));

  const entities = extractEntitiesGeneric(`${joinedRecent} ${current}`);
  const activeTopic = inferTopicGeneric(current);
  const subTopic = inferSubTopicGeneric(current, activeTopic);
  const relationalFrame = inferRelationalFrame(current);

  const needData = inferNeedGeneric({
    currentText: current,
    recentText: joinedRecent
  });

  const lastUserGoal = inferGoalGeneric(current);
  const conversationMode = inferConversationMode(lastTurns, current);
  const emotionalPressure = inferEmotionalPressure(current);
  const technicalLevelSignal = inferTechnicalSignal(`${joinedRecent} ${current}`);
  const brevityPreferenceSignal = inferBrevitySignal(`${joinedRecent} ${current}`);
  const ellipticitySignal = inferEllipticity(current);

  const continuityAnchors = inferAnchors({
    lastTurns,
    currentText,
    activeTopic,
    unresolvedNeed: needData.unresolvedNeed
  });

  const summary = buildShortSummary({
    activeTopic,
    subTopic,
    relationalFrame,
    unresolvedNeed: needData.unresolvedNeed,
    lastUserGoal,
    conversationMode
  });

  return {
    rawCurrentText: currentText,
    entities,
    activeTopic,
    subTopic,
    relationalFrame,
    unresolvedNeed: needData.unresolvedNeed,
    needConfidence: needData.needConfidence,
    lastUserGoal,
    conversationMode,
    emotionalPressure,
    technicalLevelSignal,
    brevityPreferenceSignal,
    ellipticitySignal,
    continuityAnchors,
    summary
  };
}

// ======================================================
// 4. CONTEXT SHIFT DETECTOR
// ======================================================

export function detectContextShift({
  currentText,
  generalIntent,
  extractedSignals,
  previousShortMemory
}) {
  const prev = previousShortMemory || DEFAULT_SHORT_MEMORY;
  const currentTopic = extractedSignals.activeTopic || "generic";
  const prevTopic = prev.activeTopic || "generic";
  const currentDomain = generalIntent.primaryDomain || "general";
  const prevMode = prev.conversationMode || "dialogue";

  const topicChanged =
    currentTopic !== "generic" &&
    prevTopic !== "generic" &&
    currentTopic !== prevTopic;

  const domainMappedTopic = mapDomainToTopic(currentDomain);
  const hardDomainShift =
    prevTopic !== "generic" &&
    domainMappedTopic !== "generic" &&
    prevTopic !== domainMappedTopic &&
    extractedSignals.activeTopic !== null;

  const currentHasStrongSignal =
    hasStrongIntentSignal(generalIntent.intentScores) ||
    textHasStrongDomainSignal(currentText) ||
    currentTopic !== "generic" ||
    generalIntent.primaryDomain === "health" ||
    generalIntent.primaryDomain === "family";

  const ellipticity = Number(extractedSignals.ellipticitySignal || 0);

  let shiftStrength = 0;

  if (topicChanged) shiftStrength += 0.32;
  if (hardDomainShift) shiftStrength += 0.28;
  if (currentHasStrongSignal) shiftStrength += 0.18;
  if (ellipticity < 0.4) shiftStrength += 0.08;

  shiftStrength = clamp01(shiftStrength);

  const shouldSoftReset = shiftStrength >= 0.52;
  const shouldHardReset = shiftStrength >= 0.78;

  const memoryCanAssist =
    !shouldHardReset &&
    ellipticity >= 0.52 &&
    !currentHasStrongSignal &&
    generalIntent.primaryDomain !== "health" &&
    generalIntent.primaryDomain !== "family";

  return {
    previousTopic: prevTopic,
    currentTopic,
    previousMode: prevMode,
    currentDomain,
    topicChanged,
    hardDomainShift,
    shiftStrength,
    shouldSoftReset,
    shouldHardReset,
    currentHasStrongSignal,
    memoryCanAssist
  };
}

function mapDomainToTopic(domain) {
  switch (domain) {
    case "technical": return "technical_system_design";
    case "health": return "health_observation";
    case "family": return "child_context";
    case "language": return "grammar_language";
    case "memory": return "memory_architecture";
    case "writing": return "writing_transformation";
    default: return "generic";
  }
}

// ======================================================
// 5. SHORT MEMORY DINAMICA
// ======================================================

export function updateShortMemory({
  prevState,
  extracted,
  generalIntent,
  contextShift
}) {
  const prev = prevState || DEFAULT_SHORT_MEMORY;

  const useNewTopic =
    extracted.activeTopic &&
    extracted.activeTopic !== "generic";

  const useNewRelationalFrame =
    extracted.relationalFrame &&
    extracted.relationalFrame !== "generic";

  const useNewNeed =
    extracted.unresolvedNeed &&
    Number(extracted.needConfidence || 0) >= 0.58;

  const baseEntities = contextShift.shouldHardReset ? [] : prev.activeEntities;
  const baseAnchors = contextShift.shouldHardReset ? [] : prev.continuityAnchors;
  const emotionBase = contextShift.shouldSoftReset ? 0 : prev.emotionalPressure;

  return {
    activeEntities: mergeEntities(baseEntities, extracted.entities),

    activeTopic: useNewTopic
      ? extracted.activeTopic
      : (
          contextShift.shouldSoftReset ||
          generalIntent?.primaryDomain === "health" ||
          generalIntent?.primaryDomain === "family"
        )
          ? null
          : prev.activeTopic,

    subTopic: (
      contextShift.shouldSoftReset ||
      generalIntent?.primaryDomain === "health" ||
      generalIntent?.primaryDomain === "family"
    )
      ? (extracted.subTopic || null)
      : (extracted.subTopic || prev.subTopic),

    relationalFrame: useNewRelationalFrame
      ? extracted.relationalFrame
      : (contextShift.shouldSoftReset ? "generic" : prev.relationalFrame),

    unresolvedNeed: useNewNeed
      ? extracted.unresolvedNeed
      : (contextShift.shouldSoftReset ? null : prev.unresolvedNeed),

    lastUserGoal: extracted.lastUserGoal || prev.lastUserGoal,
    conversationMode: extracted.conversationMode || prev.conversationMode,

    emotionalPressure: smoothAsymmetric(
      emotionBase,
      extracted.emotionalPressure
    ),

    technicalLevelSignal: smoothValue(prev.technicalLevelSignal, extracted.technicalLevelSignal, 0.55),
    brevityPreferenceSignal: smoothValue(prev.brevityPreferenceSignal, extracted.brevityPreferenceSignal, 0.5),

    continuityAnchors: updateAnchors(baseAnchors, extracted.continuityAnchors),
    summary: extracted.summary || prev.summary || "",
    updatedAt: new Date().toISOString()
  };
}

// ======================================================
// 6. ROUTER GENERALE UNIVERSALE
// ======================================================

export function generalIntentRouter(text) {
  const t = normalize(text);

  const intentScores = scoreMap(INTENT_KEYS, 0);
  let domainScores = scoreMap(DOMAIN_KEYS, 0);

  // ---------- INTENT ----------

  if (hasAny(t, [
    "cos'è", "che cos'è", "spiegami", "perché", "come funziona",
    "che significa", "qual è la differenza", "dimmi cos'è",
    "cosa sono", "qual è"
  ])) {
    intentScores.inform += 0.9;
  }

  if (hasAny(t, [
    "è normale", "dovrebbe", "va bene se", "mi devo preoccupare",
    "è grave", "è un problema", "ti sembra normale",
    "sono preoccupato", "sono un po preoccupato", "mi preoccupa",
    "sono in ansia", "ho paura", "non so se preoccuparmi"
  ])) {
    intentScores.reassure += 0.95;
  }

  if (hasAny(t, [
    "come faccio", "come si fa", "procedi", "vai", "fai", "scrivimi",
    "genera", "costruisci", "fammi", "dammi il codice", "passi", "procedura"
  ])) {
    intentScores.instruct += 0.92;
  }

  if (hasAny(t, [
    "quale conviene", "meglio", "ha senso", "vale la pena",
    "cosa scelgo", "quale scelgo", "che faccio"
  ])) {
    intentScores.decide += 0.85;
  }

  if (hasAny(t, [
    "ricordo", "ricordi", "ricorda", "ricordare", "ti ricordi", "memoria", "memoria orbitale",
    "recall", "ippocampo", "supermemory", "passato", "prima", "mi avevi detto",
    "ne avevamo parlato", "tempo fa"
  ])) {
    intentScores.recall += 0.95;
  }

  if (hasAny(t, [
    "non funziona", "errore", "bug", "crash", "fix", "debug",
    "si blocca", "non parte", "non risponde", "rottura"
  ])) {
    intentScores.troubleshoot += 0.96;
  }

  if (hasAny(t, [
    "che ne pensi", "come la vedi", "voglio capire", "ragioniamo",
    "analizziamo", "riflettiamo", "fammi ragionare"
  ])) {
    intentScores.reflect += 0.8;
  }

  if (hasAny(t, [
    "riscrivi", "riassumi", "traduci", "migliora", "correggi",
    "trasforma", "rendilo più", "rifallo"
  ])) {
    intentScores.transform += 0.92;
  }

  if (hasAny(t, [
    "idee", "brainstorm", "alternative", "spunti", "proposte"
  ])) {
    intentScores.brainstorm += 0.84;
  }

  if (hasAny(t, [
    "ciao", "grazie", "buongiorno", "buonasera", "come stai"
  ])) {
    intentScores.social += 0.7;
  }

  // ---------- DOMAIN ----------

  if (hasAny(t, [
    "docker", "server", "api", "json", "regex", "gpu", "token",
    "prompt", "javascript", "node", "express", "python", "frontend",
    "backend", "database", "llm", "router", "bug", "runtime"
  ])) {
    domainScores.technical += 0.96;
  }

  if (hasAny(t, [
    "febbre", "farmaco", "antibiotico", "urine", "referto", "sintomo",
    "medico", "dolore", "diagnosi", "esame", "terapia",
    "sindrome", "angelman", "neurologico", "genetica", "genetico",
    "sviluppo neurologico", "coordinazione", "atassia", "condizione rara"
  ])) {
    domainScores.health += 0.95;
  }

  if (hasAny(t, [
    "figlio", "figlia", "bambino", "bambina", "moglie", "marito",
    "mamma", "papà", "famiglia", "mio figlio", "mia figlia",
    "marco", "elena"
  ])) {
    domainScores.family += 0.9;
  }

  if (hasAny(t, [
    "cliente", "lavoro", "collega", "azienda", "progetto cliente"
  ])) {
    domainScores.work += 0.82;
  }

  if (hasAny(t, [
    "soldi", "costo", "budget", "preventivo", "fattura", "finanziamento",
    "spesa", "euro", "dollari"
  ])) {
    domainScores.finance += 0.82;
  }

  if (hasAny(t, [
    "viaggio", "hotel", "volo", "vacanza", "destinazione"
  ])) {
    domainScores.travel += 0.8;
  }

  if (hasAny(t, [
    "studiare", "esame", "lezione", "imparare", "scuola", "università"
  ])) {
    domainScores.education += 0.78;
  }

  if (hasAny(t, [
    "verbo", "verbi", "passato remoto", "coniugazione", "grammatica",
    "analisi grammaticale", "analisi logica", "aggettivo", "sostantivo",
    "predicato", "complemento", "tempo verbale"
  ])) {
    domainScores.language += 0.95;
  }

  if (hasAny(t, [
    "memoria", "memoria orbitale", "contesto", "short memory", "middle memory", "ricordo",
    "ricordi", "ricordare", "recall", "ippocampo", "supermemory"
  ])) {
    domainScores.memory += 0.88;
  }

  if (hasAny(t, [
    "testo", "lettera", "email", "riassunto", "riscrivi", "traduci"
  ])) {
    domainScores.writing += 0.82;
  }

  domainScores.general += 0.25;

  domainScores = resolveDomainConflicts(t, domainScores);

  const primaryIntent = topKey(intentScores, "inform");
  const primaryDomain = topKey(domainScores, "general");
  const secondaryDomain = secondTopKey(domainScores, null);

  return {
    intentScores,
    domainScores,
    primaryIntent,
    primaryDomain,
    secondaryDomain,
    confidence: Math.max(intentScores[primaryIntent] || 0.2, 0.2)
  };
}

// ======================================================
// 7. ROUTER + SHORT MEMORY
// ======================================================

export function routeIntentWithShortMemory({
  text,
  generalIntent,
  shortMemory,
  extractedSignals,
  contextShift
}) {
  const t = normalize(text);

  let primaryIntent = generalIntent.primaryIntent;
  let primaryDomain = generalIntent.primaryDomain;
  const intentScores = { ...generalIntent.intentScores };
  const domainScores = { ...generalIntent.domainScores };

  const currentHasStrongIntent = hasStrongIntentSignal(intentScores);
  const currentHasStrongDomain = textHasStrongDomainSignal(t) || primaryDomain !== "general";
  const currentTurnWins =
    currentHasStrongIntent ||
    currentHasStrongDomain ||
    contextShift.shouldSoftReset ||
    primaryDomain === "health" ||
    primaryDomain === "family";

  // override forte per reassurance sanitaria/familiare
  if (
    hasAny(t, [
      "sono preoccupato", "sono un po preoccupato", "mi preoccupa",
      "è normale", "devo preoccuparmi", "ho paura"
    ]) &&
    (primaryDomain === "health" || primaryDomain === "family")
  ) {
    primaryIntent = "reassure";
    intentScores.reassure = Math.max(intentScores.reassure, 0.96);
  }

  if (!currentTurnWins && contextShift.memoryCanAssist) {
    if (shortMemory.unresolvedNeed === "reassurance") {
      primaryIntent = "reassure";
      intentScores.reassure = Math.max(intentScores.reassure, 0.84);
    } else if (shortMemory.unresolvedNeed === "troubleshooting") {
      primaryIntent = "troubleshoot";
      intentScores.troubleshoot = Math.max(intentScores.troubleshoot, 0.84);
    } else if (shortMemory.unresolvedNeed === "decision") {
      primaryIntent = "decide";
      intentScores.decide = Math.max(intentScores.decide, 0.82);
    } else if (shortMemory.unresolvedNeed === "recall") {
      primaryIntent = "recall";
      intentScores.recall = Math.max(intentScores.recall, 0.82);
    } else if (shortMemory.unresolvedNeed === "explanation") {
      primaryIntent = "inform";
      intentScores.inform = Math.max(intentScores.inform, 0.8);
    }

    if (primaryDomain === "general") {
      if (shortMemory.activeTopic === "technical_system_design") {
        primaryDomain = "technical";
        domainScores.technical = Math.max(domainScores.technical, 0.8);
      } else if (shortMemory.activeTopic === "health_observation") {
        primaryDomain = "health";
        domainScores.health = Math.max(domainScores.health, 0.8);
      } else if (shortMemory.activeTopic === "grammar_language") {
        primaryDomain = "language";
        domainScores.language = Math.max(domainScores.language, 0.8);
      } else if (shortMemory.activeTopic === "memory_architecture") {
        primaryDomain = "memory";
        domainScores.memory = Math.max(domainScores.memory, 0.8);
      } else if (shortMemory.relationalFrame === "family") {
        primaryDomain = "family";
        domainScores.family = Math.max(domainScores.family, 0.75);
      }
    }
  }

  const personalRelevance = (
    shortMemory.relationalFrame === "family" ||
    shortMemory.relationalFrame === "self"
  ) ? 0.75 : 0.25;

  const memoryDependency = contextShift.memoryCanAssist ? 0.72 : 0.18;

  return {
    primaryIntent,
    primaryDomain,
    secondaryDomain: generalIntent.secondaryDomain || null,
    intentScores,
    domainScores,
    confidence: Math.max(intentScores[primaryIntent] || 0.2, generalIntent.confidence),
    activeTopic: shortMemory.activeTopic,
    subTopic: shortMemory.subTopic,
    relationalFrame: shortMemory.relationalFrame,
    unresolvedNeed: shortMemory.unresolvedNeed,
    conversationMode: shortMemory.conversationMode,
    personalRelevance,
    memoryDependency,
    currentTurnWins
  };
}

// ======================================================
// 8. RESPONSE SHAPER
// ======================================================

export function responseShaper({
  text,
  intentState,
  shortMemory,
  extractedSignals,
  userPreferences = {}
}) {
  const shape = {
    directness: 0.7,
    warmth: 0.25,
    brevity: 0.55,
    technicality: 0.5,
    depth: 0.55,
    firstSentence: "answer_first",
    structure: "compact_paragraphs",
    reasoningStyle: "balanced"
  };

  const mode = intentState.primaryIntent;
  const domain = intentState.primaryDomain;
  const emotionalPressure = shortMemory.emotionalPressure || 0;

  if (mode === "social") {
    shape.directness = 0.72;
    shape.warmth = 0.72;
    shape.brevity = 0.88;
    shape.technicality = 0.05;
    shape.depth = 0.18;
    shape.firstSentence = "answer_first";
    shape.reasoningStyle = "low_entropy_human";
  }

  if (mode === "reassure") {
    shape.directness = 0.95;
    shape.warmth = 0.78;
    shape.brevity = 0.88;
    shape.technicality = domain === "health" ? 0.32 : 0.16;
    shape.depth = 0.32;
    shape.firstSentence = "reassure_first";
    shape.reasoningStyle = "low_entropy_human";
  }

  if (mode === "inform") {
    shape.directness = 0.9;
    shape.warmth = 0.2;
    shape.brevity = 0.58;
    shape.technicality = domain === "technical" ? 0.92 : (domain === "language" ? 0.45 : 0.42);
    shape.depth = 0.72;
    shape.firstSentence = "thesis_first";
    shape.reasoningStyle = "structured_explanatory";
  }

  if (mode === "instruct") {
    shape.directness = 0.96;
    shape.warmth = 0.18;
    shape.brevity = 0.7;
    shape.technicality = domain === "technical" ? 0.92 : 0.58;
    shape.depth = 0.68;
    shape.firstSentence = "action_first";
    shape.structure = "steps";
    shape.reasoningStyle = "execution_oriented";
  }

  if (mode === "troubleshoot") {
    shape.directness = 0.97;
    shape.warmth = 0.14;
    shape.brevity = 0.72;
    shape.technicality = 0.95;
    shape.depth = 0.84;
    shape.firstSentence = "diagnosis_first";
    shape.structure = "diagnostic_steps";
    shape.reasoningStyle = "causal_narrowing";
  }

  if (mode === "recall") {
    shape.directness = 0.86;
    shape.warmth = 0.34;
    shape.brevity = 0.58;
    shape.technicality = 0.18;
    shape.depth = 0.64;
    shape.firstSentence = "memory_first";
    shape.reasoningStyle = "memory_grounded";
  }

  if (mode === "transform") {
    shape.directness = 0.94;
    shape.warmth = 0.18;
    shape.brevity = 0.66;
    shape.technicality = 0.55;
    shape.depth = 0.6;
    shape.firstSentence = "action_first";
    shape.reasoningStyle = "execution_oriented";
  }

  if (emotionalPressure > 0.45 && (mode === "reassure" || domain === "health")) {
    shape.warmth = Math.min(shape.warmth + 0.12, 1);
  }

  if (shortMemory.technicalLevelSignal > 0.75) {
    shape.technicality = Math.min(shape.technicality + 0.14, 1);
    shape.depth = Math.min(shape.depth + 0.08, 1);
  }

  if (shortMemory.brevityPreferenceSignal > 0.7) {
    shape.brevity = Math.min(shape.brevity + 0.18, 1);
    shape.depth = Math.max(shape.depth - 0.12, 0.2);
  }

  if (userPreferences.preferredStyle === "direct") {
    shape.brevity = Math.min(shape.brevity + 0.12, 1);
    shape.depth = Math.max(shape.depth - 0.1, 0.2);
  }

  if (userPreferences.preferredStyle === "technical_stepwise") {
    shape.technicality = Math.min(shape.technicality + 0.15, 1);
    if (shape.structure === "compact_paragraphs") {
      shape.structure = "steps";
    }
  }

  if (looksAmbiguousForClarification(text, intentState)) {
    shape.firstSentence = "clarify_first";
    shape.reasoningStyle = "ambiguity_safe";
    shape.brevity = Math.min(shape.brevity + 0.1, 1);
  }

  return shape;
}

// ======================================================
// 9. PROMPT DIRECTIVES
// ======================================================

export function buildPromptDirectives({
  text,
  shortMemory,
  intentState,
  responseShape,
  extractedSignals,
  contextShift,
  domainRoute
}) {
  return buildCompactPromptDirectives({
    shortMemory,
    intentState,
    responseShape,
    extractedSignals,
    contextShift,
    domainRoute
  });
}

function buildCompactPromptDirectives({
  shortMemory,
  intentState,
  responseShape,
  extractedSignals,
  contextShift,
  domainRoute
}) {
  const criticalRules = [];

  criticalRules.push("Rispondi alla richiesta attuale.");
  criticalRules.push("Non inferire paure, diagnosi o problemi non espressi.");
  criticalRules.push("Se il turno attuale contraddice il contesto precedente, prevale il turno attuale.");

  if (looksAmbiguousForClarification(extractedSignals?.rawCurrentText || "", intentState)) {
    criticalRules.push("Se serve, chiedi una sola chiarificazione breve e neutra.");
  }

  if (intentState.primaryDomain === "family" && intentState.primaryIntent === "inform") {
    criticalRules.push("Non trattare questa richiesta come emotiva o clinica: è una domanda informativa.");
  }

  if (intentState.primaryDomain === "language") {
    criticalRules.push("Tratta la richiesta come linguistica o scolastica, non come sanitaria o emotiva.");
  }

  if (contextShift.shouldSoftReset || contextShift.shouldHardReset) {
    criticalRules.push("È stato rilevato un cambio di contesto: non trascinare il bisogno del topic precedente.");
  }

  if (domainRoute?.domainSource === "user_override") {
    criticalRules.push("L’utente ha esplicitamente escluso o cambiato dominio. Non ereditare il dominio precedente.");
  }

  if (domainRoute?.domainSource === "green_context") {
    criticalRules.push("Il dominio è ereditato da contesto green recente. Usalo solo come continuità contestuale, senza ignorare eventuali nuove istruzioni dell’utente.");
  }

  const responseProfile = domainRoute?.responseProfile && typeof domainRoute.responseProfile === "object"
    ? Object.entries(domainRoute.responseProfile).map(([key, value]) => `${key}:${value}`).join(" | ")
    : "none";

  const domainRouteBlock = domainRoute?.contextLift
    ? `
[DOMAIN ROUTE]
base_intent=${domainRoute.baseIntent}
domain_intent=${domainRoute.domainIntent}
subdomain=${domainRoute.subdomain}
domain_source=${domainRoute.domainSource}
response_profile=${responseProfile}
voice_calibration=${domainRoute.voiceCalibration}
confidence=${round(domainRoute.confidence)}
signals=${Array.isArray(domainRoute.signals) && domainRoute.signals.length ? domainRoute.signals.join(" | ") : "none"}
context_lift=${domainRoute.contextLift}
`
    : "";

  return `
[ACTIVE INTERPRETATION]
intent=${intentState.primaryIntent}
domain=${intentState.primaryDomain}
topic=${shortMemory.activeTopic || "generic"}
sub_topic=${shortMemory.subTopic || "none"}
need=${shortMemory.unresolvedNeed || "none"}
current_turn_wins=${intentState.currentTurnWins}
memory_can_assist=${contextShift.memoryCanAssist}
${domainRouteBlock}
[RESPONSE MODE]
style=${responseShape.reasoningStyle}
first_sentence=${responseShape.firstSentence}
structure=${responseShape.structure}
brevity=${round(responseShape.brevity)}
warmth=${round(responseShape.warmth)}
technicality=${round(responseShape.technicality)}
depth=${round(responseShape.depth)}

[CRITICAL RULES]
${criticalRules.map(r => `- ${r}`).join("\n")}
`.trim();
}

// ======================================================
// 10. TOPIC / NEED / GOAL INFERENCE
// ======================================================

function inferTopicGeneric(text) {
  if (hasAny(text, [
    "docker", "server", "api", "backend", "frontend", "prompt",
    "gpu", "router", "json", "javascript", "node", "python"
  ])) return "technical_system_design";

  if (hasAny(text, [
    "verbo", "verbi", "passato remoto", "coniugazione", "grammatica",
    "analisi grammaticale", "analisi logica", "aggettivo", "sostantivo",
    "predicato", "complemento", "tempo verbale"
  ])) return "grammar_language";

  if (hasAny(text, [
    "farmaco", "antibiotico", "urine", "referto", "sintomo", "medico",
    "sindrome", "angelman", "genetica", "genetico", "neurologico",
    "atassia", "dolore", "febbre", "vaccino", "diagnosi", "terapia"
  ])) return "health_observation";

  if (hasAny(text, [
    "bambino", "bambina", "figlio", "figlia", "sviluppo",
    "giorni della settimana", "ieri", "domani", "marco", "elena"
  ])) return "child_context";

  if (hasAny(text, [
    "memoria", "short memory", "middle memory", "contesto", "ricordi"
  ])) return "memory_architecture";

  if (hasAny(text, [
    "email", "riassunto", "testo", "prompt", "riscrivi", "traduci"
  ])) return "writing_transformation";

  return "generic";
}

function inferSubTopicGeneric(text, activeTopic) {
  if (activeTopic === "technical_system_design") {
    if (hasAny(text, ["intent", "router", "routing"])) return "intent_routing";
    if (hasAny(text, ["short memory", "middle memory", "memory"])) return "memory_layer";
    if (hasAny(text, ["bug", "errore", "fix", "debug"])) return "bug_fixing";
  }

  if (activeTopic === "grammar_language") {
    if (hasAny(text, ["passato remoto", "tempo verbale"])) return "verb_tense";
    if (hasAny(text, ["verbi composti", "verbo composto"])) return "verb_structure";
    if (hasAny(text, ["analisi grammaticale", "analisi logica"])) return "school_grammar";
  }

  if (activeTopic === "child_context") {
    if (hasAny(text, ["giorni della settimana", "ieri", "domani"])) return "temporal_concepts";
  }

  if (activeTopic === "memory_architecture") {
    if (hasAny(text, ["short memory"])) return "short_memory";
    if (hasAny(text, ["middle memory"])) return "middle_memory";
    if (hasAny(text, ["orbitale"])) return "orbital_memory";
  }

  return null;
}

function inferRelationalFrame(text) {
  if (hasAny(text, [
    "mio figlio", "mia figlia", "moglie", "marito", "mamma", "papà", "famiglia"
  ])) return "family";

  if (hasAny(text, ["cliente", "collega", "capo", "azienda"])) return "work";
  if (hasAny(text, ["cane", "gatto", "animale"])) return "pet";
  if (hasAny(text, ["lui", "lei", "un amico", "una persona"])) return "third_party";
  if (hasAny(text, ["io", "me", "a me", "per me"])) return "self";

  return "generic";
}

function inferNeedGeneric({ currentText, recentText }) {
  const t = normalize(currentText);
  const recent = normalize(recentText);

  if (hasAny(t, [
    "è normale", "dovrebbe", "devo preoccuparmi", "è grave",
    "sono preoccupato", "sono un po preoccupato", "mi preoccupa",
    "ho paura", "non so se preoccuparmi"
  ])) {
    return { unresolvedNeed: "reassurance", needConfidence: 0.94 };
  }

  if (hasAny(t, ["perché", "come funziona", "spiegami", "cosa sono", "qual è", "che significa"])) {
    return { unresolvedNeed: "explanation", needConfidence: 0.9 };
  }

  if (hasAny(t, ["quale conviene", "meglio", "ha senso", "vale la pena"])) {
    return { unresolvedNeed: "decision", needConfidence: 0.9 };
  }

  if (hasAny(t, ["come faccio", "passi", "procedi", "fai", "scrivimi"])) {
    return { unresolvedNeed: "next_step", needConfidence: 0.91 };
  }

  if (hasAny(t, ["errore", "bug", "non funziona", "fix", "debug"])) {
    return { unresolvedNeed: "troubleshooting", needConfidence: 0.94 };
  }

  if (hasAny(t, ["ricordi", "memoria", "prima", "mi avevi detto"])) {
    return { unresolvedNeed: "recall", needConfidence: 0.93 };
  }

  const ell = inferEllipticity(t);

  if (ell >= 0.55) {
    if (hasAny(recent, ["errore", "bug", "fix", "debug"])) {
      return { unresolvedNeed: "troubleshooting", needConfidence: 0.63 };
    }
    if (hasAny(recent, ["quale conviene", "meglio", "ha senso"])) {
      return { unresolvedNeed: "decision", needConfidence: 0.62 };
    }
    if (hasAny(recent, ["ricordi", "memoria", "prima"])) {
      return { unresolvedNeed: "recall", needConfidence: 0.62 };
    }
    if (hasAny(recent, ["spiegami", "come funziona", "cosa sono", "qual è"])) {
      return { unresolvedNeed: "explanation", needConfidence: 0.58 };
    }
  }

  return { unresolvedNeed: "explanation", needConfidence: 0.38 };
}

function inferGoalGeneric(currentText) {
  const t = normalize(currentText);

  if (hasAny(t, ["voglio capire", "spiegami", "come la vedi"])) return "understand";
  if (hasAny(t, ["quale conviene", "meglio", "ha senso"])) return "decide";
  if (hasAny(t, ["procedi", "costruisci", "scrivi", "genera", "scrivimi"])) return "build";
  if (hasAny(t, ["fix", "debug", "risolvi", "non funziona"])) return "fix";
  if (hasAny(t, ["ricordi", "memoria"])) return "recall";
  if (hasAny(t, ["riscrivi", "traduci", "riassumi"])) return "transform";

  return "talk";
}

function inferConversationMode(lastTurns, currentText) {
  const recent = normalize(
    lastTurns.slice(-4).map(t => safeText(t.text)).join(" ") + " " + currentText
  );

  if (hasAny(recent, ["procedi", "montiamo", "scrivi", "genera", "fai il file", "scrivimi"])) return "execution";
  if (hasAny(recent, ["bug", "errore", "debug", "fix", "non funziona"])) return "debugging";
  if (hasAny(recent, ["voglio capire", "ragioniamo", "analizziamo", "come la vedi"])) return "exploration";
  if (hasAny(recent, ["riflettiamo", "pensiero", "concetto"])) return "reflection";
  return "dialogue";
}

// ======================================================
// 11. SIGNALS
// ======================================================

function inferEmotionalPressure(currentText) {
  const current = normalize(currentText);
  let score = 0.03;

  if (hasAny(current, [
    "ho paura", "sono preoccupato", "sono un po preoccupato", "mi preoccupa",
    "oddio", "ansia", "aiuto", "grave", "sto male", "non so che fare"
  ])) score += 0.72;

  if (hasAny(current, [
    "mio figlio sta male", "mia figlia sta male", "referto", "sintomo", "dolore",
    "sindrome", "angelman", "diagnosi", "neurologico", "genetica"
  ])) score += 0.22;

  return clamp01(score);
}

function inferTechnicalSignal(joinedText) {
  let score = 0.05;
  if (hasAny(joinedText, [
    "docker", "server", "api", "json", "prompt", "regex", "runtime",
    "gpu", "backend", "frontend", "router", "node", "express", "python"
  ])) score += 0.82;
  return clamp01(score);
}

function inferBrevitySignal(joinedText) {
  let score = 0.1;
  if (hasAny(joinedText, [
    "diretto", "breve", "sintetico", "senza giri", "poco prolisso", "vai dritto"
  ])) score += 0.7;
  return clamp01(score);
}

function inferEllipticity(text) {
  const t = normalize(text);
  let score = 0.02;

  if (tokenCountApprox(t) <= 8) score += 0.28;
  if (tokenCountApprox(t) <= 4) score += 0.18;

  if (hasAny(t, [
    "quello", "quella", "questo", "questa",
    "quindi", "allora", "e poi", "anche questo",
    "anche quella", "pure questo", "pure quello",
    "come mai", "perché", "e per", "quale dei due", "comunque", "a proposito"
  ])) {
    score += 0.4;
  }

  if (hasAny(t, ["?", "mh", "boh"])) {
    score += 0.08;
  }

  return clamp01(score);
}

function inferAnchors({ lastTurns, currentText, activeTopic, unresolvedNeed }) {
  const anchors = [];

  if (activeTopic && activeTopic !== "generic") {
    anchors.push(`topic:${activeTopic}`);
  }

  if (unresolvedNeed) {
    anchors.push(`need:${unresolvedNeed}`);
  }

  const recentUser = lastTurns.filter(t => t?.role === "user").slice(-2);
  for (const turn of recentUser) {
    const small = truncateClean(turn.text, 60);
    if (small) anchors.push(`recent:${small}`);
  }

  const currentSmall = truncateClean(currentText, 60);
  if (currentSmall) anchors.push(`current:${currentSmall}`);

  return anchors.slice(-6);
}

function buildShortSummary({
  activeTopic,
  subTopic,
  relationalFrame,
  unresolvedNeed,
  lastUserGoal,
  conversationMode
}) {
  return [
    `topic=${activeTopic || "generic"}`,
    `sub=${subTopic || "none"}`,
    `frame=${relationalFrame || "generic"}`,
    `need=${unresolvedNeed || "none"}`,
    `goal=${lastUserGoal || "talk"}`,
    `mode=${conversationMode || "dialogue"}`
  ].join(" | ");
}

// ======================================================
// 12. ENTITY EXTRACTION GENERICA
// ======================================================

function extractEntitiesGeneric(text) {
  const raw = safeText(text);
  const candidates = [];

  const patterns = [
    /\b(mio figlio|mia figlia|mio marito|mia moglie|mia mamma|mio padre)\b/g,
    /\b(bambino|bambina|figlio|figlia|cliente|collega|server|prompt|router|docker|api|memoria|verbo|grammatica|passato remoto|marco|elena|angelman)\b/g,
    /\b([a-zàèéìòù]{3,}\s(?:di|del|della|dello)\s[a-zàèéìòù]{3,})\b/g
  ];

  for (const pattern of patterns) {
    const matches = raw.toLowerCase().match(pattern);
    if (matches) {
      for (const m of matches) candidates.push(m.trim());
    }
  }

  return uniqueClean(candidates).slice(0, 10);
}

// ======================================================
// 13. DOMAIN CONFLICT RESOLUTION
// ======================================================

function resolveDomainConflicts(text, domainScores) {
  const t = normalize(text);
  const out = { ...domainScores };

  // technical vs writing
  if (out.technical >= 0.65 && out.writing >= 0.55) {
    if (hasAny(t, ["email", "lettera", "post", "messaggio", "testo", "descrizione"])) {
      out.writing += 0.22;
    }
    if (hasAny(t, ["api", "server", "backend", "frontend", "llm", "json", "docker", "javascript", "node"])) {
      out.technical += 0.22;
    }
    if (hasAny(t, ["prompt per un'email", "prompt per email", "scrivimi un prompt"])) {
      out.writing += 0.15;
    }
  }

  // family vs health
  if (out.family >= 0.65 && out.health >= 0.65) {
    if (hasAny(t, [
      "sintomo", "referto", "diagnosi", "terapia", "farmaco", "dolore", "esame",
      "sindrome", "angelman", "neurologico", "genetica", "vaccino", "febbre"
    ])) {
      out.health += 0.2;
    }
    if (hasAny(t, ["scuola", "compiti", "giorni della settimana", "passato remoto", "grammatica"])) {
      out.family += 0.12;
    }
  }

  // education vs language
  if (out.education >= 0.6 && out.language >= 0.7) {
    if (hasAny(t, ["verbo", "grammatica", "coniugazione", "analisi grammaticale", "passato remoto"])) {
      out.language += 0.18;
    }
  }

  return out;
}

// ======================================================
// 14. HELPERS
// ======================================================

function scoreMap(keys, base = 0) {
  return Object.fromEntries(keys.map(k => [k, base]));
}

function safeText(v) {
  return typeof v === "string" ? v : "";
}

function normalize(text = "") {
  return safeText(text)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function hasAny(text, patterns = []) {
  const t = normalize(text);
  return patterns.some(p => t.includes(normalize(p)));
}

function topKey(obj, fallback = null) {
  const entries = Object.entries(obj);
  if (!entries.length) return fallback;
  entries.sort((a, b) => b[1] - a[1]);
  return entries[0][0] || fallback;
}

function secondTopKey(obj, fallback = null) {
  const entries = Object.entries(obj);
  if (entries.length < 2) return fallback;
  entries.sort((a, b) => b[1] - a[1]);
  return entries[1]?.[0] || fallback;
}

function maxScore(obj = {}) {
  const vals = Object.values(obj);
  return vals.length ? Math.max(...vals) : 0;
}

function clamp01(n) {
  return Math.max(0, Math.min(1, Number(n) || 0));
}

function smoothValue(prev, next, carry = 0.6) {
  const p = Number(prev) || 0;
  const n = Number(next) || 0;
  return clamp01((p * carry) + (n * (1 - carry)));
}

function smoothAsymmetric(prev, next) {
  const p = Number(prev) || 0;
  const n = Number(next) || 0;

  if (n > p) {
    return clamp01((p * 0.35) + (n * 0.65));
  }

  return clamp01((p * 0.75) + (n * 0.25));
}

function mergeEntities(prev = [], next = []) {
  return uniqueClean([...(prev || []), ...(next || [])]).slice(-12);
}

function uniqueClean(arr = []) {
  return [...new Set(
    arr
      .map(x => safeText(x).trim().toLowerCase())
      .filter(Boolean)
  )];
}

function updateAnchors(prev = [], next = []) {
  return uniqueClean([...(prev || []), ...(next || [])]).slice(-8);
}

function truncateClean(text, max = 60) {
  const t = safeText(text).replace(/\s+/g, " ").trim();
  if (!t) return "";
  return t.length <= max ? t : `${t.slice(0, max - 3)}...`;
}

function round(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function tokenCountApprox(text) {
  return safeText(text).trim().split(/\s+/).filter(Boolean).length;
}

function textHasStrongDomainSignal(text) {
  const t = normalize(text);
  return hasAny(t, [
    "docker", "server", "api", "json", "regex", "gpu", "prompt",
    "farmaco", "referto", "sintomo", "febbre", "vaccino", "sindrome",
    "angelman", "diagnosi", "terapia", "neurologico", "genetica",
    "verbo", "grammatica", "passato remoto", "coniugazione",
    "bambino", "bambina", "figlio", "figlia", "marco", "elena",
    "preoccupato", "mi preoccupa", "ho paura"
  ]);
}

function hasStrongIntentSignal(intentScores = {}) {
  return maxScore(intentScores) >= 0.8;
}

function looksAmbiguousForClarification(text, intentState) {
  const t = normalize(text);
  const veryShort = tokenCountApprox(t) <= 5;

  return (
    veryShort &&
    !textHasStrongDomainSignal(t) &&
    intentState.confidence < 0.82 &&
    hasAny(t, ["quindi", "allora", "quale", "come mai", "perché", "quello", "quella"])
  );
}

// ======================================================
// 15. ESEMPIO D'USO
// ======================================================

/*
const result = analyzeConversationTurn({
  text: "marco ha la sindrome di angelman e sono un po preoccupato",
  lastTurns: [
    { role: "user", text: "ciao keblo cosa sono i verbi composti" },
    { role: "assistant", text: "..." }
  ],
  previousShortMemory: null,
  userPreferences: {
    preferredStyle: "direct"
  }
});

console.log(result.contextShift);
console.log(result.shortMemory);
console.log(result.refinedIntent);
console.log(result.promptDirectives);
*/
