const FALLBACK_ROUTE = Object.freeze({
  baseIntent: "inform",
  baseIntentSource: "generalIntentRouter",
  domainIntent: "general",
  subdomain: "general",
  responseProfile: {
    register: "neutral",
    tone: "balanced",
    rhetoric: "medium",
    structure: "compact",
    depth: "medium"
  },
  voiceCalibration: false,
  confidence: 0.25,
  signals: [],
  contextLift: false,
  domainSource: "fallback",
  fallback: true
});

export function routeDomainAwareIntent({
  text,
  generalIntent = null,
  shortMemory = null,
  lastTurns = []
} = {}) {
  const raw = safeText(text);
  const normalized = normalize(raw);
  const recent = normalizeGreenContext(lastTurns);
  const override = detectDomainOverride(normalized);

  const baseIntent = inferBaseIntent(normalized, generalIntent);
  const baseIntentSource = baseIntent === mapGeneralIntent(generalIntent?.primaryIntent)
    ? "generalIntentRouter"
    : "domainAwareRules";

  if (override.hasOverride) {
    return buildFallbackRoute({
      baseIntent,
      baseIntentSource,
      domainSource: "user_override",
      signals: override.signals,
      confidence: 0.9
    });
  }

  const currentWinner = bestCandidate([
    scoreSocialWork(normalized),
    scoreTechnicalDevelopment(normalized, shortMemory),
    scoreHealthMedical(normalized),
    scoreNewsIntelligence(normalized, generalIntent)
  ]);

  if (currentWinner && currentWinner.confidence >= 0.62) {
    return buildDomainRoute({
      baseIntent,
      baseIntentSource,
      winner: currentWinner,
      domainSource: "current_text"
    });
  }

  const contextWinner = bestCandidate([
    scoreSocialWork(recent),
    scoreTechnicalDevelopment(recent, shortMemory),
    scoreHealthMedical(recent),
    scoreNewsIntelligence(recent, generalIntent)
  ]);

  if (
    contextWinner &&
    contextWinner.confidence >= 0.62 &&
    isBaseIntentCompatibleWithDomain(baseIntent, contextWinner.domainIntent, normalized)
  ) {
    return buildDomainRoute({
      baseIntent,
      baseIntentSource,
      winner: {
        ...contextWinner,
        confidence: Math.min(contextWinner.confidence, 0.82),
        signals: contextWinner.signals.map(signal => `green:${signal}`)
      },
      domainSource: "green_context"
    });
  }

  return buildFallbackRoute({
    baseIntent,
    baseIntentSource,
    domainSource: "fallback",
    signals: [],
    confidence: FALLBACK_ROUTE.confidence
  });
}

export function detectDomainOverride(input) {
  const text = normalize(input);
  const overrideSignals = collectSignals(text, {
    generic: ["generica", "generico"],
    withoutReference: ["senza riferimento a", "senza riferimenti a", "senza parlare di"],
    doNotUse: ["non usare", "non collegarlo a", "non collegarla a"],
    topicChange: ["cambio argomento", "nuovo argomento", "lascia stare"],
    unrelated: ["non c'entra", "non centra", "non riguarda"]
  });

  const excludedDomainSignals = collectSignals(text, {
    social_work: [
      "adi",
      "case manager",
      "case management",
      "servizi sociali",
      "servizio sociale",
      "assegno di inclusione",
      "beneficiario",
      "presa in carico"
    ]
  });

  return {
    hasOverride: overrideSignals.length > 0,
    blocksSocialWork: excludedDomainSignals.includes("social_work"),
    signals: [...overrideSignals, ...excludedDomainSignals.map(signal => `exclude:${signal}`)]
  };
}

function buildDomainRoute({ baseIntent, baseIntentSource, winner, domainSource }) {
  return {
    baseIntent,
    baseIntentSource,
    domainIntent: winner.domainIntent,
    subdomain: winner.subdomain,
    responseProfile: winner.responseProfile,
    voiceCalibration: winner.voiceCalibration,
    confidence: roundConfidence(winner.confidence),
    signals: winner.signals,
    contextLift: true,
    domainSource,
    fallback: false
  };
}

