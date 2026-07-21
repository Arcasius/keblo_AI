import path from "node:path";
import { performance } from "node:perf_hooks";
import { createRequire } from "node:module";

import { createKebloUserRecallAdapter } from "./KebloReadOnlyRecallAdapter.js";
import { createKebloOrbitaleReadOnlyStorageReader } from "./KebloOrbitaleReadOnlyStorageReader.js";
import { createKebloBoundedRecallFormatter } from "./KebloBoundedRecallFormatter.js";

const require = createRequire(import.meta.url);
const { rankReadOnly } = require("../../../packages/memoria-orbitale");

const USER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const DEEP_COMMANDS = [
  "cerca nello storico completo",
  "cerca in tutta la memoria",
  "search full history"
];

function validPositive(value, fallback, label) {
  const selected = value === undefined ? fallback : value;
  if (!Number.isInteger(selected) || selected <= 0) throw new TypeError(`${label} is invalid`);
  return selected;
}

function normalizeAllowedUserIds(value) {
  const values = value instanceof Set ? [...value] : value;
  if (!Array.isArray(values) || values.some((id) => typeof id !== "string" || !USER_ID.test(id))) {
    throw new TypeError("allowedUserIds is invalid");
  }
  return new Set(values);
}

function validateBaseDir(baseDir) {
  if (typeof baseDir !== "string" || !path.isAbsolute(baseDir) || path.normalize(baseDir) !== baseDir) {
    throw new TypeError("baseDir is invalid");
  }
  return baseDir;
}

function metric(overrides = {}) {
  return Object.freeze({ enabled: false, bypassed: true, reasonCode: "DISABLED", coreCount: 0,
    warmCount: 0, totalCount: 0, truncated: false, durationMs: 0, ...overrides });
}

function commandQuery(rawText) {
  for (const command of DEEP_COMMANDS) {
    const match = rawText.match(new RegExp(`^\\s*${command}(?:\\s*[:,-]?\\s+)(.*)$`, "i"));
    if (match?.[1]?.trim()) return match[1].trim();
  }
  return null;
}

function sanitizedFailure(error) {
  return typeof error?.code === "string" && /^[A-Z0-9_]+$/.test(error.code)
    ? error.code : "RECALL_FAILED";
}

export function parseKebloChatRecallEnvironment(env = {}) {
  const enabled = env.KEBLO_ORBITAL_RECALL_ENABLED === "true";
  if (!enabled) return Object.freeze({ enabled: false, allowedUserIds: Object.freeze([]),
    baseDir: null, maxItems: 6, maxContextChars: 4000 });
  const allowedUserIds = String(env.KEBLO_ORBITAL_RECALL_USER_IDS || "").split(",")
    .map((value) => value.trim()).filter(Boolean);
  if (allowedUserIds.length === 0) throw new TypeError("orbital recall allowlist is required");
  return Object.freeze({
    enabled: true,
    allowedUserIds: Object.freeze(allowedUserIds),
    baseDir: validateBaseDir(env.KEBLO_ORBITAL_MEMORY_DATA_DIR),
    maxItems: 6,
    maxContextChars: 4000
  });
}

export function createKebloChatRecallRuntime({
  enabled = false,
  allowedUserIds = [],
  baseDir = null,
  maxItems = 6,
  maxContextChars = 4000
} = {}) {
  if (typeof enabled !== "boolean") throw new TypeError("enabled is invalid");
  const itemLimit = validPositive(maxItems, 6, "maxItems");
  const contextLimit = validPositive(maxContextChars, 4000, "maxContextChars");
  if (!enabled) {
    return Object.freeze({
      enabled: false,
      async recallForChat() {
        return Object.freeze({ context: "", metrics: metric(), provenance: Object.freeze([]) });
      }
    });
  }
  const allowlist = normalizeAllowedUserIds(allowedUserIds);
  if (allowlist.size === 0) throw new TypeError("allowedUserIds is required when enabled");
  const dataDir = validateBaseDir(baseDir);
  const formatter = createKebloBoundedRecallFormatter({ maxItems: itemLimit, maxContextChars: contextLimit });

  return Object.freeze({
    enabled: true,
    async recallForChat({ session, rawText, primaryIntent, memoryCanAssist } = {}) {
      const started = performance.now();
      const sessionUserId = session?.user?.id;
      if (typeof sessionUserId !== "string" || !USER_ID.test(sessionUserId)) {
        return Object.freeze({ context: "", metrics: metric({ enabled: true,
          reasonCode: "INVALID_SESSION_USER", durationMs: performance.now() - started }),
          provenance: Object.freeze([]) });
      }
      if (!allowlist.has(sessionUserId)) {
        return Object.freeze({ context: "", metrics: metric({ enabled: true,
          reasonCode: "USER_NOT_ALLOWED", durationMs: performance.now() - started }),
          provenance: Object.freeze([]) });
      }
      const explicitQuery = typeof rawText === "string" ? commandQuery(rawText) : null;
      if (typeof rawText !== "string" || rawText.trim().length === 0 ||
          primaryIntent !== "recall" && memoryCanAssist !== true && explicitQuery === null) {
        return Object.freeze({ context: "", metrics: metric({ enabled: true,
          reasonCode: "NOT_MEMORY_RELEVANT", durationMs: performance.now() - started }),
          provenance: Object.freeze([]) });
      }

      try {
        const storageReader = createKebloOrbitaleReadOnlyStorageReader({
          userId: sessionUserId,
          baseDir: dataDir,
          rankReadOnly
        });
        const adapter = createKebloUserRecallAdapter({ userId: sessionUserId, storageReader });
        const output = await adapter.recall({ query: explicitQuery || rawText, limit: itemLimit });
        const formatted = formatter.format(output.results);
        return Object.freeze({
          context: formatted.context,
          metrics: metric({ enabled: true, bypassed: false,
            reasonCode: formatted.totalCount === 0 ? "EMPTY" : "RECALLED",
            coreCount: formatted.coreCount, warmCount: formatted.warmCount,
            totalCount: formatted.totalCount, truncated: formatted.truncated,
            durationMs: performance.now() - started }),
          provenance: formatted.injectedItems
        });
      } catch (error) {
        const reasonCode = sanitizedFailure(error);
        return Object.freeze({ context: "", metrics: metric({ enabled: true,
          reasonCode,
          durationMs: performance.now() - started }), provenance: Object.freeze([]) });
      }
    }
  });
}
