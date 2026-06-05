// src/core/MemoryNode.js
const { randomUUID: uuidv4 } = require('crypto');

class MemoryNode {
  constructor(data, userId) {
    this.id = data.id || `mem_${uuidv4()}`;
    this.type = data.type || 'observation';
    this.content = {
      text: data.content?.text || '',
      entities: data.content?.entities || [],
      context_tags: data.content?.context_tags || []
    };
    
    this.orbital = {
      level: data.orbital?.level || 'medium',
      activation_score: data.orbital?.activation_score || 0.3,
      decay_rate: data.orbital?.decay_rate || 0.05,
      last_access: data.orbital?.last_access || new Date().toISOString(),
      access_count: data.orbital?.access_count || 0,
      birth: data.orbital?.birth || new Date().toISOString()
    };
    
    this.cluster = {
      id: data.cluster?.id || null,
      density: data.cluster?.density || 0,
      centroid_ref: data.cluster?.centroid_ref || null
    };
    
    this.embedding_ref = data.embedding_ref || null;
    
    this.links_summary = {
      incoming_count: data.links_summary?.incoming_count || 0,
      outgoing_count: data.links_summary?.outgoing_count || 0,
      total_weight: data.links_summary?.total_weight || 0
    };
    
    this.meta = {
      user_id: userId,
      session_id: data.meta?.session_id || `sess_${Date.now()}`,
      timestamp: new Date().toISOString(),
      version: data.meta?.version || 1
    };
  }

  toJSON() {
    return {
      id: this.id,
      type: this.type,
      content: this.content,
      orbital: this.orbital,
      cluster: this.cluster,
      embedding_ref: this.embedding_ref,
      links_summary: this.links_summary,
      meta: this.meta
    };
  }

  updateAccess() {
    const now = new Date().toISOString();
    const lastAccess = new Date(this.orbital.last_access);
    const daysDiff = (new Date(now) - lastAccess) / 86400000;
    
    // Decay naturale
    this.orbital.activation_score *= (1 - this.orbital.decay_rate * daysDiff);
    if (this.orbital.activation_score < 0.01) {
      this.orbital.activation_score = 0.01;
    }
    
    // Boost da accesso
    const boost = 0.15 * (1 + Math.log(this.links_summary.total_weight + 1));
    this.orbital.activation_score = Math.min(1.0, this.orbital.activation_score + boost);
    
    this.orbital.last_access = now;
    this.orbital.access_count++;
    
    // Ricalcola livello orbitale
    this.recalculateOrbitalLevel();
  }

  recalculateOrbitalLevel() {
    const thresholds = {
      short_to_medium: 0.3,
      medium_to_short: 0.7,
      medium_to_long: 0.15,
      long_to_medium: 0.4
    };

    if (this.orbital.activation_score < thresholds.medium_to_long) {
      this.orbital.level = 'long';
    } else if (this.orbital.activation_score < thresholds.short_to_medium) {
      this.orbital.level = 'medium';
    } else {
      this.orbital.level = 'short';
    }
  }

  isCold() {
    const age = (new Date() - new Date(this.orbital.birth)) / 86400000;
    return age > 90 && this.orbital.activation_score < 0.05;
  }
}

module.exports = MemoryNode;