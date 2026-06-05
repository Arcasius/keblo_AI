// src/core/IncrementalMaintenance.js
class IncrementalMaintenance {
  constructor(config = {}) {
    this.batchSize = config.batchSize || 200;
    this.cycleInterval = config.cycleInterval || 3600000; // 1 ora
    
    // Stato persistente
    this.lastIndex = new Map(); // userId -> lastIndex
    this.cycleCount = new Map(); // userId -> cycleCount
  }

  /**
   * Ottieni prossimo batch da processare
   */
  getNextBatch(userId, allItems) {
    const lastIdx = this.lastIndex.get(userId) || 0;
    const startIdx = lastIdx % allItems.length;
    
    const batch = [];
    for (let i = 0; i < this.batchSize; i++) {
      const idx = (startIdx + i) % allItems.length;
      batch.push(allItems[idx]);
      
      if (batch.length >= allItems.length) break; // Abbiamo processato tutto
    }
    
    // Aggiorna ultimo indice
    const newLastIdx = (startIdx + batch.length) % allItems.length;
    this.lastIndex.set(userId, newLastIdx);
    
    return {
      batch,
      isComplete: batch.length === allItems.length,
      progress: (newLastIdx / allItems.length) * 100
    };
  }

  /**
   * Processa maintenance incrementale per memorie
   */
  async processMemoryBatch(userId, storage, processor) {
    const memories = await storage.loadMemories(userId);
    
    if (memories.length === 0) {
      return { processed: 0, message: 'No memories' };
    }
    
    const { batch, isComplete, progress } = this.getNextBatch(userId, memories);
    
    const results = [];
    for (const memory of batch) {
      const result = await processor(memory);
      results.push(result);
      
      // Salva dopo ogni modifica? No, meglio batch per performance
    }
    
    // Salva modifiche in batch
    const updatedMemories = memories.map(m => {
      const updated = results.find(r => r.id === m.id);
      return updated || m;
    });
    
    await storage.saveMemories(userId, updatedMemories);
    
    // Aggiorna contatore cicli
    const cycles = this.cycleCount.get(userId) || 0;
    this.cycleCount.set(userId, cycles + 1);
    
    return {
      processed: batch.length,
      total: memories.length,
      progress: progress.toFixed(2) + '%',
      cycleCompleted: isComplete,
      cycleNumber: cycles + 1
    };
  }

  /**
   * Processa maintenance incrementale per link
   */
  async processLinkBatch(userId, storage, processor) {
    const links = await storage.loadLinks(userId);
    
    if (links.length === 0) {
      return { processed: 0 };
    }
    
    const { batch } = this.getNextBatch(userId + '_links', links);
    
    for (const link of batch) {
      await processor(link);
    }
    
    return {
      processed: batch.length,
      total: links.length
    };
  }

  /**
   * FIX 10 - Cluster stability filter
   */
  async maintainClusters(userId, storage, clusterEngine) {
    const clusters = await storage.loadClusters(userId);
    const stableClusters = [];
    
    for (const cluster of clusters) {
      // Calcola persistenza (quanti cicli è sopravvissuto)
      const cycles = this.cycleCount.get(userId) || 0;
      const clusterAge = cycles - (cluster.birthCycle || 0);
      
      // FIX 10 - Cluster valido solo se denso E persistente
      if (cluster.density > 0.4 && clusterAge >= 3) {
        stableClusters.push(cluster);
      } else {
        // Cluster immaturo o non denso - considera splitting o merge
        console.log(`Cluster ${cluster.id} immaturo: density=${cluster.density}, age=${clusterAge}`);
      }
    }
    
    return {
      totalClusters: clusters.length,
      stableClusters: stableClusters.length,
      unstableClusters: clusters.length - stableClusters.length
    };
  }

  /**
   * Salva stato maintenance
   */
  saveState(userId) {
    return {
      lastIndex: this.lastIndex.get(userId),
      cycleCount: this.cycleCount.get(userId) || 0,
      timestamp: Date.now()
    };
  }

  /**
   * Carica stato maintenance
   */
  loadState(userId, state) {
    if (state) {
      this.lastIndex.set(userId, state.lastIndex);
      this.cycleCount.set(userId, state.cycleCount);
    }
  }
}

module.exports = IncrementalMaintenance;