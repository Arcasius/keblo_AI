// src/core/MemoryIndex.js
class MemoryIndex {
  constructor() {
    // Indici principali
    this.byId = new Map();
    this.byOrbit = {
      short: new Set(),
      medium: new Set(),
      long: new Set()
    };
    this.byCluster = new Map(); // clusterId -> Set(memoryIds)
    this.byType = new Map(); // type -> Set(memoryIds)
    this.byUser = new Map(); // userId -> Set(memoryIds)
    
    // Indici temporali
    this.byAccessTime = []; // Array ordinato per ultimo accesso
    this.byCreationTime = []; // Array ordinato per creazione
    
    // Indici di attivazione
    this.activationIndex = new Map(); // memoryId -> activation_score
    
    // Indice full-text semplice
    this.textIndex = new Map(); // parola -> Set(memoryIds)
    
    // Statistiche
    this.stats = {
      totalMemories: 0,
      totalLinks: 0,
      avgActivation: 0,
      lastRebuild: Date.now()
    };
  }

  // Inserimento/aggiornamento
  indexMemory(memory) {
    // Per ID
    this.byId.set(memory.id, memory);
    
    // Per orbita
    if (memory.orbital?.level) {
      Object.values(this.byOrbit).forEach(set => set.delete(memory.id));
      this.byOrbit[memory.orbital.level].add(memory.id);
    }
    
    // Per cluster
    if (memory.cluster?.id) {
      if (!this.byCluster.has(memory.cluster.id)) {
        this.byCluster.set(memory.cluster.id, new Set());
      }
      this.byCluster.get(memory.cluster.id).add(memory.id);
    }
    
    // Per tipo
    if (memory.type) {
      if (!this.byType.has(memory.type)) {
        this.byType.set(memory.type, new Set());
      }
      this.byType.get(memory.type).add(memory.id);
    }
    
    // Per utente
    if (memory.meta?.user_id) {
      if (!this.byUser.has(memory.meta.user_id)) {
        this.byUser.set(memory.meta.user_id, new Set());
      }
      this.byUser.get(memory.meta.user_id).add(memory.id);
    }
    
    // Indice di attivazione
    if (memory.orbital?.activation_score) {
      this.activationIndex.set(memory.id, memory.orbital.activation_score);
    }
    
    // Indice testuale
    if (memory.content?.text) {
      const words = memory.content.text.toLowerCase()
        .split(/\W+/)
        .filter(w => w.length > 3);
      
      for (const word of words) {
        if (!this.textIndex.has(word)) {
          this.textIndex.set(word, new Set());
        }
        this.textIndex.get(word).add(memory.id);
      }
    }
    
    // Aggiorna indici temporali
    this.updateTimeIndex(memory);
    
    this.stats.totalMemories = this.byId.size;
  }

  updateTimeIndex(memory) {
    // Rimuovi da indici temporali se esisteva
    this.byAccessTime = this.byAccessTime.filter(m => m.id !== memory.id);
    this.byCreationTime = this.byCreationTime.filter(m => m.id !== memory.id);
    
    // Aggiungi con ordinamento
    this.byAccessTime.push({
      id: memory.id,
      time: new Date(memory.orbital?.last_access || Date.now())
    });
    
    this.byCreationTime.push({
      id: memory.id,
      time: new Date(memory.meta?.timestamp || Date.now())
    });
    
    // Ordina
    this.byAccessTime.sort((a, b) => b.time - a.time);
    this.byCreationTime.sort((a, b) => b.time - a.time);
    
    // Mantieni solo top 1000 per performance
    if (this.byAccessTime.length > 1000) {
      this.byAccessTime = this.byAccessTime.slice(0, 1000);
    }
    if (this.byCreationTime.length > 1000) {
      this.byCreationTime = this.byCreationTime.slice(0, 1000);
    }
  }

  // Query
  getMemory(id) {
    return this.byId.get(id);
  }

  getMemoriesByOrbit(level) {
    return Array.from(this.byOrbit[level] || [])
      .map(id => this.byId.get(id))
      .filter(Boolean);
  }

  getMemoriesByCluster(clusterId) {
    const ids = this.byCluster.get(clusterId) || new Set();
    return Array.from(ids).map(id => this.byId.get(id)).filter(Boolean);
  }

  getMemoriesByType(type) {
    const ids = this.byType.get(type) || new Set();
    return Array.from(ids).map(id => this.byId.get(id)).filter(Boolean);
  }

  getUserMemories(userId) {
    const ids = this.byUser.get(userId) || new Set();
    return Array.from(ids).map(id => this.byId.get(id)).filter(Boolean);
  }

  searchByText(query, limit = 10) {
    const words = query.toLowerCase().split(/\W+/).filter(w => w.length > 3);
    if (words.length === 0) return [];
    
    // Trova memorie che contengono le parole
    const candidates = new Map(); // memoryId -> relevance
    
    for (const word of words) {
      const matching = this.textIndex.get(word) || new Set();
      for (const id of matching) {
        candidates.set(id, (candidates.get(id) || 0) + 1);
      }
    }
    
    // Ordina per rilevanza
    const sorted = Array.from(candidates.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit);
    
    return sorted.map(([id]) => this.byId.get(id)).filter(Boolean);
  }

  getMostActive(limit = 10, minActivation = 0) {
    return Array.from(this.activationIndex.entries())
      .filter(([_, score]) => score >= minActivation)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([id]) => this.byId.get(id))
      .filter(Boolean);
  }

  getRecentAccess(limit = 10) {
    return this.byAccessTime.slice(0, limit)
      .map(item => this.byId.get(item.id))
      .filter(Boolean);
  }

  getRecentCreation(limit = 10) {
    return this.byCreationTime.slice(0, limit)
      .map(item => this.byId.get(item.id))
      .filter(Boolean);
  }

  // Manutenzione indici
  rebuild(memories) {
    this.clear();
    for (const memory of memories) {
      this.indexMemory(memory);
    }
    this.stats.lastRebuild = Date.now();
  }

  clear() {
    this.byId.clear();
    Object.values(this.byOrbit).forEach(set => set.clear());
    this.byCluster.clear();
    this.byType.clear();
    this.byUser.clear();
    this.activationIndex.clear();
    this.textIndex.clear();
    this.byAccessTime = [];
    this.byCreationTime = [];
  }

  getStats() {
    return {
      ...this.stats,
      indices: {
        byId: this.byId.size,
        byOrbit: Object.fromEntries(
          Object.entries(this.byOrbit).map(([k, v]) => [k, v.size])
        ),
        byCluster: this.byCluster.size,
        byType: Object.fromEntries(
          Array.from(this.byType.entries()).map(([k, v]) => [k, v.size])
        ),
        textIndex: this.textIndex.size
      }
    };
  }

  // Health check
  validate() {
    let errors = [];
    
    // Verifica consistenza
    for (const [id, memory] of this.byId) {
      if (memory.id !== id) {
        errors.push(`ID mismatch: ${memory.id} vs ${id}`);
      }
    }
    
    return {
      valid: errors.length === 0,
      errors,
      stats: this.getStats()
    };
  }
}

module.exports = MemoryIndex;