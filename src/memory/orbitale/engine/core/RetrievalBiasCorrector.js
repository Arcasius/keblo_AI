// src/core/RetrievalBiasCorrector.js
class RetrievalBiasCorrector {
  constructor(config = {}) {
    // FIX 12 - Pesci retrieval
    this.similarityWeight = config.similarityWeight || 0.7;
    this.activationWeight = config.activationWeight || 0.3;
  }

  /**
   * FIX 12 - Calcola score finale combinato
   */
  computeFinalScore(vectorSimilarity, activation) {
    return vectorSimilarity * this.similarityWeight + 
           activation * this.activationWeight;
  }

  /**
   * Retrieval con bias correction
   */
  async retrieveWithBias(query, candidates, embeddingService) {
    const queryEmbedding = await embeddingService.generateEmbedding(query);
    
    const scored = await Promise.all(
      candidates.map(async candidate => {
        const similarity = await embeddingService.calculateSimilarity(
          queryEmbedding,
          candidate.embedding_ref
        );
        
        const finalScore = this.computeFinalScore(
          similarity,
          candidate.activation || 0.5
        );
        
        return {
          ...candidate,
          relevance: finalScore,
          similarity,
          activation: candidate.activation
        };
      })
    );
    
    return scored.sort((a, b) => b.relevance - a.relevance);
  }
}

// ============================================

// src/core/TransactionGuard.js
class TransactionGuard {
  constructor(transactionManager) {
    this.txManager = transactionManager;
  }

  /**
   * FIX 13 - Esegui operazione in transazione
   */
  async transactional(userId, operations) {
    const tx = await this.txManager.beginTransaction(userId);
    
    try {
      const results = [];
      
      for (const op of operations) {
        // Log operazione
        await this.txManager.writeOperation(tx.id, {
          type: op.type,
          entity: op.entity,
          data: op.data
        });
        
        // Esegui
        const result = await op.execute();
        results.push(result);
      }
      
      // Commit
      await this.txManager.commit(tx.id);
      
      return results;
      
    } catch (error) {
      // Rollback su errore
      await this.txManager.rollback(tx.id);
      throw new Error(`Transaction failed: ${error.message}`);
    }
  }

  /**
   * Update nodo con guardia transazionale
   */
  async updateNode(userId, nodeId, updates, storage) {
    return this.transactional(userId, [
      {
        type: 'UPDATE_NODE',
        entity: 'memory',
        data: { nodeId, updates },
        execute: async () => {
          const node = await storage.getMemory(userId, nodeId);
          Object.assign(node, updates);
          await storage.saveMemory(userId, node);
          return node;
        }
      }
    ]);
  }

  /**
   * Update link con guardia transazionale
   */
  async updateLink(userId, linkId, updates, storage) {
    return this.transactional(userId, [
      {
        type: 'UPDATE_LINK',
        entity: 'link',
        data: { linkId, updates },
        execute: async () => {
          const links = await storage.loadLinks(userId);
          const link = links.find(l => l.id === linkId);
          Object.assign(link, updates);
          await storage.saveLinks(userId, links);
          return link;
        }
      }
    ]);
  }
}

// ============================================

// src/monitoring/MetricsHardDashboard.js
class MetricsHardDashboard {
  constructor() {
    // FIX 14 - Metriche hard
    this.metrics = {
      totalNodes: 0,
      totalLinks: 0,
      averageActivation: 0,
      energyVariance: 0,
      clusterCount: 0,
      coldMemoryCount: 0,
      
      // Metriche aggiuntive
      nodeDistribution: {
        short: 0,
        medium: 0,
        long: 0
      },
      linkDistribution: {
        semantic: 0,
        temporal: 0,
        causal: 0,
        episodic: 0
      },
      activationHistogram: [0, 0, 0, 0, 0], // 0-0.2, 0.2-0.4, etc
      
      timestamp: Date.now()
    };
    
    this.history = [];
    this.maxHistory = 1000;
  }

