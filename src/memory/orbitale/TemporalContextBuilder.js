import fs from "fs";
import path from "path";
import vm from "vm";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import { formatPromptMemoryBlock } from "./PromptMemoryFormatter.js";

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

const { decorateMemoriesWithTime } = loadEngineModule(path.join(engineDir, "TimeAwareness.js"));
const {
  isQuestion,
  buildWorldStateFromMemories,
  formatWorldStateForPrompt
} = loadEngineModule(path.join(engineDir, "WorldStateTracker.js"));

function normalizeMemories(memories) {
  return Array.isArray(memories) ? memories : [];
}

function normalizeObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value;
}

function normalizeInput(currentInput) {
  return typeof currentInput === "string" ? currentInput : String(currentInput || "");
}

function buildCurrentInputState(currentInput, memories) {
  const text = normalizeInput(currentInput);
  const worldState = buildWorldStateFromMemories(memories, text);

  return {
    text,
    isQuestion: isQuestion(text),
    worldState,
    worldStatePrompt: formatWorldStateForPrompt(worldState)
  };
}

export function buildTemporalContext({
  memories = [],
  temporalState = {},
  currentInputState = {},
  currentInput = ""
} = {}) {
  const safeMemories = decorateMemoriesWithTime(normalizeMemories(memories));
  const safeTemporalState = normalizeObject(temporalState);
  const safeCurrentInputState = {
    ...buildCurrentInputState(currentInput, safeMemories),
    ...normalizeObject(currentInputState)
  };

  return {
    memories: safeMemories,
    currentInputState: safeCurrentInputState,
    promptBlock: formatPromptMemoryBlock({
      temporalState: safeTemporalState,
      currentInputState: safeCurrentInputState,
      memories: safeMemories
    })
  };
}

export function createTemporalContextBuilder() {
  return {
    build: buildTemporalContext
  };
}
