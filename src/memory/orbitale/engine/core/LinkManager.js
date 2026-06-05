// src/core/LinkManager.js
class LinkManager {
  constructor(config = {}) {
    // FIX 4 - Dynamic link cap
    this.baseLinks = config.baseLinks || 3;
    this.linkMultiplier = config.linkMultiplier || 10;
    
    // FIX 5 - Link weight decay
    this.linkDecayFactor = config.linkDecayFactor || 0.95;
    this.linkMinWeight = config.linkMinWeight || 0.05;
    
    // FIX 6 - Propagation dampening
    this.propagationFactor = config.propagationFactor || 0.4;
    this.maxPropagation = config.maxPropagation || 0.3;
  }

  /**
   * FIX 4 - Calcola limite dinamico link per nodo
   */
  getMaxLinksForNode(activation) {
    return this.baseLinks + Math.floor(activation * this.linkMultiplier);
  }

  /**
   * FIX 4 - Applica cap ai link di un nodo
   */
  enforceLinkCap(nodeId, links, activation) {
    const maxLinks = this.getMaxLinksForNode(activation);
    
    if (links.length <= maxLinks) return links;
    
    // Ordina per peso e taglia i più deboli
    return links
      .sort((a, b) => b.weight - a.weight)
      .slice(0, maxLinks);
  }

  /**
   * FIX 5 - Update peso link con decay
   */
  updateLinkWeight(link, reinforcement = 0) {
    const oldWeight = link.weight;
    
    // Decay e rinforzo
    let newWeight = oldWeight * this.linkDecayFactor + reinforcement;
    newWeight = Math.max(0, Math.min(1, newWeight));
    
    const updatedLink = {
      ...link,
      weight: newWeight,
      lastInteraction: Date.now(),
      reinforcementCount: link.reinforcementCount + (reinforcement > 0 ? 1 : 0)
    };
    
    return updatedLink;
  }

  /**
   * FIX 5 - Pulisci link deboli
   */
  pruneWeakLinks(links) {
    return links.filter(l => l.weight >= this.linkMinWeight);
  }

  /**
   * FIX 6 - Calcola attivazione propagata con dampening
   */
  calculatePropagatedActivation(sourceActivation, linkWeight) {
    return sourceActivation * linkWeight * this.propagationFactor;
  }

  /**
   * FIX 6 - Applica propagazione con hard cap
   */
  applyPropagation(targetNode, sourceActivation, linkWeight) {
    const propagated = this.calculatePropagatedActivation(
      sourceActivation, 
      linkWeight
    );
    
    // Hard cap: non più del 30% dell'attivazione target
    const maxIncrease = targetNode.activation * this.maxPropagation;
    const actualIncrease = Math.min(propagated, maxIncrease);
    
    return {
      ...targetNode,
      activation: targetNode.activation + actualIncrease,
      lastPropagation: Date.now()
    };
  }

  /**
   * Manutenzione link completa
   */
  async maintainLinks(userId, storage) {
    const links = await storage.loadLinks(userId);
    const memories = await storage.loadMemories(userId);
    
    // Crea mappa per accesso rapido
    const memoryMap = new Map(memories.map(m => [m.id, m]));
    
    // 1. Prune link deboli
    const validLinks = this.pruneWeakLinks(links);
    
    // 2. Raggruppa per source
    const linksBySource = new Map();
    for (const link of validLinks) {
      if (!linksBySource.has(link.source)) {
        linksBySource.set(link.source, []);
      }
      linksBySource.get(link.source).push(link);
    }
    
    // 3. Applica link cap per ogni source
    const finalLinks = [];
    for (const [sourceId, sourceLinks] of linksBySource) {
      const sourceMem = memoryMap.get(sourceId);
      if (!sourceMem) continue;
      
      const cappedLinks = this.enforceLinkCap(
        sourceId, 
        sourceLinks, 
        sourceMem.activation
      );
      
      finalLinks.push(...cappedLinks);
    }
    
    // 4. Salva se ci sono cambiamenti
    if (finalLinks.length !== links.length) {
      await storage.saveLinks(userId, finalLinks);
    }
    
    return {
      before: links.length,
      after: finalLinks.length,
      pruned: links.length - finalLinks.length
    };
  }
}

module.exports = LinkManager;