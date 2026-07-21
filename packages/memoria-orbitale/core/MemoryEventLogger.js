const fs = require("fs");
const path = require("path");

const EVENT_TYPES = new Set(["echoed", "promoted", "suppressed", "recall_summary"]);

function safeUserId(userId) {
  return String(userId || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "_");
}

function eventFileName(userId) {
  const safeId = safeUserId(userId);
  return safeId ? `${safeId}_memory_events.jsonl` : "_memory_events.jsonl";
}

function normalizeConcept(concept) {
  return String(concept || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9à-ÿ_-]/g, "");
}

function normalizeConcepts(concepts) {
  if (!Array.isArray(concepts)) return [];

  return [...new Set(
    concepts
      .map(normalizeConcept)
      .filter(Boolean)
  )].slice(0, 16);
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

class MemoryEventLogger {
  constructor(storageDir) {
    this.storageDir = storageDir || ".";
  }

  eventPath(userId) {
    return path.join(this.storageDir, eventFileName(userId));
  }

  appendEvent(userId, event) {
    return this.appendEvents(userId, [event]);
  }

  async appendEvents(userId, events) {
    const safeEvents = Array.isArray(events) ? events.filter(Boolean) : [];
    if (safeEvents.length === 0) return 0;

    try {
      await fs.promises.mkdir(this.storageDir, { recursive: true });
      const lines = safeEvents.map(event => JSON.stringify(this.sanitizeEvent(userId, event))).join("\n") + "\n";
      await fs.promises.appendFile(this.eventPath(userId), lines, "utf8");
      return safeEvents.length;
    } catch (err) {
      console.warn(`[memory-events] failed to append: ${err.message}`);
      return 0;
    }
  }

  sanitizeEvent(userId, event) {
    const timestamp = finiteNumber(event.timestamp) || Date.now();
    const type = EVENT_TYPES.has(event.type) ? event.type : "recall_summary";

    const sanitized = {
      timestamp,
      iso: event.iso || new Date(timestamp).toISOString(),
      userId: safeUserId(userId),
      type,
      reason: String(event.reason || "")
    };

    if (event.memoryId) sanitized.memoryId = String(event.memoryId);
    if (typeof event.promoted === "boolean") sanitized.promoted = event.promoted;

    for (const key of ["echoScore", "textScore", "tagScore", "finalScore", "avgEcho", "topEcho", "promotedAvgEcho"]) {
      const value = finiteNumber(event[key]);
      if (value !== undefined) sanitized[key] = value;
    }

    for (const key of ["candidates", "promoted"]) {
      if (Number.isInteger(event[key])) sanitized[key] = event[key];
    }

    if (Array.isArray(event.concepts)) sanitized.concepts = normalizeConcepts(event.concepts);
    if (Array.isArray(event.queryConcepts)) sanitized.queryConcepts = normalizeConcepts(event.queryConcepts);

    return sanitized;
  }
}

module.exports = {
  MemoryEventLogger,
  normalizeConcepts
};
