const fs = require("fs");
const { normalizeConcepts } = require("./MemoryEventLogger");

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isoFromTimestamp(timestamp) {
  return finiteNumber(timestamp) !== undefined ? new Date(timestamp).toISOString() : null;
}

function createAccumulator(memoryId) {
  return {
    memoryId,
    echoCount: 0,
    promotedCount: 0,
    suppressedCount: 0,
    lastEchoTimestamp: 0,
    lastPromotedTimestamp: 0,
    echoScoreSum: 0,
    echoScoreCount: 0,
    maxEchoScore: 0,
    echoEnergy: 0,
    concepts: new Set()
  };
}

function finalizeAccumulator(accumulator, nowMs) {
  const avgEchoScore = accumulator.echoScoreCount > 0
    ? accumulator.echoScoreSum / accumulator.echoScoreCount
    : 0;
  const lastEchoAt = isoFromTimestamp(accumulator.lastEchoTimestamp);
  const lastPromotedAt = isoFromTimestamp(accumulator.lastPromotedTimestamp);
  const dormantMs = accumulator.lastEchoTimestamp > 0
    ? Math.max(0, nowMs - accumulator.lastEchoTimestamp)
    : null;

  return {
    memoryId: accumulator.memoryId,
    echoCount: accumulator.echoCount,
    promotedCount: accumulator.promotedCount,
    suppressedCount: accumulator.suppressedCount,
    lastEchoAt,
    lastPromotedAt,
    avgEchoScore,
    maxEchoScore: accumulator.maxEchoScore,
    echoEnergy: accumulator.echoEnergy,
    latentPresence: accumulator.echoCount > 0 && accumulator.promotedCount === 0,
    dormantMs,
    concepts: [...accumulator.concepts].sort()
  };
}

class EchoStateBuilder {
  constructor(options = {}) {
    this.nowMs = finiteNumber(options.nowMs);
  }

  buildFromFile(filePath) {
    return this.buildFromJsonl(fs.readFileSync(filePath, "utf8"));
  }

  buildFromJsonl(jsonl) {
    const events = String(jsonl || "")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line, index) => {
        try {
          return JSON.parse(line);
        } catch (err) {
          throw new Error(`Invalid JSONL event at line ${index + 1}: ${err.message}`);
        }
      });

    return this.buildFromEvents(events);
  }

  buildFromEvents(events) {
    const states = new Map();
    const safeEvents = Array.isArray(events) ? events : [];
    const observedNow = safeEvents.reduce((max, event) => {
      const timestamp = finiteNumber(event && event.timestamp);
      return timestamp === undefined ? max : Math.max(max, timestamp);
    }, 0);
    const nowMs = this.nowMs || observedNow || Date.now();

    for (const event of safeEvents) {
      if (!event || !event.memoryId) continue;

      const memoryId = String(event.memoryId);
      const accumulator = states.get(memoryId) || createAccumulator(memoryId);
      const timestamp = finiteNumber(event.timestamp);
      const echoScore = finiteNumber(event.echoScore);

      accumulator.echoCount += 1;
      if (timestamp !== undefined) {
        accumulator.lastEchoTimestamp = Math.max(accumulator.lastEchoTimestamp, timestamp);
      }

      if (event.promoted === true || event.type === "promoted") {
        accumulator.promotedCount += 1;
        if (timestamp !== undefined) {
          accumulator.lastPromotedTimestamp = Math.max(accumulator.lastPromotedTimestamp, timestamp);
        }
      }

      if (event.type === "suppressed") {
        accumulator.suppressedCount += 1;
      }

      if (echoScore !== undefined) {
        accumulator.echoScoreSum += echoScore;
        accumulator.echoScoreCount += 1;
        accumulator.maxEchoScore = Math.max(accumulator.maxEchoScore, echoScore);
        accumulator.echoEnergy += echoScore;
      }

      for (const concept of normalizeConcepts(event.concepts)) {
        accumulator.concepts.add(concept);
      }

      states.set(memoryId, accumulator);
    }

    return [...states.values()]
      .map(accumulator => finalizeAccumulator(accumulator, nowMs))
      .sort((a, b) => a.memoryId.localeCompare(b.memoryId));
  }
}

module.exports = EchoStateBuilder;
