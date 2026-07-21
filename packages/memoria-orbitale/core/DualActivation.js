// src/core/DualActivation.js
const ActivationEngine = require('./ActivationEngine');

class DualActivation {
  constructor() {
    this.engine = new ActivationEngine(); // FIX: istanza unica
    // FIX 7 - Due canali separati
    this.cognitiveFactor = 0.7;
    this.affectiveBoost = 0.3;
  }

  /**
   * Crea stato iniziale duale
   */
  createDualState(initialCognitive = 0.5, initialAffective = 0) {
    return {
      cognitive: initialCognitive,
      affective: initialAffective,
      lastUpdate: Date.now()
    };
  }

  /**
   * Update cognitive (usa formula standard)
   */
  updateCognitive(prevCognitive, reinforcement = 0, timeDelta = 1) {
    return this.engine.computeActivation(prevCognitive, reinforcement, timeDelta);
  }

  /**
   * Update affective (influenzato da eventi emotivi)
   */
  updateAffective(prevAffective, emotionalStimulus = 0, decay = 0.02) {
    // Affective ha decay più lento e risposta più forte
    let newAffective = prevAffective * 0.98 + emotionalStimulus * 0.5;
    return Math.max(-1, Math.min(1, newAffective));
  }

  /**
   * OrbitalState usa SOLO cognitive
   */
  getOrbitalState(dualState) {
    return dualState.cognitive;
  }

  /**
   * Reinforcement combinato
   */
  computeReinforcement(dualState, baseReinforcement = 0) {
    // Affective amplifica reinforcement se positivo
    if (dualState.affective > 0) {
      return baseReinforcement * (1 + dualState.affective * this.affectiveBoost);
    }
    return baseReinforcement;
  }

  /**
   * Update completo duale
   */
  updateDualState(dualState, cognitiveReinforcement = 0, emotionalStimulus = 0, timeDelta = 1) {
    // Calcola reinforcement influenzato da affective
    const effectiveReinforcement = this.computeReinforcement(
      dualState, 
      cognitiveReinforcement
    );
    
    // Update cognitive
    const newCognitive = this.updateCognitive(
      dualState.cognitive,
      effectiveReinforcement,
      timeDelta
    );
    
    // Update affective
    const newAffective = this.updateAffective(
      dualState.affective,
      emotionalStimulus
    );
    
    return {
      cognitive: newCognitive,
      affective: newAffective,
      lastUpdate: Date.now()
    };
  }

  /**
   * Decay separato (affective non decade temporalmente)
   */
  applyDecay(dualState, timeDelta = 1) {
    const decayedCognitive = this.engine.computeActivation(
      dualState.cognitive,
      0,
      timeDelta
    );
    
    // Affective NON decade col tempo (ma può diminuire per altri motivi)
    return {
      cognitive: decayedCognitive,
      affective: dualState.affective,
      lastUpdate: Date.now()
    };
  }
}

module.exports = DualActivation;