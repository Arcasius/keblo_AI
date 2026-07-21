// src/core/GravitationalField.js
class GravitationalField {
  constructor(embeddingService, storage) {
    this.embeddingService = embeddingService;
    this.storage = storage;
    this.G = 0.1; // Costante gravitazionale
    const self = this;
  }

  /**
   * Calcola l'influenza gravitazionale su un nodo da tutti i nodi nel raggio
   * Implementa: F = G * (m1 * m2) / r^2
   * dove m = activation_score, r = distanza semantica
   */
  async calculateInfluence(memoryId, userId, options = {}) {
    const {
      topK = 20,
      minSimilarity = 0.3,
      maxDistance = 2.0
    } = options;

    const memory = await this.storage.getMemory(userId, memoryId);
    if (!memory) return 0;

    const memoryEmbedding = await this.embeddingService.getEmbedding(memory.embedding_ref);
    
    // Trova nodi simili semanticamente
    const similar = await this.embeddingService.searchSimilar(
      userId,
      memoryEmbedding,
      topK * 2 // Prendine di più per filtrare
    );

    let totalInfluence = 0;
    const influences = [];

    for (const sim of similar) {
      if (sim.memory_id === memoryId) continue;
      
      const similarMemory = await this.storage.getMemory(userId, sim.memory_id);
      if (!similarMemory) continue;

      // Distanza semantica (conversione da similarità a distanza)
      const semanticDistance = 1 - sim.score; // 0 = identico, 1 = ortogonale
      
      if (semanticDistance > maxDistance) continue;

      // Massa = activation_score
      const mass1 = memory.orbital.activation_score;
      const mass2 = similarMemory.orbital.activation_score;
      
      // Legge di gravità: F = G * (m1 * m2) / r^2
      // Aggiungiamo epsilon per evitare divisione per zero
      const force = self.G * (mass1 * mass2) / Math.max(0.1, semanticDistance * semanticDistance);
      
      // L'influenza diminuisce con la distanza e aumenta con le masse
      const influence = force * (1 - semanticDistance / maxDistance);
      
      influences.push({
        memoryId: similarMemory.id,
        distance: semanticDistance,
        mass: mass2,
        force,
        influence
      });

      totalInfluence += influence;
    }

    // Normalizza e ordina
    influences.sort((a, b) => b.influence - a.influence);
    
    return {
      totalInfluence,
      topInfluences: influences.slice(0, 5),
      fieldStrength: totalInfluence / (similar.length || 1)
    };
  }

  /**
   * Applica il campo gravitazionale a tutti i nodi
   */
  async applyGravitationalField(userId) {
    const memories = await this.storage.loadMemories(userId);
    const updates = [];

    for (const memory of memories) {
      // Salta memorie in cold storage
      if (memory.isCold && memory.isCold()) continue;

      const field = await this.calculateInfluence(memory.id, userId, {
        topK: 15,
        minSimilarity: 0.2
      });

      // L'influenza gravitazionale modifica l'attivazione
      const oldActivation = memory.orbital.activation_score;
      
      // Aggiungi influenza gravitazionale (max 30% di cambiamento)
      const gravitationalBoost = field.fieldStrength * 0.3;
      memory.orbital.activation_score = Math.min(1.0, 
        memory.orbital.activation_score + gravitationalBoost
      );

      if (Math.abs(oldActivation - memory.orbital.activation_score) > 0.01) {
        updates.push(memory.id);
        await this.storage.saveMemory(userId, memory);
      }
    }

    return {
      updated: updates.length,
      totalMemories: memories.length,
      averageFieldStrength: updates.length > 0 ? 
        updates.reduce((acc, id) => acc + field.fieldStrength, 0) / updates.length : 0
    };
  }

  /**
   * Calcola il potenziale gravitazionale di un cluster
   */
  async calculateClusterPotential(clusterId, userId) {
    const cluster = await this.storage.getCluster(userId, clusterId);
    if (!cluster) return 0;

    const memories = await Promise.all(
      cluster.memory_ids.map(id => this.storage.getMemory(userId, id))
    );

    let totalPotential = 0;
    const pairs = 0;

    for (let i = 0; i < memories.length; i++) {
      for (let j = i + 1; j < memories.length; j++) {
        const embI = await this.embeddingService.getEmbedding(memories[i].embedding_ref);
        const embJ = await this.embeddingService.getEmbedding(memories[j].embedding_ref);
        
        const similarity = this.embeddingService.cosineSimilarity(embI, embJ);
        const distance = 1 - similarity;
        
        const potential = self.G * 
          (memories[i].orbital.activation_score * memories[j].orbital.activation_score) / 
          Math.max(0.1, distance);
        
        totalPotential += potential;
      }
    }

    return {
      clusterId,
      potential: totalPotential,
      density: totalPotential / (memories.length || 1),
      size: memories.length
    };
  }
}

module.exports = GravitationalField;