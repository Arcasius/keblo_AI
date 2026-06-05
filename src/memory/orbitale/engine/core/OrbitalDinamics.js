// src/core/OrbitalDynamics.js
class OrbitalDynamics {
  constructor(userId, storage, embeddingService) {
    this.userId = userId;
    this.storage = storage;
    this.embeddingService = embeddingService;
    this.thresholds = {
      short: { min: 0.7, max: 1.0 },
      medium: { min: 0.3, max: 0.7 },
      long: { min: 0.01, max: 0.3 }
    };
  }

  async decayAll() {
    const memories = await this.storage.loadMemories(this.userId);
    const links = await this.storage.loadLinks(this.userId);
    
    for (const memory of memories) {
      // Decay basato sul tempo
      const oldScore = memory.orbital.activation_score;
      const timeSinceLastAccess = (new Date() - new Date(memory.orbital.last_access)) / 86400000;
      
      memory.orbital.activation_score *= (1 - memory.orbital.decay_rate * timeSinceLastAccess);
      
      // Non scendere sotto zero
      memory.orbital.activation_score = Math.max(0.01, memory.orbital.activation_score);
      
      // Se c'è stato un cambiamento significativo, ricalcola orbita
      if (Math.abs(oldScore - memory.orbital.activation_score) > 0.05) {
        memory.recalculateOrbitalLevel();
      }
    }
    
    // Decay anche per i link
    for (const link of links) {
      const timeSinceLastReinforce = (new Date() - new Date(link.last_reinforced)) / 86400000;
      link.decay(timeSinceLastReinforce);
    }
    
    await this.storage.saveMemories(this.userId, memories);
    await this.storage.saveLinks(this.userId, links);
    
    return { memories_decayed: memories.length, links_decayed: links.length };
  }

  async reinforceMemory(memoryId, contextMemories = []) {
    const memory = await this.storage.getMemory(this.userId, memoryId);
    if (!memory) throw new Error('Memory not found');
    
    // Reinforzo la memoria principale
    memory.updateAccess();
    
    // Reinforzo i link con le memorie nel contesto
    for (const ctxMem of contextMemories) {
      if (ctxMem.id === memoryId) continue;
      
      let link = await this.storage.getLinkBetween(this.userId, memoryId, ctxMem.id);
      
      if (link) {
        link.reinforce(0.05);
        await this.storage.saveLink(this.userId, link);
      } else {
        // Crea nuovo link se la similarità semantica è alta
        const similarity = await this.embeddingService.calculateSimilarity(
          memory.embedding_ref, 
          ctxMem.embedding_ref
        );
        
        if (similarity > 0.6) {
          const CognitiveLink = require('./Link');
          link = new CognitiveLink({
            source: memoryId,
            target: ctxMem.id,
            weight: similarity * 0.8,
            type: 'semantic'
          }, this.userId);
          await this.storage.saveLink(this.userId, link);
        }
      }
    }
    
    await this.storage.saveMemory(this.userId, memory);
    return memory;
  }

  async getActiveContext(limit = 10, allowedLevels = ['short', 'medium']) {
    const memories = await this.storage.loadMemories(this.userId);
    
    // Filtra per livello orbitale e ordina per activation score
    const active = memories
      .filter(m => allowedLevels.includes(m.orbital.level))
      .sort((a, b) => b.orbital.activation_score - a.orbital.activation_score)
      .slice(0, limit);
    
    // Arricchisci con i link più forti
    const context = [];
    for (const memory of active) {
      const links = await this.storage.getLinksForMemory(this.userId, memory.id);
      const strongLinks = links
        .filter(l => l.weight > 0.5)
        .map(l => ({
          targetId: l.source === memory.id ? l.target : l.source,
          weight: l.weight,
          type: l.type
        }));
      
      context.push({
        memory: memory.toJSON(),
        strong_links: strongLinks
      });
    }
    
    return context;
  }

  async calculateOrbitalDistribution() {
    const memories = await this.storage.loadMemories(this.userId);
    
    const distribution = {
      short: 0,
      medium: 0,
      long: 0,
      cold: 0
    };
    
    for (const m of memories) {
      distribution[m.orbital.level]++;
      if (m.isCold()) distribution.cold++;
    }
    
    return distribution;
  }
}

module.exports = OrbitalDynamics;