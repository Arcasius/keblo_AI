import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

import { projectKebloLegacyFlatMemoryToWarm } from "./KebloLegacyFlatWarmProjection.js";

const require = createRequire(import.meta.url);
const { detectMemoryContract, normalizeMemory } = require("../../../packages/memoria-orbitale");

const READER_SCHEMA_VERSION = 1;
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;
const USER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const TIERS = new Set(["core", "warm"]);

export class KebloOrbitaleReadOnlyStorageReaderError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "KebloOrbitaleReadOnlyStorageReaderError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new KebloOrbitaleReadOnlyStorageReaderError(code, message);
}

function validateUserId(userId) {
  if (typeof userId !== "string" || !USER_ID.test(userId)) {
    fail("INVALID_USER_ID", "userId is invalid");
  }
  return userId;
}

function validateBaseDir(baseDir) {
  if (typeof baseDir !== "string" || baseDir.length === 0 || baseDir.includes("\0") ||
      !path.isAbsolute(baseDir) || path.normalize(baseDir) !== baseDir) {
    fail("INVALID_BASE_DIR", "baseDir must be an absolute normalized path");
  }
  return baseDir;
}

function validateOptions(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    fail("INVALID_OPTIONS", "reader options must be an object");
  }
  const allowed = new Set(["userId", "baseDir", "rankReadOnly", "maxBytes"]);
  if (Object.keys(options).some((key) => !allowed.has(key))) {
    fail("INVALID_OPTIONS", "reader options contain unsupported properties");
  }
  const maxBytes = options.maxBytes === undefined ? DEFAULT_MAX_BYTES : options.maxBytes;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    fail("INVALID_MAX_BYTES", "maxBytes must be a positive safe integer");
  }
  if (typeof options.rankReadOnly !== "function") {
    fail("MISSING_RANKER", "rankReadOnly is required");
  }
  return {
    userId: validateUserId(options.userId),
    baseDir: validateBaseDir(options.baseDir),
    rankReadOnly: options.rankReadOnly,
    maxBytes
  };
}

function validateRequest(request, boundUserId) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    fail("INVALID_SEARCH_REQUEST", "search request must be an object");
  }
  const allowed = new Set(["schemaVersion", "userId", "query", "tier", "limit", "mutate"]);
  if (Object.keys(request).some((key) => !allowed.has(key)) || request.schemaVersion !== READER_SCHEMA_VERSION) {
    fail("INVALID_SEARCH_REQUEST", "search request is invalid");
  }
  if (request.mutate !== false) fail("MUTATION_FORBIDDEN", "search requires mutate false");
  if (validateUserId(request.userId) !== boundUserId) {
    fail("USER_SCOPE_VIOLATION", "reader cannot cross its bound user scope");
  }
  if (typeof request.query !== "string" || request.query.trim().length === 0 ||
      !TIERS.has(request.tier) || !Number.isInteger(request.limit) || request.limit <= 0) {
    fail("INVALID_SEARCH_REQUEST", "search request is invalid");
  }
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)]));
  }
  return value;
}

function deepFreeze(value) {
  Object.freeze(value);
  for (const child of Object.values(value)) {
    if (child && typeof child === "object" && !Object.isFrozen(child)) deepFreeze(child);
  }
  return value;
}

function memoriesFromDocument(document) {
  if (Array.isArray(document)) return document;
  if (document && typeof document === "object" && Object.getPrototypeOf(document) === Object.prototype) {
    return Object.values(document);
  }
  fail("INVALID_STORAGE_SHAPE", "orbital memory storage has an invalid shape");
}

function explicitRecordUserId(memory) {
  const values = [memory.userId, memory.user_id, memory.meta?.user_id]
    .filter((value) => value !== undefined && value !== null);
  if (values.length === 0) return null;
  if (values.some((value) => typeof value !== "string") || new Set(values).size !== 1) return false;
  return values[0];
}

function validForTier(memory, tier, boundUserId) {
  try {
    if (!memory || typeof memory !== "object" || Array.isArray(memory)) return false;
    const recordUserId = explicitRecordUserId(memory);
    if (recordUserId === false || recordUserId !== null && recordUserId !== boundUserId) return false;
    if (detectMemoryContract(memory) === "unknown") return false;
    const normalized = normalizeMemory(memory);
    if (typeof normalized.id !== "string" || normalized.id.trim().length === 0 ||
        typeof normalized.content.text !== "string" || normalized.content.text.length === 0) return false;
    if (tier === "warm") {
      return normalized.memoryKind === "raw" && normalized.storageTier === "warm";
    }
    return normalized.memoryKind === "super_memory" && normalized.storageTier === "core" &&
      normalized.processingState === "consolidated" && Array.isArray(memory.source_memory_ids) &&
      memory.source_memory_ids.every((id) => typeof id === "string" && id.length > 0) &&
      new Set(memory.source_memory_ids).size === memory.source_memory_ids.length;
  } catch {
    return false;
  }
}

