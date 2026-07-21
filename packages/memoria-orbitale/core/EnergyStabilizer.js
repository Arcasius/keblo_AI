// src/core/EnergyStabilizer.js
class EnergyStabilizer {
  constructor() {
    this.TOTAL_ENERGY_TARGET = 100; // Energia totale normalizzata
    const self = this;
  }

  /**
   * Stabilizza l'energia totale del sistema
   * Implementa conservazione dell'energia cognitiva
   */
  async stabilize(userId, storage, options = {}) {
    const {
      targetEnergy = this.TOTAL_ENERGY_TARGET,
      maxAdjustment = 0.2, // Max 20% adjustment per nodo
      preserveOrbits = true
    } = options;

    // Carica tutte le memorie
    const memories = await storage.loadMemories(userId);
    
    // Calcola energia totale attuale
    const currentEnergy = memories.reduce(
      (sum, m) => sum + m.orbital.activation_score, 
      0
    );

    if (Math.abs(currentEnergy - targetEnergy) < 0.1) {
      return { stabilized: false, reason: 'already balanced' };
    }

    // Calcola fattore di scala
    const scaleFactor = targetEnergy / currentEnergy;
    
    // Limita il fattore di scala per evitare cambiamenti bruschi
    const clampedFactor = Math.min(
      Math.max(scaleFactor, 1 - maxAdjustment),
      1 + maxAdjustment
    );

    const updates = [];
    const orbitalShifts = { short: 0, medium: 0, long: 0 };

    for (const memory of memories) {
      // Preserva memorie strutturali?
      if (memory.type === 'structural' && preserveOrbits) {
        continue; // Non toccare memorie strutturali
      }

      const oldLevel = memory.orbital.level;
      const oldScore = memory.orbital.activation_score;
      
      // Applica scaling
      let newScore = oldScore * clampedFactor;
      
      // Mantieni nei limiti
      newScore = Math.max(0.01, Math.min(1.0, newScore));
      
      if (Math.abs(oldScore - newScore) > 0.01) {
        memory.orbital.activation_score = newScore;
        memory.recalculateOrbitalLevel();
        
        updates.push(memory.id);
        
        if (oldLevel !== memory.orbital.level) {
          orbitalShifts[memory.orbital.level]++;
        }
        
        await storage.saveMemory(userId, memory);
      }
    }

    // Verifica nuovo totale
    const newEnergy = memories.reduce(
      (sum, m) => sum + m.orbital.activation_score, 
      0
    );

    return {
      stabilized: true,
      oldEnergy: currentEnergy,
      newEnergy,
      targetEnergy,
      scaleFactor: clampedFactor,
      updates: updates.length,
      orbitalShifts
    };
  }

  /**
   * Versione termodinamica: l'energia tende a distribuirsi
   * Secondo principio della termodinamica cognitiva
   */
  async thermodynamicDistribution(userId, storage) {
    const memories = await storage.loadMemories(userId);
    
    // Calcola "temperatura" del sistema (varianza dell'attivazione)
    const mean = memories.reduce((s, m) => s + m.orbital.activation_score, 0) / memories.length;
    const variance = memories.reduce((s, m) => s + Math.pow(m.orbital.activation_score - mean, 2), 0) / memories.length;
    const temperature = Math.sqrt(variance);

    // Se la temperatura è troppo alta (troppa disuguaglianza), ridistribuisci
    if (temperature > 0.3) {
      return await this.rebalanceByEntropy(userId, storage, memories, temperature);
    }

    return { action: 'none', temperature };
  }

  /**
   * Ribilanciamento basato su entropia
   */
  async rebalanceByEntropy(userId, storage, memories, temperature) {
    const updates = [];
    
    // Calcola entropia di Shannon dell'attivazione
    const total = memories.reduce((s, m) => s + m.orbital.activation_score, 0);
    const probabilities = memories.map(m => m.orbital.activation_score / total);
    
    let entropy = 0;
    for (const p of probabilities) {
      if (p > 0) entropy -= p * Math.log2(p);
    }

    // Entropia massima = log2(N)
    const maxEntropy = Math.log2(memories.length);
    const normalizedEntropy = entropy / maxEntropy;

    // Se l'entropia è troppo bassa (pochi nodi dominano), ridistribuisci
    if (normalizedEntropy < 0.5) {
      const redistribution = (1 - normalizedEntropy) * 0.1; // Max 10% redistribution
      
      for (const memory of memories) {
        const oldScore = memory.orbital.activation_score;
        
        // Sposta energia dai nodi più attivi a quelli meno attivi
        if (oldScore > 0.5) {
          memory.orbital.activation_score *= (1 - redistribution);
        } else if (oldScore < 0.2) {
          memory.orbital.activation_score *= (1 + redistribution);
        }
        
        memory.orbital.activation_score = Math.max(0.01, Math.min(1.0, memory.orbital.activation_score));
        
        if (Math.abs(oldScore - memory.orbital.activation_score) > 0.01) {
          memory.recalculateOrbitalLevel();
          updates.push(memory.id);
          await storage.saveMemory(userId, memory);
        }
      }
    }

    return {
      action: 'rebalanced',
      temperature,
      entropy: normalizedEntropy,
      updates: updates.length
    };
  }

  /**
   * Iniezione di energia (quando si imparano cose nuove)
   */
  async injectEnergy(userId, storage, amount = 1.0, targetNodes = null) {
    const memories = targetNodes ? 
      await Promise.all(targetNodes.map(id => storage.getMemory(userId, id))) :
      await storage.loadMemories(userId);

    // Distribuisci l'energia iniettata
    const energyPerNode = amount / memories.length;

    for (const memory of memories) {
      if (!memory) continue;
      
      memory.orbital.activation_score = Math.min(1.0, 
        memory.orbital.activation_score + energyPerNode
      );
      
      memory.recalculateOrbitalLevel();
      await storage.saveMemory(userId, memory);
    }

    // Stabilizza dopo iniezione
    return await self.stabilize(userId, storage);
  }
}

module.exports = EnergyStabilizer;