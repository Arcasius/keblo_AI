const { KebloMemory } = require("./Keblomemory.js");
const JsonMemoryStorage = require("./JsonMemoryStorage.js");
const { createRecallRouter } = require("./recall/RecallRouter.js");
const { createLegacyRecallAdapter } = require("./recall/LegacyRecallAdapter.js");
const { buildRecallRequest } = require("./recall/RecallRequestBuilder.js");

class OrbitaleBridge {
  constructor(config = {}) {
    this.dataDir = config.dataDir || "./keblo_data";
    this.memory = new KebloMemory({
      storage: new JsonMemoryStorage(this.dataDir)
    });
    this.recallRouter = null;
    this.recallRouterUserId = null;
  }

  async remember(userId, text, metadata = {}) {
    return this.memory.remember(userId, text, metadata);
  }

  async recall(userId, query, options = {}) {
    if (!this.recallRouter) {
      this.recallRouter = createRecallRouter(createLegacyRecallAdapter({ kebloMemory: this.memory, userId }));
      this.recallRouterUserId = userId;
      this.memory.setRecallRouter(this.recallRouter);
    } else if (this.recallRouterUserId !== userId) {
      throw new Error("OrbitaleBridge recall router is bound to a different user");
    }
    const limit = options.limit === undefined ? 10 : options.limit;
    const output = await this.recallRouter.recall(buildRecallRequest({
      query,
      limit,
      includeDeep: options.includeDeep === true,
      allowDeepFallback: options.allowDeepFallback === true
    }));
    await this.memory.reinforceRecallSelection(userId, output.reinforcementPendingIds, {
      enabled: options.reinforce !== false
    });
    return output.results.map(result => ({
      id: result.id,
      text: result.text,
      content: { text: result.text },
      memoryKind: result.memoryKind,
      storageTier: result.storageTier,
      retrievalTier: result.retrievalTier,
      _score: result.finalScore
    }));
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
