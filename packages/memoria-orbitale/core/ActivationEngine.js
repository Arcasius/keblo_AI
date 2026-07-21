// src/core/ActivationEngine.js
class ActivationEngine {
  constructor(config = {}) {
    // FIX 1 - Parametri standardizzati
    this.alpha = config.alpha || 0.85;      // Peso stato precedente
    this.beta = config.beta || 0.15;        // Peso rinforzo
    this.gamma = config.gamma || 0.05;       // Decay rate base
    
    // FIX 2 - Orbital momentum
    this.momentumFactor = config.momentumFactor || 0.9;
    
    // FIX 3 - Energy conservation
    this.energyThreshold = config.energyThreshold || 100;
    
    // FIX 15 - Freeze protection
    this.freezeThreshold = config.freezeThreshold || 0.1;
    this.decayReductionOnFreeze = config.decayReductionOnFreeze || 0.5;
  }

  /**
   * FIX 1 - Formula unica standardizzata di attivazione
   * activation = clamp(α * prev + β * reinforcement - γ * decay, 0, 1)
   */
  computeActivation(prevActivation, reinforcement = 0, timeDelta = 1) {
    const decay = this.gamma * timeDelta;
    
    let newActivation = 
      this.alpha * prevActivation + 
      this.beta * reinforcement - 
      decay;
    
    // Clamp hard [0, 1]
    return Math.max(0, Math.min(1, newActivation));
  }

  /**
   * FIX 2 - Orbital momentum layer
   * orbitalState = prevOrbitalState * 0.9 + activation * 0.1
   */
  computeOrbitalState(prevOrbitalState, currentActivation) {
    if (prevOrbitalState === undefined) return currentActivation;
    
    return prevOrbitalState * this.momentumFactor + 
           currentActivation * (1 - this.momentumFactor);
  }

  /**
   * Determina orbita da orbitalState (non da activation diretta)
   */
  determineOrbitalLevel(orbitalState) {
    if (orbitalState >= 0.7) return 'short';
    if (orbitalState >= 0.3) return 'medium';
    return 'long';
  }

  /**
   * FIX 3 - Energy conservation constraint
   * Normalizzazione globale dell'energia
   */
  normalizeGlobalEnergy(nodes) {
    const totalEnergy = nodes.reduce((sum, n) => sum + n.activation, 0);
    
    if (totalEnergy > this.energyThreshold) {
      const scaleFactor = this.energyThreshold / totalEnergy;
      
      return nodes.map(node => ({
        ...node,
        activation: node.activation * scaleFactor
      }));
    }
    
    return nodes;
  }

  /**
   * FIX 15 - Orbital freeze protection
   * Riduce decay se attivazione globale troppo bassa
   */
  adjustDecayForFreeze(globalAvgActivation) {
    if (globalAvgActivation < this.freezeThreshold) {
      return this.gamma * this.decayReductionOnFreeze;
    }
    return this.gamma;
  }

  /**
   * Update completo di un nodo
   */
  updateNode(node, reinforcement = 0, timeDelta = 1) {
    // FIX 1 - Nuova attivazione
    const newActivation = this.computeActivation(
      node.activation,
      reinforcement,
      timeDelta
    );
    
    // FIX 2 - Orbital state con momentum
    const newOrbitalState = this.computeOrbitalState(
      node.orbitalState || node.activation,
      newActivation
    );
    
    // Nuovo livello orbitale
    const newLevel = this.determineOrbitalLevel(newOrbitalState);
    
    return {
      ...node,
      activation: newActivation,
      orbitalState: newOrbitalState,
      orbitalLevel: newLevel,
      lastUpdate: Date.now()
    };
  }
}

module.exports = ActivationEngine;