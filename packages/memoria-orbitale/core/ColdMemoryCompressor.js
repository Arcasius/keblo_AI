// src/core/ColdMemoryCompressor.js
class ColdMemoryCompressor {
  constructor(config = {}) {
    this.coldThreshold = config.coldThreshold || 0.05;
    this.coldAgeDays = config.coldAgeDays || 30;
    this.compressionRatio = config.compressionRatio || 0.3; // Riduzione metadata
    
    // FIX 11 - Entropy monitor
    this.varianceWindow = config.varianceWindow || 5;
  }

  /**
   * Identifica memorie fredde
   */
  identifyColdMemories(memories) {
    const now = Date.now();
    const coldAgeMs = this.coldAgeDays * 24 * 60 * 60 * 1000;
    
    return memories.filter(m => 
      m.activation < this.coldThreshold &&
      (now - (m.lastAccess || m.timestamp)) > coldAgeMs
    );
  }

  /**
   * FIX 8 - Comprimi memoria fredda
   */
  compressMemory(memory) {
    // Mantieni solo l'essenziale
    const compressed = {
      id: memory.id,
      type: memory.type,
      content: {
        // Mantieni solo testo, niente entità/tags
        text: memory.content.text
      },
      activation: memory.activation,
      orbitalLevel: memory.orbitalLevel,
      timestamp: memory.timestamp,
      
      // Flag cold
      cold: true,
      compressedAt: Date.now(),
      
      // Metadata ridotti (niente embedding_ref, links_summary, etc)
      meta: {
        user_id: memory.meta.user_id,
        compressed: true
      }
    };
    
    return compressed;
  }

  /**
   * FIX 8 - Rimuovi link secondari per memorie fredde
   */
  pruneLinksForColdMemory(memoryId, links) {
    // Mantieni solo link più forti (top 3)
    const memoryLinks = links.filter(l => 
      l.source === memoryId || l.target === memoryId
    );
    
    if (memoryLinks.length <= 3) return links;
    
    // Ordina per peso
    const sorted = memoryLinks.sort((a, b) => b.weight - a.weight);
    const keepIds = new Set(sorted.slice(0, 3).map(l => l.id));
    
    // Filtra
    return links.filter(l => 
      !(l.source === memoryId || l.target === memoryId) || keepIds.has(l.id)
    );
  }

  /**
   * FIX 11 - Calcola varianza attivazione
   */
  calculateActivationVariance(memory, windowSize = this.varianceWindow) {
    if (!memory.activationHistory || memory.activationHistory.length < 2) {
      return 0;
    }
    
    const recent = memory.activationHistory.slice(-windowSize);
    const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
    
    const variance = recent.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / recent.length;
    
    return variance;
  }

  /**
   * FIX 11 - Stabilizza nodi con alta varianza
   */
  stabilizeHighVarianceNode(memory, variance) {
    if (variance > 0.1) { // Soglia varianza alta
      // Riduci reinforcement del 10%
      return {
        ...memory,
        reinforcementMultiplier: 0.9,
        lastStabilized: Date.now()
      };
    }
    return memory;
  }

  /**
   * Processo completo compressione
   */
  async processCompression(userId, storage) {
    const memories = await storage.loadMemories(userId);
    const links = await storage.loadLinks(userId);
    
    // Identifica fredde
    const coldMemories = this.identifyColdMemories(memories);
    
    if (coldMemories.length === 0) {
      return { compressed: 0, message: 'No cold memories' };
    }
    
    const coldIds = new Set(coldMemories.map(m => m.id));
    
    // Comprimi memorie fredde
    const compressedMemories = memories.map(m => 
      coldIds.has(m.id) ? this.compressMemory(m) : m
    );
    
    // Prune link per memorie fredde
    let updatedLinks = links;
    for (const coldId of coldIds) {
      updatedLinks = this.pruneLinksForColdMemory(coldId, updatedLinks);
    }
    
    // Salva
    await storage.saveMemories(userId, compressedMemories);
    await storage.saveLinks(userId, updatedLinks);
    
    return {
      compressed: coldMemories.length,
      totalMemories: memories.length,
      remainingLinks: updatedLinks.length
    };
  }

  /**
   * FIX 11 - Monitor entropia per nodo
   */
  async monitorEntropy(userId, storage) {
    const memories = await storage.loadMemories(userId);
    const updates = [];
    
    for (const memory of memories) {
      const variance = this.calculateActivationVariance(memory);
      const stabilized = this.stabilizeHighVarianceNode(memory, variance);
      
      if (stabilized !== memory) {
        updates.push(stabilized);
        await storage.saveMemory(userId, stabilized);
      }
    }
    
    return {
      monitored: memories.length,
      stabilized: updates.length
    };
  }
}

module.exports = ColdMemoryCompressor;