// src/core/ClusterEngine.js
class ClusterEngine {
  constructor(userId, storage, embeddingService) {
    this.userId = userId;
    this.storage = storage;
    this.embeddingService = embeddingService;
    this.MIN_CLUSTER_SIZE = 3;
    this.MAX_CLUSTER_SIZE = 100;
    this.CLUSTER_SIMILARITY_THRESHOLD = 0.3;
    this.DENSITY_THRESHOLD = 0.4;
  }

  async createCluster(memoryIds) {
    const memories = await Promise.all(
      memoryIds.map(id => this.storage.getMemory(this.userId, id))
    );
    
    if (memories.length < this.MIN_CLUSTER_SIZE) {
      throw new Error(`Need at least ${this.MIN_CLUSTER_SIZE} memories for cluster`);
    }
    
    // Calcola centroide come media degli embedding
    const embeddings = await Promise.all(
      memories.map(m => this.embeddingService.getEmbedding(m.embedding_ref))
    );
    
    const centroid = this.calculateCentroid(embeddings);
    const centroidId = await this.embeddingService.storeEmbedding(centroid, {
      type: 'cluster_centroid',
      user_id: this.userId
    });
    
    // Calcola densità interna
    const internalSimilarities = await Promise.all(
      embeddings.map(e => this.embeddingService.cosineSimilarity(e, centroid))
    );
    const density = internalSimilarities.reduce((a, b) => a + b, 0) / internalSimilarities.length;
    
    const cluster = {
      id: `cl_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      memory_ids: memoryIds,
      centroid_ref: centroidId,
      density: density,
      created_at: new Date().toISOString(),
      last_updated: new Date().toISOString(),
      size: memories.length
    };
    
    // Aggiorna ogni memoria con il cluster id
    for (const memory of memories) {
      memory.cluster.id = cluster.id;
      memory.cluster.density = density;
      memory.cluster.centroid_ref = centroidId;
      await this.storage.saveMemory(this.userId, memory);
    }
    
    await this.storage.saveCluster(this.userId, cluster);
    return cluster;
  }

  calculateCentroid(embeddings) {
    const dimension = embeddings[0].length;
    const centroid = new Array(dimension).fill(0);
    
    for (const emb of embeddings) {
      for (let i = 0; i < dimension; i++) {
        centroid[i] += emb[i];
      }
    }
    
    for (let i = 0; i < dimension; i++) {
      centroid[i] /= embeddings.length;
    }
    
    return centroid;
  }

  async findOptimalClustering() {
    const memories = await this.storage.loadMemories(this.userId);
    const activeMemories = memories.filter(m => !m.isCold() && m.embedding_ref);
    
    if (activeMemories.length < this.MIN_CLUSTER_SIZE) {
      return [];
    }
    
    // Ottieni tutti gli embedding
    const embeddings = await Promise.all(
      activeMemories.map(m => this.embeddingService.getEmbedding(m.embedding_ref))
    );
    
    // Algoritmo di clustering gerarchico semplificato
    const clusters = [];
    const used = new Set();
    
    for (let i = 0; i < activeMemories.length; i++) {
      if (used.has(i)) continue;
      
      const clusterMemories = [activeMemories[i]];
      used.add(i);
      
      for (let j = i + 1; j < activeMemories.length; j++) {
        if (used.has(j)) continue;
        
        const similarity = this.embeddingService.cosineSimilarity(embeddings[i], embeddings[j]);
        
        if (similarity > 1 - this.CLUSTER_SIMILARITY_THRESHOLD) {
          clusterMemories.push(activeMemories[j]);
          used.add(j);
        }
      }
      
      if (clusterMemories.length >= this.MIN_CLUSTER_SIZE) {
        const cluster = await this.createCluster(clusterMemories.map(m => m.id));
        clusters.push(cluster);
      }
    }
    
    return clusters;
  }

  async mergeClusters(clusterId1, clusterId2) {
    const cluster1 = await this.storage.getCluster(this.userId, clusterId1);
    const cluster2 = await this.storage.getCluster(this.userId, clusterId2);
    
    if (!cluster1 || !cluster2) {
      throw new Error('One or both clusters not found');
    }
    
    const allMemoryIds = [...new Set([...cluster1.memory_ids, ...cluster2.memory_ids])];
    
    if (allMemoryIds.length > this.MAX_CLUSTER_SIZE) {
      throw new Error('Merged cluster would exceed max size');
    }
    
    // Crea nuovo cluster fuso
    const newCluster = await this.createCluster(allMemoryIds);
    
    // Elimina vecchi cluster
    await this.storage.deleteCluster(this.userId, clusterId1);
    await this.storage.deleteCluster(this.userId, clusterId2);
    
    return newCluster;
  }

  async splitCluster(clusterId, threshold = 0.6) {
    const cluster = await this.storage.getCluster(this.userId, clusterId);
    const memories = await Promise.all(
      cluster.memory_ids.map(id => this.storage.getMemory(this.userId, id))
    );
    
    const embeddings = await Promise.all(
      memories.map(m => this.embeddingService.getEmbedding(m.embedding_ref))
    );
    
    // Calcola matrice di similarità
    const similarities = [];
    for (let i = 0; i < memories.length; i++) {
      similarities[i] = [];
      for (let j = 0; j < memories.length; j++) {
        similarities[i][j] = this.embeddingService.cosineSimilarity(embeddings[i], embeddings[j]);
      }
    }
    
    // Identifica sotto-cluster basati su similarità bassa
    const subClusters = [];
    const used = new Set();
    
    for (let i = 0; i < memories.length; i++) {
      if (used.has(i)) continue;
      
      const subCluster = [memories[i]];
      used.add(i);
      
      for (let j = i + 1; j < memories.length; j++) {
        if (used.has(j)) continue;
        
        // Se la similarità media con il subCluster è alta
        const avgSim = subCluster.reduce((sum, mem) => {
          const idx = memories.findIndex(m => m.id === mem.id);
          return sum + similarities[idx][j];
        }, 0) / subCluster.length;
        
        if (avgSim > threshold) {
          subCluster.push(memories[j]);
          used.add(j);
        }
      }
      
      if (subCluster.length >= this.MIN_CLUSTER_SIZE) {
        subClusters.push(subCluster);
      }
    }
    
    // Se abbiamo più di un subCluster, dividi
    if (subClusters.length > 1) {
      // Elimina cluster originale
      await this.storage.deleteCluster(this.userId, clusterId);
      
      // Crea nuovi cluster
      const newClusters = [];
      for (const sub of subClusters) {
        const newCluster = await this.createCluster(sub.map(m => m.id));
        newClusters.push(newCluster);
      }
      
      return newClusters;
    }
    
    return [cluster]; // Nessuna divisione
  }

  async getClusterDensity(clusterId) {
    const cluster = await this.storage.getCluster(this.userId, clusterId);
    const memories = await Promise.all(
      cluster.memory_ids.map(id => this.storage.getMemory(this.userId, id))
    );
    
    const centroid = await this.embeddingService.getEmbedding(cluster.centroid_ref);
    
    // Similarità interna
    let internalSum = 0;
    for (const memory of memories) {
      const emb = await this.embeddingService.getEmbedding(memory.embedding_ref);
      internalSum += this.embeddingService.cosineSimilarity(emb, centroid);
    }
    const internalDensity = internalSum / memories.length;
    
    // Isolamento esterno (distanza da altri cluster)
    const otherClusters = await this.storage.loadClusters(this.userId);
    let externalSum = 0;
    let externalCount = 0;
    
    for (const other of otherClusters) {
      if (other.id === clusterId) continue;
      
      const otherCentroid = await this.embeddingService.getEmbedding(other.centroid_ref);
      externalSum += this.embeddingService.cosineSimilarity(centroid, otherCentroid);
      externalCount++;
    }
    
    const externalIsolation = externalCount > 0 ? 1 - (externalSum / externalCount) : 1;
    
    return {
      internal_density: internalDensity,
      external_isolation: externalIsolation,
      density_score: internalDensity * externalIsolation
    };
  }
}

module.exports = ClusterEngine;