function validUserScope(memory, boundUserId) {
  if (!memory || typeof memory !== "object" || Array.isArray(memory)) return false;
  const recordUserId = explicitRecordUserId(memory);
  return recordUserId !== false && (recordUserId === null || recordUserId === boundUserId);
}

async function readDocument(filePath, maxBytes) {
  let handle;
  try {
    handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile()) fail("INVALID_STORAGE_FILE", "orbital memory storage is not a regular file");
    if (stat.size > maxBytes) fail("STORAGE_TOO_LARGE", "orbital memory storage exceeds maxBytes");
    const buffer = await handle.readFile();
    if (buffer.byteLength > maxBytes) fail("STORAGE_TOO_LARGE", "orbital memory storage exceeds maxBytes");
    try {
      return JSON.parse(buffer.toString("utf8"));
    } catch {
      fail("INVALID_STORAGE_JSON", "orbital memory storage contains invalid JSON");
    }
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error instanceof KebloOrbitaleReadOnlyStorageReaderError) throw error;
    fail("STORAGE_READ_FAILED", "orbital memory storage could not be read");
  } finally {
    await handle?.close().catch(() => {});
  }
}

function normalizeRanking(ranked, byId, limit) {
  if (!Array.isArray(ranked)) fail("INVALID_RANKER_RESULT", "rankReadOnly returned an invalid result");
  const seen = new Set();
  const entries = [];
  for (const item of ranked) {
    if (!item || typeof item !== "object" || Array.isArray(item) ||
        Object.keys(item).some((key) => !["id", "score"].includes(key)) ||
        typeof item.id !== "string" || typeof item.score !== "number" ||
        !Number.isFinite(item.score) || item.score < 0 || item.score > 1 || !byId.has(item.id)) {
      fail("INVALID_RANKER_RESULT", "rankReadOnly returned an invalid result");
    }
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    entries.push({ memory: clone(byId.get(item.id)), score: item.score });
  }
  return entries.slice(0, limit);
}

export function createKebloOrbitaleReadOnlyStorageReader(options = {}) {
  const { userId, baseDir, rankReadOnly, maxBytes } = validateOptions(options);
  const filePath = path.join(baseDir, `${userId}_memories.json`);
  if (path.dirname(filePath) !== baseDir) fail("INVALID_STORAGE_PATH", "orbital memory storage path is invalid");
  const metrics = { projectedFlatWarmCount: 0, rejectedFlatWarmCount: 0 };

  return Object.freeze({
    schemaVersion: READER_SCHEMA_VERSION,
    userId,
    getMetrics() {
      return Object.freeze({ ...metrics });
    },
    async searchReadOnly(request) {
      validateRequest(request, userId);
      const document = await readDocument(filePath, maxBytes);
      if (document === null) return [];
      const memories = [];
      for (const memory of memoriesFromDocument(document)) {
        if (validForTier(memory, request.tier, userId)) {
          memories.push(memory);
          continue;
        }
        if (request.tier !== "warm" || !validUserScope(memory, userId)) continue;
        const projection = projectKebloLegacyFlatMemoryToWarm(memory, {
          detectMemoryContract,
          normalizeMemory
        });
        if (projection.status === "projected" && validForTier(projection.memory, "warm", userId)) {
          metrics.projectedFlatWarmCount += 1;
          memories.push(projection.memory);
        } else {
          metrics.rejectedFlatWarmCount += 1;
        }
      }
      const byId = new Map();
      for (const memory of memories) if (!byId.has(memory.id)) byId.set(memory.id, memory);
      const immutableMemories = deepFreeze([...byId.values()].map(clone));
      let ranked;
      try {
        ranked = await rankReadOnly(Object.freeze({
          schemaVersion: READER_SCHEMA_VERSION,
          userId,
          query: request.query,
          tier: request.tier,
          limit: request.limit,
          memories: immutableMemories
        }));
      } catch (error) {
        if (error instanceof KebloOrbitaleReadOnlyStorageReaderError) throw error;
        fail("RANKING_FAILED", "rankReadOnly failed");
      }
      return normalizeRanking(ranked, byId, request.limit);
    }
  });
}
