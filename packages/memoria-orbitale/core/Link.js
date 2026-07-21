// src/core/Link.js
const { randomUUID: uuidv4 } = require('crypto');

const LINK_TYPES = Object.freeze([
  'dialogue_sequence',
  'continuation',
  'semantic',
  'causal',
  'affective',
  'temporal',
  'project',
  'family',
  'clinical'
]);

const LEGACY_LINK_TYPES = Object.freeze([
  'episodic'
]);

const KNOWN_LINK_TYPES = new Set([...LINK_TYPES, ...LEGACY_LINK_TYPES]);

function normalizeLinkType(type) {
  if (typeof type === 'string' && type.trim()) return type;
  return 'semantic';
}

class CognitiveLink {
  constructor(data, userId) {
    this.id = data.id || `lnk_${uuidv4()}`;
    this.source = data.source;
    this.target = data.target;
    this.weight = data.weight || 0.5;
    this.type = normalizeLinkType(data.type);
    this.created_at = data.created_at || new Date().toISOString();
    this.last_reinforced = data.last_reinforced || new Date().toISOString();
    this.reinforcement_count = data.reinforcement_count || 1;
    
    this.meta = {
      user_id: userId,
      bidirectional: data.meta?.bidirectional !== false
    };
  }

  toJSON() {
    return {
      id: this.id,
      source: this.source,
      target: this.target,
      weight: this.weight,
      type: this.type,
      created_at: this.created_at,
      last_reinforced: this.last_reinforced,
      reinforcement_count: this.reinforcement_count,
      meta: this.meta
    };
  }

  reinforce(boost = 0.1) {
    this.weight = Math.min(1.0, this.weight + boost);
    this.reinforcement_count++;
    this.last_reinforced = new Date().toISOString();
  }

  decay(timeFactor = 1.0) {
    // I link si indeboliscono se non rinforzati
    const decayAmount = 0.01 * timeFactor;
    this.weight = Math.max(0.1, this.weight - decayAmount);
  }

  static merge(linkA, linkB) {
    // Merge di link duplicati
    return new CognitiveLink({
      source: linkA.source,
      target: linkA.target,
      weight: (linkA.weight + linkB.weight) / 2,
      type: linkA.type,
      created_at: linkA.created_at < linkB.created_at ? linkA.created_at : linkB.created_at,
      reinforcement_count: linkA.reinforcement_count + linkB.reinforcement_count,
      meta: { bidirectional: linkA.meta.bidirectional && linkB.meta.bidirectional }
    }, linkA.meta.user_id);
  }

  static get TYPES() {
    return LINK_TYPES;
  }

  static isKnownType(type) {
    return KNOWN_LINK_TYPES.has(type);
  }

  static normalizeType(type) {
    return normalizeLinkType(type);
  }
}

module.exports = CognitiveLink;
