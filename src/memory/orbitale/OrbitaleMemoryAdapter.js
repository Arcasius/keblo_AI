import fs from "fs";
import path from "path";
import vm from "vm";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import { buildTemporalContext } from "./TemporalContextBuilder.js";

const DEFAULT_MEMORY_PATH = "./orbitale_memory_data";
const nativeRequire = createRequire(import.meta.url);
const engineDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "engine/core");
const cjsCache = new Map();

function loadEngineModule(modulePath) {
  const resolvedPath = modulePath.endsWith(".js") ? modulePath : `${modulePath}.js`;
  if (cjsCache.has(resolvedPath)) return cjsCache.get(resolvedPath).exports;

  const module = { exports: {} };
  cjsCache.set(resolvedPath, module);

  const localRequire = request => {
    if (request.startsWith(".")) {
      return loadEngineModule(path.resolve(path.dirname(resolvedPath), request));
    }

    return nativeRequire(request);
  };
  const source = fs.readFileSync(resolvedPath, "utf8");
  const wrapped = `(function(require, module, exports, __filename, __dirname) {\n${source}\n})`;
  const compiled = vm.runInThisContext(wrapped, { filename: resolvedPath });
  compiled(localRequire, module, module.exports, resolvedPath, path.dirname(resolvedPath));

  return module.exports;
}

const { KebloMemory } = loadEngineModule(path.join(engineDir, "Keblomemory.js"));
const JsonMemoryStorage = loadEngineModule(path.join(engineDir, "JsonMemoryStorage.js"));
const { extractMemorySignals } = loadEngineModule(path.join(engineDir, "MemorySignalExtractor.js"));

function parseEnabled(value) {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value !== "string") {
    return false;
  }

  return value.trim().toLowerCase() === "true";
}

function createEmptyContext() {
  return {
    memories: [],
    currentInputState: {},
    promptBlock: ""
  };
}

function createNoopSaveResult({ enabled, memoryPath, role, userId, text }) {
  return {
    ok: true,
    enabled,
    skipped: !enabled,
    role,
    userId,
    memoryPath,
    textLength: typeof text === "string" ? text.length : 0
  };
}

function normalizeUserId(userId) {
  return userId || "keblo_user";
}

function normalizeText(text) {
  return typeof text === "string" ? text : String(text || "");
}

function createMemoryOptions(text, role) {
  const signals = extractMemorySignals(text);
  const tags = Array.from(new Set([...(signals.tags || []), role]));

  return {
    type: signals.isTrivial ? "working" : "episodic",
    importance: signals.importance,
    tags,
    memoryDepth: signals.memoryDepth
  };
}

const STRONG_TAGS = new Set([
  "health",
  "project",
  "technical",
  "learning",
  "routine",
  "memory",
  "memory_architecture",
  "orbital_memory"
]);

const WEAK_TAGS = new Set([
  "user",
  "assistant",
  "temporary",
  "tone_positive",
  "tone_negative",
  "tone_urgent",
  "tone_uncertain",
  "emotion",
  "entity_ciao",
  "entity_buonasera",
  "entity_capisco",
  "entity_spero",
  "entity_ottimo"
]);

const GENERIC_ENTITY_WORDS = new Set([
  "ciao",
  "salve",
  "buongiorno",
  "buonasera",
  "buonanotte",
  "grazie",
  "prego",
  "ok",
  "okay",
  "perfetto",
  "ottimo",
  "capisco",
  "spero",
  "bene",
  "buono",
  "buona"
]);

const TEXT_STOPWORDS = new Set([
  "a", "ad", "al", "allo", "alla", "ai", "agli", "alle", "anche", "che",
  "chi", "ci", "con", "cosa", "da", "dal", "dallo", "dalla", "dei", "degli",
  "delle", "di", "del", "dello", "della", "e", "ed", "era", "ero", "essere",
  "fa", "fare", "gli", "ha", "hai", "hanno", "ho", "il", "in", "io", "la",
  "le", "lo", "loro", "ma", "mi", "mia", "mio", "nei", "nel", "nella", "noi",
  "non", "o", "per", "pero", "però", "piu", "più", "puo", "può", "quale",
  "quando", "questo", "questa", "questi", "queste", "se", "sei", "si", "sono",
  "su", "sul", "sulla", "ti", "tra", "tu", "un", "una", "uno", "va", "voi"
]);

function normalizeLinkText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function tagEntityValue(tag) {
  return tag.startsWith("entity_") ? tag.slice("entity_".length) : "";
}

function isGenericEntityTag(tag) {
  const entity = tagEntityValue(tag);
  if (!entity) return false;

  return entity
    .split("_")
    .filter(Boolean)
    .every(token => GENERIC_ENTITY_WORDS.has(token));
}

function isStrongTag(tag) {
  if (!tag || WEAK_TAGS.has(tag)) return false;
  if (tag.startsWith("entity_")) return !isGenericEntityTag(tag);
  return STRONG_TAGS.has(tag);
}

function getStrongTags(tags = []) {
  return new Set((Array.isArray(tags) ? tags : []).filter(isStrongTag));
}

function getStrongEntityTags(tags = []) {
  return new Set([...getStrongTags(tags)].filter(tag => tag.startsWith("entity_")));
}

