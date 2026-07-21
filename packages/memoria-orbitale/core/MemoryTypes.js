// src/core/MemoryTypes.js
class MemoryTypes {
  constructor(storage, embeddingService) {
    this.storage = storage;
    this.embeddingService = embeddingService;
    
    // Pattern strutturali predefiniti
    this.structuralPatterns = new Map();
  }

  /**
   * Crea memoria strutturale (non decade)
   */
  async createStructural(userId, data) {
    const memory = await this.storage.getMemory(userId, data.id);
    
    const structuralMemory = {
      ...memory.toJSON(),
      type: 'structural',
      structural: {
        isStructural: true,
        category: data.category || 'identity', // identity, value, pattern, belief
        stability: 1.0, // 1 = immutabile, 0 = instabile
        lastReinforced: new Date().toISOString(),
        reinforcementThreshold: data.threshold || 10, // Quante volte deve essere rinforzato
        currentReinforcements: 0,
        abstractRepresentation: data.abstractRepresentation || memory.content.text,
        invariantFeatures: this.extractInvariants(memory.content.text)
      },
      orbital: {
        ...memory.orbital,
        decay_rate: 0.001, // Decay quasi nullo
        activation_score: 0.9, // Sempre attivo
        level: 'short' // Sempre in orbita corta
      }
    };

    // Salva
    await this.storage.saveMemory(userId, structuralMemory);
    
    // Aggiungi al pattern matching
    this.learnStructuralPattern(structuralMemory);
    
    return structuralMemory;
  }

  /**
   * Crea memoria episodica (decade normalmente)
   */
  createEpisodic(userId, data) {
    return {
      ...data,
      type: 'episodic',
      episodic: {
        timestamp: data.timestamp || new Date().toISOString(),
        context: data.context || {},
        emotionalValence: data.emotionalValence || 0, // -1 a 1
        importance: data.importance || 0.5,
        location: data.location || null,
        participants: data.participants || []
      },
      orbital: {
        ...data.orbital,
        decay_rate: 0.07, // Decay più veloce per episodi
        activation_score: data.orbital?.activation_score || 0.5
      }
    };
  }

  /**
   * Estrae invarianti da testi (per memoria strutturale)
   */
  extractInvariants(text) {
    // Pattern ricorrenti: date, nomi, luoghi, concetti
    const invariants = {
      dates: text.match(/\d{1,2}\/\d{1,2}\/\d{2,4}/g) || [],
      properNouns: text.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g) || [],
      numbers: text.match(/\b\d+\b/g) || [],
      keyPhrases: this.extractKeyPhrases(text)
    };
    
