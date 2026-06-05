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
      includeLinks = true
    } = options;

    const memories = await this.storage.loadMemories(userId);

    // Filtra
    let candidates = memories.filter(m => {
      if (m.activation < minActivation) return false;
      if (types && !types.includes(m.type)) return false;
      return true;
    });

    const links = await this.storage.loadLinks(userId);
    const baseScores = new Map();
    const directMatches = new Map();

    // Scoring: testo + activation
    for (const m of candidates) {
      const textScore = this._textMatch(query, m.content?.text || '');
      const tagScore = this._textMatch(query, Array.isArray(m.tags) ? m.tags.join(' ') : '');
      directMatches.set(m.id, Math.max(textScore, tagScore));
      baseScores.set(
        m.id,
        this.retrieval.computeFinalScore(textScore, m.activation)
      );
    }

    const scored = candidates.map(m => {
      let linkBoost = 0;
      const memoryLinks = links.filter(l => l.source === m.id || l.target === m.id);

      for (const link of memoryLinks) {
        const neighborId = link.source === m.id ? link.target : link.source;
        const neighborBaseScore = baseScores.get(neighborId) || 0;
        if ((directMatches.get(neighborId) || 0) > 0) {
          linkBoost += neighborBaseScore * link.weight * 0.25;
        }
      }

      linkBoost = Math.min(linkBoost, 0.25);
      const baseScore = baseScores.get(m.id) || 0;
      return { ...m, _score: baseScore + linkBoost, _linkBoost: linkBoost };
    });

    // Ordina e taglia
    const results = scored
      .sort((a, b) => b._score - a._score)
      .slice(0, limit);

    // Aggiorna lastAccess e activation per le memorie richiamate
    for (const r of results) {
      await this._reinforceOnAccess(userId, r.id);
    }

    await this._propagateActivationFromResults(userId, results);

    // Aggiungi link forti se richiesto
    if (includeLinks) {
      for (const r of results) {
        const links = await this.storage.getLinksForMemory(userId, r.id);
        r._links = links.filter(l => l.weight > 0.5);
      }
    }

    return results;
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
  async getContextForKeblo(userId, currentInput = '') {
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
    const relevant = currentInput
      ? await this.recall(userId, currentInput, { limit: 3, types: ['semantic', 'episodic'] })
      : [];

    // Assembla contesto
    const context = {
      identity: structural.map(m => m.content?.text || ''),
      active:   shortOrbit.map(m => ({
        text:       m.content?.text,
        activation: m.activation.toFixed(3),
        type:       m.type
      })),
      relevant: relevant.map(m => ({
        text:  m.content?.text,
        score: m._score?.toFixed(3)
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

  // Match testuale semplice (0-1) — sostituibile con embedding reali
  _textMatch(query, text) {
    if (!query || !text) return 0;
    const q = query.toLowerCase().split(/\W+/).filter(w => w.length > 2);
    const t = text.toLowerCase();
    if (q.length === 0) return 0;
    const hits = q.filter(w => t.includes(w)).length;
    return hits / q.length;
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