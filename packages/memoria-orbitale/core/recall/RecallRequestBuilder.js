"use strict";

const RECALL_COMMANDS = Object.freeze([
  "cerca nello storico completo",
  "cerca in tutta la memoria",
  "search full history"
]);

class RecallRequestBuilderError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RecallRequestBuilderError";
    this.code = code;
  }
}

function buildRecallRequest(input = {}) {
  const allowed = new Set(["query", "limit", "includeDeep", "allowDeepFallback"]);
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !allowed.has(key))) {
    throw new RecallRequestBuilderError("INVALID_INPUT", "Recall request input is invalid");
  }
  if (typeof input.query !== "string" || input.query.trim().length === 0) {
    throw new RecallRequestBuilderError("INVALID_QUERY", "query must be non-empty");
  }
  if (!Number.isInteger(input.limit) || input.limit <= 0) {
    throw new RecallRequestBuilderError("INVALID_LIMIT", "limit must be a positive integer");
  }
  if (input.includeDeep !== undefined && typeof input.includeDeep !== "boolean") {
    throw new RecallRequestBuilderError("INVALID_INCLUDE_DEEP", "includeDeep must be boolean");
  }
  if (input.allowDeepFallback !== undefined && typeof input.allowDeepFallback !== "boolean") {
    throw new RecallRequestBuilderError("INVALID_DEEP_FALLBACK", "allowDeepFallback must be boolean");
  }

  let query = input.query;
  let commandMatched = false;
  for (const command of RECALL_COMMANDS) {
    const match = query.match(new RegExp(`^\\s*${command.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}(?:\\s*[:,-]?\\s+)(.*)$`, "i"));
    if (!match) continue;
    if (!match[1].trim()) throw new RecallRequestBuilderError("EMPTY_COMMAND_QUERY", "Deep command requires a query");
    query = match[1].trim();
    commandMatched = true;
    break;
  }

  const includeDeep = input.includeDeep === true || commandMatched;
  return Object.freeze({
    query,
    mode: commandMatched ? "full-history" : "default",
    includeDeep,
    limit: input.limit,
    deepFallback: input.allowDeepFallback === true
      ? Object.freeze({ enabled: true, minResults: input.limit, minBestScore: null })
      : Object.freeze({ enabled: false, minResults: null, minBestScore: null })
  });
}

module.exports = { RECALL_COMMANDS, RecallRequestBuilderError, buildRecallRequest };