    return invariants;
  }

  extractKeyPhrases(text) {
    // Semplice estrazione di frasi chiave
    const sentences = text.split(/[.!?]+/);
    return sentences
      .filter(s => s.split(' ').length > 3 && s.split(' ').length < 10)
      .slice(0, 3);
  }

  /**
   * Impara pattern strutturali ricorrenti
   */
  learnStructuralPattern(memory) {
    const pattern = memory.structural.abstractRepresentation;
    
    if (!this.structuralPatterns.has(pattern)) {
      this.structuralPatterns.set(pattern, {
        count: 0,
        instances: [],
        lastSeen: null
      });
    }
    
    const patternData = this.structuralPatterns.get(pattern);
    patternData.count++;
    patternData.instances.push(memory.id);
    patternData.lastSeen = new Date().toISOString();
  }

  /**
   * Rileva se un episodio dovrebbe diventare strutturale
   */
  async detectStructuralCandidates(userId, options = {}) {
    const {
      minOccurrences = 3,
      timeWindow = 30 * 24 * 60 * 60 * 1000, // 30 giorni
      minSimilarity = 0.8
    } = options;

    const memories = await this.storage.loadMemories(userId);
    const episodicMemories = memories.filter(m => m.type === 'episodic');
    
    const candidates = [];
    const now = Date.now();

    // Raggruppa per similarità semantica
    for (let i = 0; i < episodicMemories.length; i++) {
      const group = [episodicMemories[i]];
      
      for (let j = i + 1; j < episodicMemories.length; j++) {
        const similarity = await this.embeddingService.calculateSimilarity(
          episodicMemories[i].embedding_ref,
          episodicMemories[j].embedding_ref
        );
        
        if (similarity > minSimilarity) {
          group.push(episodicMemories[j]);
        }
      }

      // Se il gruppo ha abbastanza elementi nello stesso periodo
      if (group.length >= minOccurrences) {
        const timestamps = group.map(m => new Date(m.meta.timestamp).getTime());
        const oldest = Math.min(...timestamps);
        const newest = Math.max(...timestamps);
        
        if (newest - oldest < timeWindow) {
          // Questo pattern si ripete → candidato strutturale
          candidates.push({
            memories: group.map(m => m.id),
            pattern: this.extractCommonPattern(group),
            occurrences: group.length,
            timespan: newest - oldest
          });
        }
      }
    }

    return candidates;
  }

  /**
   * Estrae pattern comune da un gruppo di memorie
   */
  extractCommonPattern(memories) {
    if (memories.length === 0) return '';
    
    // Prendi il testo più rappresentativo
    const texts = memories.map(m => m.content.text);
    
    // Trova parole comuni
    const wordFreq = new Map();
    for (const text of texts) {
      const words = text.toLowerCase().split(/\W+/);
      for (const word of words) {
        if (word.length < 4) continue;
        wordFreq.set(word, (wordFreq.get(word) || 0) + 1);
      }
    }
    
    // Parole che appaiono in almeno la metà delle memorie
    const commonWords = Array.from(wordFreq.entries())
      .filter(([_, count]) => count >= memories.length / 2)
      .map(([word]) => word);
    
    return {
      commonWords,
      template: `Pattern ricorrente: ${commonWords.join(' ')}`,
      firstOccurrence: memories[0].meta.timestamp,
      lastOccurrence: memories[memories.length - 1].meta.timestamp
    };
  }

  /**
   * Consolida pattern in memoria strutturale
   */
  async consolidatePattern(userId, candidate) {
    // Crea memoria strutturale dal pattern
    const structuralMemory = await this.createStructural(userId, {
      id: `struct_${Date.now()}`,
      category: 'pattern',
      abstractRepresentation: candidate.pattern.template,
      threshold: candidate.occurrences
    });

    // Collega tutte le istanze episodiche a questa struttura
    for (const memId of candidate.memories) {
      const link = new CognitiveLink({
        source: structuralMemory.id,
        target: memId,
        weight: 0.9,
        type: 'instantiation' // La struttura si istanzia in episodi specifici
      }, userId);
      
      await this.storage.saveLink(userId, link);
    }

    return structuralMemory;
  }

  /**
   * Retrieval che rispetta la distinzione strutturale/episodica
   */
  async retrieveWithContext(userId, query, options = {}) {
    const {
      includeStructural = true,
      includeEpisodic = true,
      maxAge = null,
      minStructuralStability = 0.5
    } = options;

    let memories = await this.storage.loadMemories(userId);
    
    // Filtra per tipo
    memories = memories.filter(m => {
      if (m.type === 'structural' && !includeStructural) return false;
      if (m.type === 'episodic' && !includeEpisodic) return false;
      
      // Filtra per età se richiesto
      if (maxAge && m.type === 'episodic') {
        const age = Date.now() - new Date(m.meta.timestamp).getTime();
        if (age > maxAge) return false;
      }
      
      // Per strutturali, considera stabilità
      if (m.type === 'structural' && m.structural) {
        if (m.structural.stability < minStructuralStability) return false;
      }
      
      return true;
    });

    // Ordina: strutturali sempre in cima se rilevanti
    const queryEmbedding = await this.embeddingService.generateEmbedding(query);
    
    const withScores = await Promise.all(
      memories.map(async m => {
        const emb = await this.embeddingService.getEmbedding(m.embedding_ref);
        const similarity = this.embeddingService.cosineSimilarity(queryEmbedding, emb);
        
        // Boost per memorie strutturali
        const score = m.type === 'structural' ? 
          similarity * 1.5 : // Boost 50%
          similarity;
          
        return { memory: m, score };
      })
    );

    return withScores
      .sort((a, b) => b.score - a.score)
      .slice(0, options.limit || 10)
      .map(item => ({
        ...item.memory,
        relevance: item.score
      }));
  }
}

module.exports = MemoryTypes;