  /**
   * Aggiorna metriche da stato attuale
   */
  async refresh(userId, storage) {
    const memories = await storage.loadMemories(userId);
    const links = await storage.loadLinks(userId);
    const clusters = await storage.loadClusters(userId);
    
    // Totali
    this.metrics.totalNodes = memories.length;
    this.metrics.totalLinks = links.length;
    this.metrics.clusterCount = clusters.length;
    
    // Attivazione media
    const sumActivation = memories.reduce((s, m) => s + (m.activation || 0), 0);
    this.metrics.averageActivation = memories.length > 0 ? 
      sumActivation / memories.length : 0;
    
    // Varianza energia
    const mean = this.metrics.averageActivation;
    const variance = memories.reduce((s, m) => 
      s + Math.pow((m.activation || 0) - mean, 2), 0
    ) / (memories.length || 1);
    this.metrics.energyVariance = variance;
    
    // Distribuzione orbite
    this.metrics.nodeDistribution = {
      short: memories.filter(m => m.orbitalLevel === 'short').length,
      medium: memories.filter(m => m.orbitalLevel === 'medium').length,
      long: memories.filter(m => m.orbitalLevel === 'long').length
    };
    
    // Memorie fredde
    this.metrics.coldMemoryCount = memories.filter(m => m.cold).length;
    
    // Istogramma attivazione
    const hist = [0, 0, 0, 0, 0];
    for (const m of memories) {
      const act = m.activation || 0;
      if (act < 0.2) hist[0]++;
      else if (act < 0.4) hist[1]++;
      else if (act < 0.6) hist[2]++;
      else if (act < 0.8) hist[3]++;
      else hist[4]++;
    }
    this.metrics.activationHistogram = hist;
    
    // Distribuzione link
    const linkTypes = { semantic: 0, temporal: 0, causal: 0, episodic: 0 };
    for (const l of links) {
      if (linkTypes[l.type] !== undefined) linkTypes[l.type]++;
    }
    this.metrics.linkDistribution = linkTypes;
    
    this.metrics.timestamp = Date.now();
    
    // Salva in history
    this.history.push({ ...this.metrics });
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }
    
    return this.metrics;
  }

  /**
   * Ottieni dashboard formattata
   */
  getDashboard() {
    return {
      current: this.metrics,
      trends: this.calculateTrends(),
      alerts: this.checkAlerts()
    };
  }

  /**
   * Calcola trend (ultima ora vs ora precedente)
   */
  calculateTrends() {
    if (this.history.length < 2) return null;
    
    const now = this.metrics;
    const then = this.history[this.history.length - 2];
    
    return {
      nodesTrend: now.totalNodes - then.totalNodes,
      activationTrend: (now.averageActivation - then.averageActivation).toFixed(3),
      coldTrend: now.coldMemoryCount - then.coldMemoryCount
    };
  }

  /**
   * Check alert conditioni
   */
  checkAlerts() {
    const alerts = [];
    
    if (this.metrics.energyVariance > 0.3) {
      alerts.push('ALTA VARIANZA ENERGETICA');
    }
    
    if (this.metrics.coldMemoryCount > this.metrics.totalNodes * 0.5) {
      alerts.push('TROPPE MEMORIE FREDDE');
    }
    
    if (this.metrics.averageActivation < 0.1) {
      alerts.push('RISCHIO CONGELAMENTO');
    }
    
    if (this.metrics.averageActivation > 0.8) {
      alerts.push('RISCHIO SATURAZIONE');
    }
    
    return alerts;
  }

  /**
   * Esporta in formato Prometheus
   */
  toPrometheus() {
    return `
# HELP memoria_total_nodes Numero totale nodi
# TYPE memoria_total_nodes gauge
memoria_total_nodes ${this.metrics.totalNodes}

# HELP memoria_total_links Numero totale link
# TYPE memoria_total_links gauge
memoria_total_links ${this.metrics.totalLinks}

# HELP memoria_average_activation Attivazione media
# TYPE memoria_average_activation gauge
memoria_average_activation ${this.metrics.averageActivation}

# HELP memoria_energy_variance Varianza energetica
# TYPE memoria_energy_variance gauge
memoria_energy_variance ${this.metrics.energyVariance}

# HELP memoria_cold_memory_count Memorie fredde
# TYPE memoria_cold_memory_count gauge
memoria_cold_memory_count ${this.metrics.coldMemoryCount}
`;
  }
}

module.exports = {
  RetrievalBiasCorrector,
  TransactionGuard,
  MetricsHardDashboard
};