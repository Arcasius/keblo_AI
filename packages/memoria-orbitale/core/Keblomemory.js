// KebloMemory.js
// Orchestratore unificato del sistema di memoria orbitale per Keblo
// Entry point principale - collega tutti i moduli

const ActivationEngine = require('./ActivationEngine');
const LinkManager = require('./LinkManager');
const ColdMemoryCompressor = require('./ColdMemoryCompressor');
const MemoryIndex = require('./MemoryIndex');
const { RetrievalBiasCorrector } = require('./RetrievalBiasCorrector');
const IncrementalMaintenance = require('./IncrementalMaintenance');
const DualActivation = require('./DualActivation');
const { randomUUID } = require('crypto');
const { matchesMemoryTier } = require('./recall/MemoryTierClassifier.js');
const { buildRecallRequest } = require('./recall/RecallRequestBuilder.js');

const RECALL_STOPWORDS = new Set([
  'ti', 'mi', 'ci', 'si', 'lo', 'la', 'il', 'gli', 'le', 'un', 'una', 'uno',
  'di', 'del', 'della', 'dello', 'delle', 'dei', 'da', 'dal', 'alla', 'alle',
  'a', 'e', 'o', 'che', 'cosa', 'come', 'quando', 'quanto', 'quale',
  'abbiamo', 'avevamo', 'parlato', 'detto', 'dicevi', 'ricordi', 'ricordiamo',
  'continuiamo', 'continuare', 'continue', 'remember', 'talked', 'about', 'when', 'what'
]);

const STRONG_CONCEPT_ALIASES = {
  mco: [
    'mco',
    'memoria orbitale',
    'memoria latente',
    'orbite',
    'orbitale',
    'eco',
    'risonanza',
    'contesto cosciente',
    'potenziale di contesto',
    'short',
    'medium',
    'long',
    'tempo',
    'link'
  ],
  'memoria orbitale': [
    'mco',
    'memoria orbitale',
    'memoria latente',
    'orbite',
    'eco',
    'risonanza',
    'contesto cosciente'
  ],
  keblo: [
    'keblo',
    'memoria orbitale',
    'mco',
    'aiden',
    'memoria latente'
  ],
  eco: [
    'eco',
    'risonanza',
    'latenza',
    'memoria latente',
    'presenza'
  ],
  risonanza: [
    'risonanza',
    'eco',
    'memoria latente',
    'contesto cosciente'
  ],
  marco: [
    'marco'
  ],
  aso: [
    'aso'
  ],
  elena: [
    'elena'
  ],
  'anna rita': [
    'anna rita'
  ]
};

const WARM_CONCEPT_AREAS = {
  mco: ['mco', 'memoria orbitale', 'eco', 'risonanza', 'aso'],
  'memoria orbitale': ['mco', 'memoria orbitale', 'eco', 'risonanza'],
  eco: ['mco', 'memoria orbitale', 'eco', 'risonanza'],
  risonanza: ['mco', 'memoria orbitale', 'eco', 'risonanza'],
  keblo: ['keblo', 'mco', 'memoria orbitale', 'eco', 'risonanza'],
  marco: ['marco'],
  aso: ['aso', 'mco', 'memoria orbitale'],
  elena: ['elena'],
  'anna rita': ['anna rita']
};

const WARM_CONCEPTS = [...new Set(Object.values(WARM_CONCEPT_AREAS).flat())];

const GENERIC_ASSISTANT_PATTERNS = [
  'sono qui per aiutarti',
  'come posso aiutarti',
  'hai bisogno di',
  'fammi sapere',
  'posso aiutarti',
  'vuoi approfondire',
  'se hai domande'
];

const TAG_CONCEPT_HINTS = new Set([
  'keblo',
  'mco',
  'memoria',
  'orbitale',
  'progetto',
  'project',
  'technical',
  'aiden',
  'marco',
  'aso'
]);

const NOISY_PREFILTER_CONCEPTS = new Set(['short', 'medium', 'long', 'link', 'tempo', 'aiden']);

