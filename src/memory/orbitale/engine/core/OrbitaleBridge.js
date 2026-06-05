const { KebloMemory } = require("./Keblomemory.js");
const JsonMemoryStorage = require("./JsonMemoryStorage.js");

class OrbitaleBridge {
  constructor(config = {}) {
    this.dataDir = config.dataDir || "./keblo_data";
    this.memory = new KebloMemory({
      storage: new JsonMemoryStorage(this.dataDir)
    });
  }

  async remember(userId, text, metadata = {}) {
    return this.memory.remember(userId, text, metadata);
  }

  async recall(userId, query, options = {}) {
    return this.memory.recall(userId, query, options);
  }

  async getContext(userId, query, options = {}) {
    const limit = options.limit || 5;
    const results = await this.recall(userId, query, { ...options, limit });

    if (results.length === 0) {
      return "Memoria orbitale rilevante: nessuna.";
    }

    const lines = results.slice(0, limit).map((memory, index) => {
      const text = memory.content?.text || "";
      const score = typeof memory._score === "number" ? memory._score.toFixed(3) : "0.000";
      const linkBoost = typeof memory._linkBoost === "number" ? memory._linkBoost.toFixed(3) : "0.000";

      return [
        `${index + 1}. ${text}`,
        `   depth: ${memory.memoryDepth || "unknown"}`,
        `   orbit: ${memory.orbitalLevel || "unknown"}`,
        `   score: ${score}`,
        `   linkBoost: ${linkBoost}`
      ].join("\n");
    });

    return ["Memoria orbitale rilevante:", ...lines].join("\n");
  }

  async getStats(userId) {
    return this.memory.getStats(userId);
  }
}

module.exports = OrbitaleBridge;