function buildFallbackRoute({ baseIntent, baseIntentSource, domainSource, signals, confidence }) {
  return {
    ...FALLBACK_ROUTE,
    baseIntent,
    baseIntentSource,
    confidence: roundConfidence(confidence),
    signals,
    domainSource,
    contextLift: false,
    fallback: domainSource !== "user_override"
  };
}

function bestCandidate(candidates) {
  return candidates
    .filter(Boolean)
    .sort((a, b) => b.confidence - a.confidence)[0] || null;
}

function normalizeGreenContext(lastTurns = []) {
  return normalize(
    (Array.isArray(lastTurns) ? lastTurns : [])
      .filter(turn => turn?.role === "user" || turn?.role === "assistant")
      .slice(-6)
      .map(turn => safeText(turn.text))
      .join(" ")
  );
}

function scoreSocialWork(text) {
  const signals = collectSignals(text, {
    adi: ["adi", "assistenza domiciliare integrata"],
    caseManager: ["case manager", "case management", "care manager"],
    interview: ["intervista", "colloquio", "traccia", "domande"],
    socialWork: ["assistente sociale", "servizio sociale", "servizi sociali", "presa in carico", "fragilita", "anziano", "disabilita", "assegno di inclusione", "beneficiario"]
  });

  let confidence = 0;
  if (signals.includes("adi")) confidence += 0.35;
  if (signals.includes("caseManager")) confidence += 0.28;
  if (signals.includes("socialWork")) confidence += 0.24;
  if (signals.includes("interview")) confidence += 0.12;

  return {
    domainIntent: "social_work",
    subdomain: signals.includes("adi") || signals.includes("caseManager")
      ? "ADI_case_management"
      : "social_services",
    confidence,
    signals,
    responseProfile: {
      register: "professionale",
      tone: "umano_sobrio",
      rhetoric: "low",
      structure: "practical_outline",
      depth: "medium"
    },
    voiceCalibration: true
  };
}

function scoreTechnicalDevelopment(text, shortMemory) {
  const signals = collectSignals(text, {
    keblo: ["keblo", "nexus", "orbitale"],
    architecture: ["architettura", "pipeline", "engine", "router", "intent", "promptdirectives", "processinput"],
    code: ["javascript", "node", "express", "api", "server.js", "llm_router", "keblo_engine", "debug", "patch", "fix"],
    memory: ["short memory", "memoria", "context shift", "domain-aware", "domain aware"]
  });

  let confidence = 0;
  if (signals.includes("keblo")) confidence += 0.35;
  if (signals.includes("architecture")) confidence += 0.28;
  if (signals.includes("code")) confidence += 0.22;
  if (signals.includes("memory")) confidence += 0.14;
  if (shortMemory?.activeTopic === "technical_system_design") confidence += 0.08;

  return {
    domainIntent: "technical_development",
    subdomain: signals.includes("keblo") || signals.includes("memory")
      ? "keblo_architecture"
      : "software_engineering",
    confidence,
    signals,
    responseProfile: {
      register: "technical",
      tone: "direct_precise",
      rhetoric: "low",
      structure: "architectural_steps",
      depth: "high"
    },
    voiceCalibration: false
  };
}

function scoreHealthMedical(text) {
  const signals = collectSignals(text, {
    medical: ["febbre", "farmaco", "antibiotico", "referto", "sintomo", "diagnosi", "terapia", "medico", "clinico"],
    family: ["mio figlio", "mia figlia", "bambino", "bambina", "famiglia", "marco", "elena"],
    rareCondition: ["sindrome", "angelman", "neurologico", "genetico", "atassia"],
    concern: ["preoccupato", "preoccupata", "paura", "devo preoccuparmi", "e normale", "grave"]
  });

  let confidence = 0;
  if (signals.includes("medical")) confidence += 0.45;
  if (signals.includes("rareCondition")) confidence += 0.35;
  if (signals.includes("family")) confidence += 0.22;
  if (signals.includes("concern")) confidence += 0.12;
  if (signals.includes("rareCondition") && signals.includes("family")) confidence += 0.1;

  return {
    domainIntent: "health_medical",
    subdomain: signals.includes("family") || signals.includes("rareCondition")
      ? "clinical_family_context"
      : "general_health_context",
    confidence,
    signals,
    responseProfile: {
      register: "careful",
      tone: "calmo_non_diagnostico",
      rhetoric: "low",
      structure: "safety_first",
      depth: "medium"
    },
    voiceCalibration: true
  };
}