function normalizeForRecall(value) {
  return String(value || '')
    .normalize('NFC')
    .trim()
    .toLowerCase()
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ');
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function conceptSearchText(value) {
  return ` ${normalizeForRecall(value).replace(/[^a-zà-ÿ0-9]+/g, ' ')} `;
}

function includesConceptInSearch(searchText, concept) {
  const conceptText = normalizeForRecall(concept).replace(/[^a-zà-ÿ0-9]+/g, ' ').trim();
  return Boolean(conceptText) && searchText.includes(` ${conceptText} `);
}

function includesConcept(text, concept) {
  return includesConceptInSearch(conceptSearchText(text), concept);
}

function recallTokens(query) {
  const aliasTokens = new Set(Object.keys(STRONG_CONCEPT_ALIASES));
  return normalizeForRecall(query)
    .split(/\W+/)
    .filter(Boolean)
    .filter(token => aliasTokens.has(token) || (token.length > 2 && !RECALL_STOPWORDS.has(token)));
}

function expandedConcepts(query) {
  const normalized = normalizeForRecall(query);
  const concepts = new Set();

  for (const [trigger, aliases] of Object.entries(STRONG_CONCEPT_ALIASES)) {
    if (includesConcept(normalized, trigger)) {
      aliases.forEach(alias => concepts.add(normalizeForRecall(alias)));
    }
  }

  const expanded = [...concepts];
  for (const token of recallTokens(query)) {
    const coveredByPhrase = expanded.some(concept => concept.includes(' ') && concept.split(/\s+/).includes(token));
    if (!coveredByPhrase) concepts.add(token);
  }

  return [...concepts];
}

function textMatchTokens(tokens, normalizedText) {
  if (!Array.isArray(tokens) || tokens.length === 0 || !normalizedText) return 0;
  const hits = tokens.filter(token => normalizedText.includes(token)).length;
  return hits / tokens.length;
}

function conceptMatcher(concept) {
  const escaped = escapeRegExp(normalizeForRecall(concept));
  return new RegExp(`(^|[^a-zà-ÿ0-9])${escaped}([^a-zà-ÿ0-9]|$)`, 'i');
}

function hasConceptSignal(normalizedText, normalizedTags, concepts) {
  for (const concept of concepts) {
    if (NOISY_PREFILTER_CONCEPTS.has(concept)) continue;
    if (concept === 'eco') {
      if (/(^|[^a-zà-ÿ0-9])eco([^a-zà-ÿ0-9]|$)/i.test(normalizedText) || /(^|[^a-zà-ÿ0-9])eco([^a-zà-ÿ0-9]|$)/i.test(normalizedTags)) {
        return true;
      }
      continue;
    }
    if (normalizedText.includes(concept) || normalizedTags.includes(concept)) return true;
  }
  return false;
}

function memoryConceptSearchText(memory) {
  const text = memory?.content?.text || '';
  const tags = Array.isArray(memory?.tags) ? memory.tags.join(' ').replace(/_/g, ' ') : '';
  return conceptSearchText(`${text} ${tags}`);
}

function buildWarmConceptIndex(memories) {
  const index = new Map();
  const safeMemories = Array.isArray(memories) ? memories : [];

  for (const memory of safeMemories) {
    if (!memory?.id) continue;
    const searchText = memoryConceptSearchText(memory);

    for (const concept of WARM_CONCEPTS) {
      if (!includesConceptInSearch(searchText, concept)) continue;
      if (!index.has(concept)) index.set(concept, new Set());
      index.get(concept).add(memory.id);
    }
  }

  return index;
}

function queryWarmAreaConcepts(concepts) {
  const area = new Set();

  for (const concept of concepts) {
    const related = WARM_CONCEPT_AREAS[concept];
    if (!related) continue;
    related.forEach(item => area.add(item));
  }

  return [...area];
}

function selectWarmConceptCandidates(candidates, concepts) {
  const areaConcepts = queryWarmAreaConcepts(concepts);
  const before = Array.isArray(candidates) ? candidates.length : 0;
  if (before === 0 || areaConcepts.length === 0) {
    return { candidates, before, after: before, warmApplied: false, areaConcepts };
  }

  const index = buildWarmConceptIndex(candidates);
  const candidateIds = new Set();
  for (const concept of areaConcepts) {
    const ids = index.get(concept);
    if (!ids) continue;
    ids.forEach(id => candidateIds.add(id));
  }

  if (candidateIds.size === 0) {
    return { candidates, before, after: before, warmApplied: false, areaConcepts };
  }

  const selected = candidates.filter(memory => candidateIds.has(memory.id));
  return {
    candidates: selected,
    before,
    after: selected.length,
    warmApplied: selected.length < before,
    areaConcepts
  };
}

function tagConceptMatch(tags, concepts) {
  if (!Array.isArray(tags) || tags.length === 0 || concepts.length === 0) return 0;
  const tagSearchText = conceptSearchText(tags.join(' ').replace(/_/g, ' '));
  const matches = concepts.filter(concept => includesConceptInSearch(tagSearchText, concept)).length;
  const hintMatches = tags.filter(tag => TAG_CONCEPT_HINTS.has(normalizeForRecall(tag).replace(/^entity_/, ''))).length;
  return Math.min(1, (matches / concepts.length) + hintMatches * 0.08);
}

function genericPenalty(memory, text) {
  const normalized = normalizeForRecall(text);
  const tags = Array.isArray(memory?.tags) ? memory.tags : [];
  const assistantLike = tags.includes('assistant') || memory?.role === 'assistant';
  const temporaryAssistant = assistantLike && (tags.includes('temporary') || memory?.memoryDepth === 'temporary');
  const patternHits = GENERIC_ASSISTANT_PATTERNS.filter(pattern => normalized.includes(pattern)).length;
  return Math.min(0.35,
    patternHits * 0.08 +
    (assistantLike && patternHits > 0 ? 0.05 : 0) +
    (temporaryAssistant ? 0.18 : 0)
  );
}

function duplicateQueryPenalty(query, text, concepts) {
  const normalizedQuery = normalizeForRecall(query).replace(/[?!.,;:]+$/g, '');
  const normalizedText = normalizeForRecall(text).replace(/[?!.,;:]+$/g, '');
  if (!normalizedQuery || !normalizedText) return 0;

  const textSearch = conceptSearchText(normalizedText);
  const strongMatches = concepts.filter(concept => includesConceptInSearch(textSearch, concept)).length;
  const metaRecall = /\b(ti ricordi|abbiamo parlato|avevamo parlato|remember|talked about)\b/i.test(normalizedText);

  if (normalizedText === normalizedQuery) return strongMatches <= 1 ? 0.35 : 0.15;
  if (normalizedText.length <= normalizedQuery.length + 30 && normalizedText.includes(normalizedQuery)) {
    return strongMatches <= 1 ? 0.25 : 0.1;
  }
  if (metaRecall && strongMatches <= 1 && normalizedText.length < 140) return 0.18;
  return 0;
}

function echoResonanceScore(query, memory, concepts, normalizedTextOverride = null) {
  const text = memory?.content?.text || '';
  const normalizedText = normalizedTextOverride || normalizeForRecall(text);
  if (!normalizedText) {
    return {
      echoScore: 0,
      tagScore: 0,
      genericPenalty: 0,
      duplicatePenalty: 0,
      matchedConcepts: []
    };
  }

  const textSearch = conceptSearchText(normalizedText);
  const matchedConcepts = concepts.filter(concept => includesConceptInSearch(textSearch, concept));
  const exactAcronymBoost = includesConceptInSearch(textSearch, 'mco') && concepts.includes('mco') ? 0.28 : 0;
  const phraseBoost = ['memoria orbitale', 'memoria latente', 'contesto cosciente', 'potenziale di contesto']
    .filter(phrase => concepts.includes(phrase) && includesConceptInSearch(textSearch, phrase))
    .length * 0.12;
  const aliasCoverage = concepts.length ? matchedConcepts.length / concepts.length : 0;
  const conceptDensity = Math.min(0.25, matchedConcepts.length / Math.max(8, normalizedText.split(/\s+/).length) * 4);
  const tagScore = tagConceptMatch(memory?.tags, concepts);
  const penaltyGeneric = genericPenalty(memory, normalizedText);
  const penaltyDuplicate = duplicateQueryPenalty(query, normalizedText, concepts);
  const echoScore = Math.max(0, Math.min(1,
    exactAcronymBoost +
    phraseBoost +
    aliasCoverage * 0.35 +
    conceptDensity +
    tagScore * 0.2 -
    penaltyGeneric -
    penaltyDuplicate
  ));

  return {
    echoScore,
    tagScore,
    genericPenalty: penaltyGeneric,
    duplicatePenalty: penaltyDuplicate,
    matchedConcepts
  };
}

function linkQualityMultiplier(type) {
  if (type === 'semantic') return 1;
  if (type === 'continuation') return 0.25;
  if (type === 'dialogue_sequence') return 0.1;
  return 0.2;
}


// ============================================================
// STORAGE IN-MEMORY (sostituibile con DB reale)
// ============================================================
class MemoryStorage {
  constructor() {
    this.memories = new Map();  // userId -> Map(id -> memory)
    this.links    = new Map();  // userId -> Map(id -> link)
    this.clusters = new Map();  // userId -> Map(id -> cluster)
  }

  _userMemories(userId) {
    if (!this.memories.has(userId)) this.memories.set(userId, new Map());
    return this.memories.get(userId);
  }
  _userLinks(userId) {
    if (!this.links.has(userId)) this.links.set(userId, new Map());
    return this.links.get(userId);
  }

  async saveMemory(userId, memory) {
    this._userMemories(userId).set(memory.id, memory);
    return memory;
  }
  async getMemory(userId, id) {
    return this._userMemories(userId).get(id) || null;
  }
  async loadMemories(userId) {
    return Array.from(this._userMemories(userId).values());
  }
  async saveMemories(userId, memories) {
    const map = this._userMemories(userId);
    map.clear();
    memories.forEach(m => map.set(m.id, m));
  }
  async deleteMemory(userId, id) {
    this._userMemories(userId).delete(id);
  }

  async saveLink(userId, link) {
    this._userLinks(userId).set(link.id, link);
    return link;
  }
  async loadLinks(userId) {
    return Array.from(this._userLinks(userId).values());
  }
  async saveLinks(userId, links) {
    const map = this._userLinks(userId);
    map.clear();
    links.forEach(l => map.set(l.id, l));
  }
  async getLinkBetween(userId, sourceId, targetId) {
    const links = await this.loadLinks(userId);
    return links.find(l =>
      (l.source === sourceId && l.target === targetId) ||
      (l.source === targetId && l.target === sourceId)
    ) || null;
  }
  async getLinksForMemory(userId, memId) {
    const links = await this.loadLinks(userId);
    return links.filter(l => l.source === memId || l.target === memId);
  }

  async loadClusters(userId) {
    if (!this.clusters.has(userId)) this.clusters.set(userId, new Map());
    return Array.from(this.clusters.get(userId).values());
  }
}

// ============================================================
// KEBLO MEMORY - ORCHESTRATORE PRINCIPALE
// ============================================================
class KebloMemory {
  constructor(config = {}) {
    // Parametri umani per il decay (fix principale)
    // alpha alto = memoria persistente, gamma basso = decay lento
    this.activationEngine = new ActivationEngine({
      alpha: config.alpha   || 0.97,   // FIX: era 0.85 → troppo aggressivo
      beta:  config.beta    || 0.15,
      gamma: config.gamma   || 0.005,  // FIX: era 0.05 → ricordi sparivano in 10 giorni
      momentumFactor:      config.momentumFactor      || 0.95,
      energyThreshold:     config.energyThreshold     || 1000,
      freezeThreshold:     config.freezeThreshold     || 0.05,
      decayReductionOnFreeze: config.decayReductionOnFreeze || 0.3
    });

    this.linkManager    = new LinkManager({
      baseLinks:         config.baseLinks        || 3,
      linkMultiplier:    config.linkMultiplier    || 10,
      linkDecayFactor:   config.linkDecayFactor   || 0.98,  // FIX: era 0.95
      linkMinWeight:     config.linkMinWeight     || 0.05,
      propagationFactor: config.propagationFactor || 0.4,
      maxPropagation:    config.maxPropagation    || 0.3
    });

    this.compressor   = new ColdMemoryCompressor({
      coldThreshold: config.coldThreshold || 0.05,
      coldAgeDays:   config.coldAgeDays   || 60,   // FIX: era 30 → troppo presto
    });

    this.index        = new MemoryIndex();
    this.retrieval    = new RetrievalBiasCorrector({
      similarityWeight: 0.6,
      activationWeight: 0.4
    });
    this.maintenance  = new IncrementalMaintenance({ batchSize: 100 });
    this.dualActivation = new DualActivation();
    this.storage      = config.storage || new MemoryStorage();
    this.recallRouter = null;

    // Tipi di memoria con decay differenziato (come nella memoria umana)
    this.decayByType = {
      structural: 0.0001, // Praticamente non decade  (es: "mi chiamo X")
      semantic:   0.002,  // Decade lentamente         (es: "lavoro su AI")
      episodic:   0.008,  // Decade normalmente        (es: "ieri ho parlato di Y")
      working:    0.05    // Decade velocemente        (es: contesto sessione corrente)
    };
  }

  // ============================================================
  // CREA MEMORIA
  // ============================================================
  async remember(userId, content, options = {}) {
    const {
      type = 'episodic',        // structural | semantic | episodic | working
      importance = 0.5,         // 0-1, influenza activation iniziale
      emotionalValence = 0,     // -1 a 1
      tags = [],
      linkedTo = []             // ids di memorie correlate
    } = options;

    const id = `mem_${randomUUID()}`;
    const now = Date.now();

    // Activation iniziale basata su importanza e tipo
    const baseActivation = type === 'structural' ? 0.95
      : type === 'semantic'   ? 0.7
      : type === 'working'    ? 0.9
      : 0.4 + importance * 0.5; // episodic

    // Stato duale cognitivo/affettivo
    const dualState = this.dualActivation.createDualState(
      baseActivation,
      emotionalValence
    );

    const memory = {
      id,
      type,
      content: typeof content === 'string' ? { text: content } : content,
      activation:   baseActivation,
      orbitalState: baseActivation,
      orbitalLevel: this.activationEngine.determineOrbitalLevel(baseActivation),
      memoryDepth: this._determineMemoryDepth(options, importance),
      dualState,
      decay_rate:   this.decayByType[type] || this.decayByType.episodic,
      tags,
      timestamp:    now,
      lastAccess:   now,
      accessCount:  0,
      meta: {
        user_id:    userId,
        importance,
        emotionalValence,
        version: 1
      }
    };

    // Salva
    await this.storage.saveMemory(userId, memory);

    // Aggiorna indice
    this.index.indexMemory(memory);

    // Crea link a memorie correlate
    for (const targetId of linkedTo) {
      await this._createLink(userId, id, targetId, 0.7, 'semantic');
    }

    return memory;
  }

  // ============================================================
  // RECUPERA MEMORIE (retrieval contestuale)
  // ============================================================
  async recall(userId, query, options = {}) {
    const {
      limit = 10,
      minActivation = 0.0,
      types = null,            // filtra per tipo
      includeLinks = true,
      mutateOnRecall = true,
      excludeTags = [],
      excludeMemoryDepths = [],
      excludeOrbitalLevels = [],
      tier = null
    } = options;

    const excludedTags = new Set(excludeTags);
    const excludedDepths = new Set(excludeMemoryDepths);
    const excludedOrbitalLevels = new Set(excludeOrbitalLevels);
    const memories = await this.storage.loadMemories(userId);

    // Filtra
    let candidates = memories.filter(m => {
      if (tier && !matchesMemoryTier(m, tier)) return false;
      if (m.activation < minActivation) return false;
      if (types && !types.includes(m.type)) return false;
      if (excludedDepths.has(m.memoryDepth)) return false;
      if (excludedOrbitalLevels.has(m.orbitalLevel)) return false;
      if (Array.isArray(m.tags) && m.tags.some(tag => excludedTags.has(tag))) return false;
      return true;
    });

    const links = includeLinks ? await this.storage.loadLinks(userId) : [];
    const linksByMemory = new Map();
    if (includeLinks) {
      for (const link of links) {
        if (!linksByMemory.has(link.source)) linksByMemory.set(link.source, []);
        if (!linksByMemory.has(link.target)) linksByMemory.set(link.target, []);
        linksByMemory.get(link.source).push(link);
        linksByMemory.get(link.target).push(link);
      }
    }
    const baseScores = new Map();
    const directMatches = new Map();
    const textScores = new Map();
    const tagScores = new Map();
    const echoScores = new Map();
    const concepts = expandedConcepts(query);
    const queryTokens = recallTokens(query);
    const warmSelection = selectWarmConceptCandidates(candidates, concepts);
    candidates = warmSelection.candidates;
    if (options.debugTiming) {
      console.log(
        `[warm-concept-index] query="${query}" applied=${warmSelection.warmApplied} candidates=${warmSelection.before}->${warmSelection.after} area=${warmSelection.areaConcepts.join(',') || '-'}`
      );
    }

    // Scoring: testo + activation + prima risonanza concettuale.
    for (const m of candidates) {
      const normalizedText = normalizeForRecall(m.content?.text || '');
      const textScore = textMatchTokens(queryTokens, normalizedText);
      const normalizedTags = normalizeForRecall(Array.isArray(m.tags) ? m.tags.join(' ') : '');
      const tagScore = textMatchTokens(queryTokens, normalizedTags);
      const hasPossibleConcept = concepts.length > 0 && hasConceptSignal(normalizedText, normalizedTags, concepts);
      const echo = hasPossibleConcept
        ? echoResonanceScore(query, m, concepts, normalizedText)
        : { echoScore: 0, tagScore: 0, genericPenalty: 0, duplicatePenalty: 0, matchedConcepts: [] };
      textScores.set(m.id, textScore);
      tagScores.set(m.id, Math.max(tagScore, echo.tagScore));
      echoScores.set(m.id, echo);
      directMatches.set(m.id, Math.max(textScore, tagScore, echo.echoScore));
      const scoringActivation = tier && !Number.isFinite(m.activation) ? 0 : m.activation;
      baseScores.set(
        m.id,
        this.retrieval.computeFinalScore(Math.max(textScore, tagScore * 0.7), scoringActivation)
      );
    }

    const scored = candidates.map(m => {
      let linkBoost = 0;
      let semanticLinkBoost = 0;
      let continuationLinkBoost = 0;
      let dialogueLinkBoost = 0;

      if (includeLinks) {
        const memoryLinks = linksByMemory.get(m.id) || [];

        for (const link of memoryLinks) {
          const neighborId = link.source === m.id ? link.target : link.source;
          const neighborBaseScore = baseScores.get(neighborId) || 0;
          if ((directMatches.get(neighborId) || 0) > 0) {
            const contribution = neighborBaseScore * (link.weight || 0) * 0.2 * linkQualityMultiplier(link.type);
            if (link.type === 'semantic') semanticLinkBoost += contribution;
            else if (link.type === 'continuation') continuationLinkBoost += contribution;
            else if (link.type === 'dialogue_sequence') dialogueLinkBoost += contribution;
            else continuationLinkBoost += contribution;
          }
        }

        linkBoost =
          Math.min(semanticLinkBoost, 0.2) +
          Math.min(continuationLinkBoost, 0.05) +
          Math.min(dialogueLinkBoost, 0.03);
      }

      const baseScore = baseScores.get(m.id) || 0;
      const echo = echoScores.get(m.id) || {
        echoScore: 0,
        tagScore: 0,
        genericPenalty: 0,
        duplicatePenalty: 0,
        matchedConcepts: []
      };
      const finalScore = baseScore * 0.65 + echo.echoScore * 0.25 + linkBoost * 0.10;

      return {
        ...m,
        _score: finalScore,
        _baseScore: baseScore,
        _textScore: textScores.get(m.id) || 0,
        _tagScore: tagScores.get(m.id) || 0,
        _echoScore: echo.echoScore,
        _genericPenalty: echo.genericPenalty,
        _duplicatePenalty: echo.duplicatePenalty,
        _matchedConcepts: echo.matchedConcepts,
        _queryConcepts: concepts,
        _linkBoost: linkBoost
      };
    });

    // Ordina e taglia
    const results = scored
      .filter(m => !tier || matchesMemoryTier(m, tier))
      .sort((a, b) => b._score - a._score)
      .slice(0, limit);

    if (mutateOnRecall) {
      // Aggiorna lastAccess e activation per le memorie richiamate
      for (const r of results) {
        await this._reinforceOnAccess(userId, r.id);
      }

      await this._propagateActivationFromResults(userId, results);
    }

    // Aggiungi link forti se richiesto
    if (includeLinks) {
      for (const r of results) {
        const memoryLinks = linksByMemory.get(r.id) || [];
        r._links = memoryLinks.filter(l => l.weight > 0.5);
      }
    }

    return results;
  }

  async recallReadOnly(userId, query, options = {}) {
    return this.recall(userId, query, { ...options, mutateOnRecall: false });
  }

  setRecallRouter(router) {
    if (!router || typeof router.recall !== 'function') {
      throw new TypeError('Recall router must expose recall()');
    }
    if (this.recallRouter && this.recallRouter !== router) {
      throw new Error('A recall router is already registered');
    }
    this.recallRouter = router;
    return router;
  }

  getRecallRouter() {
    return this.recallRouter;
  }

  async reinforceRecallSelection(userId, memoryIds, options = {}) {
    const enabled = options.enabled !== false;
    const ids = [...new Set(Array.isArray(memoryIds) ? memoryIds : [])]
      .filter(id => typeof id === 'string' && id.length > 0);
    if (!enabled || ids.length === 0) {
      return { reinforced: false, requestedCount: ids.length, reinforcedCount: 0, saved: false };
    }

    const apply = async (lockHandle = null) => {
      const memories = await this.storage.loadMemories(userId);
      const selected = new Set(ids);
      let reinforcedCount = 0;
      const updated = memories.map(memory => {
        if (!selected.has(memory.id) || memory.memoryKind === 'super_memory') return memory;
        reinforcedCount += 1;
        const activation = Math.min(1, (memory.activation || 0) + 0.03);
        const orbitalState = this.activationEngine.computeOrbitalState(
          memory.orbitalState || memory.activation || 0,
          activation
        );
        const next = {
          ...memory,
          activation,
          orbitalState,
          orbitalLevel: this.activationEngine.determineOrbitalLevel(orbitalState),
          lastAccess: Date.now(),
          accessCount: (memory.accessCount || 0) + 1
        };
        this.index.indexMemory(next);
        return next;
      });
      if (reinforcedCount > 0) {
        await this.storage.saveMemories(userId, updated, lockHandle ? { lockHandle } : undefined);
      }
      return {
        reinforced: reinforcedCount > 0,
        requestedCount: ids.length,
        reinforcedCount,
        saved: reinforcedCount > 0
      };
    };

    if (typeof this.storage.withUserLock === 'function') {
      return this.storage.withUserLock(userId, (lockHandle) => apply(lockHandle));
    }
    return apply();
  }

  // ============================================================
  // RINFORZA MEMORIA (quando viene usata/menzionata)
  // ============================================================
  async reinforce(userId, memoryId, strength = 0.5, emotionalStimulus = 0) {
    const memory = await this.storage.getMemory(userId, memoryId);
    if (!memory) return null;

    // Update duale
    const newDualState = this.dualActivation.updateDualState(
      memory.dualState || this.dualActivation.createDualState(memory.activation),
      strength,
      emotionalStimulus
    );

    // Update activation con engine
    const updated = this.activationEngine.updateNode(memory, strength, 0);

    // Merge
    updated.dualState  = newDualState;
    updated.lastAccess = Date.now();
    updated.accessCount = (memory.accessCount || 0) + 1;

    await this.storage.saveMemory(userId, updated);
    this.index.indexMemory(updated);

    return updated;
  }

  // ============================================================
  // DECAY TEMPORALE (da chiamare periodicamente)
  // ============================================================
  async decayAll(userId) {
    const memories = await this.storage.loadMemories(userId);
    const now = Date.now();
    const updated = [];

    for (const memory of memories) {
      // Salta memorie strutturali (quasi non decadono)
      if (memory.type === 'structural') continue;

      const daysSinceAccess = (now - (memory.lastAccess || memory.timestamp)) / 86400000;
      if (daysSinceAccess < 0.1) continue; // meno di 2.4 ore → skip

      const decayRate = memory.decay_rate || this.decayByType.episodic;
      const timeDelta = daysSinceAccess * decayRate * 200; // normalizzato

      const newActivation = Math.max(0,
        memory.activation * Math.exp(-decayRate * daysSinceAccess)
      );

      const newOrbitalState = this.activationEngine.computeOrbitalState(
        memory.orbitalState || memory.activation,
        newActivation
      );

      const updatedMemory = {
        ...memory,
        activation:   newActivation,
        orbitalState: newOrbitalState,
        orbitalLevel: this.activationEngine.determineOrbitalLevel(newOrbitalState)
      };

      await this.storage.saveMemory(userId, updatedMemory);
      this.index.indexMemory(updatedMemory);
      updated.push(updatedMemory.id);
    }

    // Prune link deboli
    const links = await this.storage.loadLinks(userId);
    const prunedLinks = this.linkManager.pruneWeakLinks(links);
    if (prunedLinks.length !== links.length) {
      await this.storage.saveLinks(userId, prunedLinks);
    }

    return {
      decayed: updated.length,
      total: memories.length,
      linksPruned: links.length - prunedLinks.length
    };
  }

  // ============================================================
  // COMPRIMI MEMORIE FREDDE
  // ============================================================
  async compress(userId) {
    const memories = await this.storage.loadMemories(userId);
    const cold = this.compressor.identifyColdMemories(memories);

    for (const m of cold) {
      const compressed = this.compressor.compressMemory(m);
      await this.storage.saveMemory(userId, compressed);
    }

    return { compressed: cold.length, total: memories.length };
  }

  // ============================================================
  // STATO CORRENTE (per iniettare nel contesto di Keblo)
  // ============================================================
  async getContextForKeblo(userId, currentInput = '', options = {}) {
    const memories = await this.storage.loadMemories(userId);

    // Orbita corta = working memory di Keblo
    const shortOrbit = memories
      .filter(m => m.orbitalLevel === 'short' && !m.cold)
      .sort((a, b) => b.activation - a.activation)
      .slice(0, 5);

    // Strutturali = chi sei tu, valori, identità
    const structural = memories
      .filter(m => m.type === 'structural')
      .sort((a, b) => b.activation - a.activation)
      .slice(0, 5);

    // Semantici rilevanti per l'input corrente
    let relevant = [];
    if (currentInput) {
      if (this.recallRouter) {
        const request = buildRecallRequest({
          query: currentInput,
          limit: options.limit === undefined ? 3 : options.limit,
          includeDeep: options.includeDeep === true,
          allowDeepFallback: options.allowDeepFallback === true
        });
        const routed = await this.recallRouter.recall(request);
        await this.reinforceRecallSelection(userId, routed.reinforcementPendingIds, {
          enabled: options.reinforce !== false
        });
        relevant = routed.results;
      } else {
        relevant = await this.recall(userId, currentInput, {
          limit: options.limit === undefined ? 3 : options.limit,
          types: ['semantic', 'episodic']
        });
      }
    }

    // Assembla contesto
    const context = {
      identity: structural.map(m => m.content?.text || ''),
      active:   shortOrbit.map(m => ({
        text:       m.content?.text,
        activation: m.activation.toFixed(3),
        type:       m.type
      })),
      relevant: relevant.map(m => ({
        text:  m.text || m.content?.text,
        score: (m.finalScore ?? m._score)?.toFixed(3)
      })),
      stats: {
        totalMemories: memories.length,
        shortOrbit:    memories.filter(m => m.orbitalLevel === 'short').length,
        mediumOrbit:   memories.filter(m => m.orbitalLevel === 'medium').length,
        longOrbit:     memories.filter(m => m.orbitalLevel === 'long').length,
        cold:          memories.filter(m => m.cold).length
      }
    };

    return context;
  }

  // ============================================================
  // UTILITY INTERNE
  // ============================================================
  async _reinforceOnAccess(userId, memoryId) {
    const memory = await this.storage.getMemory(userId, memoryId);
    if (!memory) return;

    const activation = Math.min(1, (memory.activation || 0) + 0.03);
    const orbitalState = this.activationEngine.computeOrbitalState(
      memory.orbitalState || memory.activation || 0,
      activation
    );

    const updated = {
      ...memory,
      activation,
      orbitalState,
      orbitalLevel: this.activationEngine.determineOrbitalLevel(orbitalState),
      lastAccess: Date.now(),
      accessCount: (memory.accessCount || 0) + 1
    };

    await this.storage.saveMemory(userId, updated);
  }

  async _propagateActivationFromResults(userId, results) {
    const directIds = new Set(results.map(r => r.id));
    const propagatedIds = new Set();

    for (const result of results) {
      const links = await this.storage.getLinksForMemory(userId, result.id);

      for (const link of links) {
        const neighborId = link.source === result.id ? link.target : link.source;
        if (directIds.has(neighborId) || propagatedIds.has(neighborId)) continue;

        const neighbor = await this.storage.getMemory(userId, neighborId);
        if (!neighbor) continue;

        const activation = Math.min(1, (neighbor.activation || 0) + 0.01 * link.weight);
        const orbitalState = this.activationEngine.computeOrbitalState(
          neighbor.orbitalState || neighbor.activation || 0,
          activation
        );

        await this.storage.saveMemory(userId, {
          ...neighbor,
          activation,
          orbitalState,
          orbitalLevel: this.activationEngine.determineOrbitalLevel(orbitalState)
        });

        propagatedIds.add(neighborId);
      }
    }
  }

  _determineMemoryDepth(metadata = {}, importance = 0.5) {
    const validDepths = new Set(['core', 'deep', 'normal', 'temporary']);
    const requestedDepth = metadata.memoryDepth || metadata.depth;

    if (validDepths.has(requestedDepth)) {
      return requestedDepth;
    }

    if (importance >= 0.95) return 'core';
    if (importance >= 0.75) return 'deep';
    if (importance >= 0.30) return 'normal';
    return 'temporary';
  }

  async _createLink(userId, sourceId, targetId, weight = 0.5, type = 'semantic') {
    const existing = await this.storage.getLinkBetween(userId, sourceId, targetId);
    if (existing) {
      existing.weight = Math.min(1, existing.weight + 0.1);
      await this.storage.saveLink(userId, existing);
      return existing;
    }
    const link = {
      id:      `lnk_${randomUUID()}`,
      source:  sourceId,
      target:  targetId,
      weight,
      type,
      created_at:       new Date().toISOString(),
      last_reinforced:  new Date().toISOString(),
      reinforcement_count: 1
    };
    await this.storage.saveLink(userId, link);
    return link;
  }

  // Match testuale semplice (0-1) con stopword recall filtrate.
  _textMatch(query, text) {
    if (!query || !text) return 0;
    const q = recallTokens(query);
    const t = normalizeForRecall(text);
    return textMatchTokens(q, t);
  }

  // Statistiche sistema
  async getStats(userId) {
    const memories = await this.storage.loadMemories(userId);
    const links    = await this.storage.loadLinks(userId);
    const byType   = {};
    const byOrbit  = { short: 0, medium: 0, long: 0 };

    for (const m of memories) {
      byType[m.type]  = (byType[m.type]  || 0) + 1;
      byOrbit[m.orbitalLevel] = (byOrbit[m.orbitalLevel] || 0) + 1;
    }

    const avgActivation = memories.length
      ? memories.reduce((s, m) => s + m.activation, 0) / memories.length
      : 0;

    return {
      totalMemories:  memories.length,
      totalLinks:     links.length,
      avgActivation:  avgActivation.toFixed(4),
      byType,
      byOrbit,
      cold: memories.filter(m => m.cold).length
    };
  }
}

module.exports = { KebloMemory, MemoryStorage };
