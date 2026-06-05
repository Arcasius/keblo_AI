function formatSectionValue(value, emptyValue = "") {
  if (value === null || value === undefined) {
    return emptyValue;
  }

  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value) && value.length === 0) {
    return emptyValue;
  }

  if (typeof value === "object" && Object.keys(value).length === 0) {
    return emptyValue;
  }

  return JSON.stringify(value, null, 2);
}

function memoryText(memory) {
  return memory?.content?.text || memory?.text || "";
}

function memoryRole(memory) {
  return memory?._role || memory?.content?.role || memory?.role || memory?.meta?.role || "unknown";
}

function memoryValidity(memory) {
  return memory?._temporalValidity || memory?.validity || "unknown";
}

function memoryTimeAgo(memory) {
  return memory?._timeAgo || "adesso";
}

function formatMemoryLine(memory) {
  return `[${memoryTimeAgo(memory)} | ${memoryRole(memory)} | ${memoryValidity(memory)}] ${memoryText(memory)}`;
}

function formatMemories(memories) {
  if (!Array.isArray(memories) || memories.length === 0) {
    return "";
  }

  return memories.map(formatMemoryLine).join("\n");
}

export function formatPromptMemoryBlock({
  temporalState = {},
  currentInputState = {},
  memories = []
} = {}) {
  return [
    "STATO TEMPORALE:",
    "- Le memorie role=user sono fonti primarie.",
    "- Le memorie role=assistant sono tracce secondarie.",
    "- Le query non sono fatti.",
    "- Le memorie superseded non vanno trattate come attuali.",
    "- Le completed chiudono stati precedenti.",
    formatSectionValue(temporalState),
    "",
    "INPUT CORRENTE:",
    formatSectionValue(currentInputState),
    "",
    "MEMORIE RICHIAMATE:",
    formatMemories(memories)
  ].join("\n");
}

export function createPromptMemoryFormatter() {
  return {
    format: formatPromptMemoryBlock
  };
}