function scoreNewsIntelligence(text, generalIntent) {
  const signals = collectSignals(text, {
    news: ["news", "notizie", "aggiornami", "ultime", "oggi", "attualita"],
    worldBrief: ["world brief", "brief del mondo", "briefing mondo", "mondo", "geopolitica"],
    intelligence: ["analisi fonti", "fact check", "verifica fonti", "scenario", "segnali"],
    currentEvents: ["elezioni", "mercati", "guerra", "governo", "politica", "borsa"]
  });

  let confidence = 0;
  if (signals.includes("worldBrief")) confidence += 0.38;
  if (signals.includes("news")) confidence += 0.30;
  if (signals.includes("intelligence")) confidence += 0.20;
  if (signals.includes("currentEvents")) confidence += 0.16;
  if (generalIntent?.primaryDomain === "current_events") confidence += 0.1;

  return {
    domainIntent: "news_intelligence",
    subdomain: signals.includes("worldBrief") ? "world_brief" : "current_events_analysis",
    confidence,
    signals,
    responseProfile: {
      register: "analytical",
      tone: "sobrio_fonti_chiare",
      rhetoric: "low",
      structure: "briefing",
      depth: "medium"
    },
    voiceCalibration: false
  };
}

function isBaseIntentCompatibleWithDomain(baseIntent, domainIntent, text) {
  if (domainIntent === "social_work") {
    return baseIntent === "create_interview" || (baseIntent === "write" && hasAny(text, ["intervista", "traccia", "domande", "colloquio"]));
  }
  if (domainIntent === "technical_development") {
    return baseIntent === "fix_code" || baseIntent === "analyze" || hasAny(text, ["fix", "debug", "prossimo fix", "patch", "router"]);
  }
  if (domainIntent === "health_medical") {
    return baseIntent === "explain" || baseIntent === "analyze" || baseIntent === "write" || hasAny(text, ["referto", "sintomo", "farmaco", "febbre"]);
  }
  if (domainIntent === "news_intelligence") {
    return baseIntent === "explain" || baseIntent === "analyze" || hasAny(text, ["aggiornami", "news", "brief"]);
  }
  return false;
}

function inferBaseIntent(text, generalIntent) {
  if (hasAny(text, ["intervista", "traccia di intervista", "domande per intervista", "colloquio"])) {
    return "create_interview";
  }
  if (hasAny(text, ["scrivi", "scrivimi", "fammi", "genera", "crea", "costruisci"])) {
    return "write";
  }
  if (hasAny(text, ["spiegami", "cos'e", "che cos'e", "come funziona", "perche"])) {
    return "explain";
  }
  if (hasAny(text, ["analizza", "analisi", "valuta", "ragioniamo"])) {
    return "analyze";
  }
  if (hasAny(text, ["fix", "debug", "errore", "bug", "non funziona"])) {
    return "fix_code";
  }
  if (hasAny(text, ["piano", "pianifica", "roadmap", "step"])) {
    return "plan";
  }
  return mapGeneralIntent(generalIntent?.primaryIntent);
}

function mapGeneralIntent(intent) {
  switch (intent) {
    case "instruct": return "write";
    case "inform": return "explain";
    case "troubleshoot": return "fix_code";
    case "reflect": return "analyze";
    case "brainstorm": return "plan";
    case "transform": return "write";
    default: return intent || "explain";
  }
}

function collectSignals(text, groups) {
  const found = [];
  for (const [signal, needles] of Object.entries(groups)) {
    if (hasAny(text, needles)) found.push(signal);
  }
  return found;
}

function hasAny(text, needles) {
  return needles.some(needle => text.includes(needle));
}

function normalize(value) {
  return safeText(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function safeText(value) {
  return typeof value === "string" ? value : "";
}

function roundConfidence(value) {
  return Math.max(0, Math.min(1, Number(Number(value || 0).toFixed(2))));
}