function intersectSets(left, right) {
  return [...left].filter(value => right.has(value));
}

function tokenizeForSimilarity(text) {
  return normalizeLinkText(text)
    .split(/[^a-z0-9]+/)
    .filter(token => token.length >= 3 && !TEXT_STOPWORDS.has(token) && !GENERIC_ENTITY_WORDS.has(token));
}

function jaccardSimilarity(leftText, rightText) {
  const left = new Set(tokenizeForSimilarity(leftText));
  const right = new Set(tokenizeForSimilarity(rightText));
  if (left.size === 0 || right.size === 0) return 0;

  const intersection = intersectSets(left, right).length;
  const union = new Set([...left, ...right]).size;
  return union === 0 ? 0 : intersection / union;
}

function shouldUseLongTextThreshold(leftText, rightText) {
  return Math.max(tokenizeForSimilarity(leftText).length, tokenizeForSimilarity(rightText).length) >= 12;
}

export function createOrbitaleMemoryAdapter(options = {}) {
  const enabled = parseEnabled(
    options.enabled ?? process.env.ORBITALE_MEMORY_ENABLED
  );
  const memoryPath =
    options.memoryPath ?? process.env.ORBITALE_MEMORY_PATH ?? DEFAULT_MEMORY_PATH;
  let engine = null;

  function getEngine() {
    if (!enabled) {
      return null;
    }

    if (!engine) {
      const storage = new JsonMemoryStorage(memoryPath);
      engine = new KebloMemory({ storage });
    }

    return engine;
  }

  async function findRelatedMemoryIds(userId, text, role, memoryOptions) {
    try {
      const currentStrongTags = getStrongTags(memoryOptions?.tags || []);
      const currentEntityTags = getStrongEntityTags(memoryOptions?.tags || []);
      const isTemporary = memoryOptions?.type === "working" || memoryOptions?.memoryDepth === "temporary";
      const memories = await getEngine().storage.loadMemories(userId);
      const related = [];

      for (const memory of memories) {
        if (!memory?.id) continue;

        const candidateText = typeof memory.content?.text === "string" ? memory.content.text : "";
        const candidateStrongTags = getStrongTags(memory.tags || []);
        const candidateEntityTags = getStrongEntityTags(memory.tags || []);
        const sharedEntities = intersectSets(currentEntityTags, candidateEntityTags);
        const sharedStrongTags = intersectSets(currentStrongTags, candidateStrongTags);
        const hasStrongEntity = sharedEntities.length > 0;
        const candidateTemporary = memory.type === "working" || memory.memoryDepth === "temporary";

        if ((isTemporary || candidateTemporary) && !hasStrongEntity) {
          continue;
        }

        const similarity = jaccardSimilarity(text, candidateText);
        const similarityThreshold = shouldUseLongTextThreshold(text, candidateText) ? 0.18 : 0.25;
        const hasStrongTags = sharedStrongTags.length >= 2;
        const hasTextSimilarity = similarity >= similarityThreshold;

        if (!hasStrongEntity && !hasStrongTags && !hasTextSimilarity) {
          continue;
        }

        related.push({
          id: memory.id,
          score: (hasStrongEntity ? 3 : 0) + (hasStrongTags ? 2 : 0) + similarity,
          timestamp: Number(memory.timestamp || 0)
        });
      }

      const ids = related
        .sort((left, right) => right.score - left.score || right.timestamp - left.timestamp)
        .slice(0, 3)
        .map(item => item.id);

      if (ids.length > 0) {
        console.log("[orbitale-link] related count=" + ids.length + " ids=" + ids.join(","));
      } else {
        console.log("[orbitale-link] skipped no_related");
      }

      return ids;
    } catch (err) {
      console.error("[orbitale-link] error " + (err?.message || err));
      return [];
    }
  }

  async function saveByRole(userId, text, role) {
    if (!enabled) {
      return createNoopSaveResult({
        enabled,
        memoryPath,
        role,
        userId,
        text
      });
    }

    const safeUserId = normalizeUserId(userId);
    const safeText = normalizeText(text);
    const engine = getEngine();
    const memoryOptions = createMemoryOptions(safeText, role);
    const relatedIds = await findRelatedMemoryIds(safeUserId, safeText, role, memoryOptions);
    if (relatedIds.length > 0) {
      memoryOptions.linkedTo = relatedIds;
    }

    const memory = await engine.remember(
      safeUserId,
      {
        text: safeText,
        role
      },
      memoryOptions
    );

    return {
      ok: true,
      enabled,
      skipped: false,
      role,
      userId: safeUserId,
      memory
    };
  }

  return {
    enabled,
    memoryPath,

    async recall(userId, userInput) {
      if (!enabled) {
        return [];
      }

      return getEngine().recall(normalizeUserId(userId), normalizeText(userInput), {
        limit: options.recallLimit || 10
      });
    },

    async buildContext(userId, userInput) {
      if (!enabled) {
        return createEmptyContext();
      }

      const memories = await this.recall(userId, userInput);

      return buildTemporalContext({
        memories,
        currentInput: normalizeText(userInput)
      });
    },

    async saveUser(userId, text) {
      return saveByRole(userId, text, "user");
    },

    async saveAssistant(userId, text) {
      return saveByRole(userId, text, "assistant");
    }
  };
}
