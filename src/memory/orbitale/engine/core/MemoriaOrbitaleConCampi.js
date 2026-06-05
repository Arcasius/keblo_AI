// src/core/MemoriaOrbitaleConCampi.js
const GravitationalField = require('./GravitationalField');
const EnergyStabilizer = require('./EnergyStabilizer');
const MemoryTypes = require('./MemoryTypes');

class MemoriaOrbitaleConCampi extends MemoriaOrbitaleEnhanced {
  constructor(config = {}) {
    super(config);
    
    this.gravitationalField = new GravitationalField(
      this.embeddingService, 
      this.storage
    );
    
    this.energyStabilizer = new EnergyStabilizer();
    this.memoryTypes = new MemoryTypes(
      this.storage, 
      this.embeddingService
    );
  }

  async initialize() {
    await super.initialize();
    
    // Avvia campo gravitazionale come processo periodico
    setInterval(async () => {
      const users = await this.getActiveUsers();
      for (const userId of users) {
        await this.gravitationalField.applyGravitationalField(userId);
      }
    }, 1000 * 60 * 60); // Ogni ora
    
    // Stabilizzatore energetico ogni 6 ore
    setInterval(async () => {
      const users = await this.getActiveUsers();
      for (const userId of users) {
        await this.energyStabilizer.stabilize(userId, this.storage);
        await this.energyStabilizer.thermodynamicDistribution(userId, this.storage);
      }
    }, 1000 * 60 * 60 * 6);
    
    // Rilevazione pattern strutturali ogni giorno
    setInterval(async () => {
      const users = await this.getActiveUsers();
      for (const userId of users) {
        const candidates = await this.memoryTypes.detectStructuralCandidates(userId);
        for (const candidate of candidates) {
          await this.memoryTypes.consolidatePattern(userId, candidate);
        }
      }
    }, 1000 * 60 * 60 * 24);
    
    console.log('✅ Campi cognitivi attivati: Gravità, Energia, Struttura/Episodio');
  }

  // Override creazione memoria
  async createMemory(userId, content, type = 'episodic', options = {}) {
    let memoryData = await super.createMemory(userId, content, type, options);
    
    // Se è un pattern ricorrente, considera strutturale
    if (type === 'episodic') {
      const similar = await this.searchMemories(userId, content.text, { limit: 5 });
      if (similar.length >= 3) {
        // Potrebbe essere un pattern
        memoryData = await this.memoryTypes.createStructural(userId, {
          ...memoryData,
          category: 'emerging_pattern'
        });
      }
    }
    
    // Applica campo gravitazionale al nuovo nodo
    const field = await this.gravitationalField.calculateInfluence(
      memoryData.id, 
      userId
    );
    
    // Stabilizza energia
    await this.energyStabilizer.stabilize(userId, this.storage);
    
    return {
      ...memoryData,
      gravitationalField: field
    };
  }

  // Override retrieval
  async searchMemories(userId, query, options = {}) {
    // Usa retrieval contestuale che rispetta tipi
    return this.memoryTypes.retrieveWithContext(userId, query, options);
  }

  // Nuove API
  async getGravitationalField(userId, memoryId) {
    return this.gravitationalField.calculateInfluence(memoryId, userId);
  }

  async getEnergyState(userId) {
    const memories = await this.storage.loadMemories(userId);
    const total = memories.reduce((s, m) => s + m.orbital.activation_score, 0);
    
    return {
      totalEnergy: total,
      targetEnergy: this.energyStabilizer.TOTAL_ENERGY_TARGET,
      energyDeficit: this.energyStabilizer.TOTAL_ENERGY_TARGET - total,
      structuralCount: memories.filter(m => m.type === 'structural').length,
      episodicCount: memories.filter(m => m.type === 'episodic').length
    };
  }

  async detectStructuralPatterns(userId) {
    return this.memoryTypes.detectStructuralCandidates(userId);
  }
}

module.exports = MemoriaOrbitaleConCampi;