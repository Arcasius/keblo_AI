"use strict";

const { normalizeMemory } = require("../MemoryContractNormalizer.js");
const { classifyMemoryTier } = require("./MemoryTierClassifier.js");

const RECALL_STOPWORDS = new Set([
  "ti", "mi", "ci", "si", "lo", "la", "il", "gli", "le", "un", "una", "uno",
  "di", "del", "della", "dello", "delle", "dei", "da", "dal", "alla", "alle",
  "a", "e", "o", "che", "cosa", "come", "quando", "quanto", "quale",
  "abbiamo", "avevamo", "parlato", "detto", "dicevi", "ricordi", "ricordiamo",
  "continuiamo", "continuare", "continue", "remember", "talked", "about", "when", "what"
]);

const STRONG_CONCEPT_ALIASES = Object.freeze({
  mco: ["mco", "memoria orbitale", "memoria latente", "orbite", "orbitale", "eco",
    "risonanza", "contesto cosciente", "potenziale di contesto", "short", "medium",
    "long", "tempo", "link"],
  "memoria orbitale": ["mco", "memoria orbitale", "memoria latente", "orbite", "eco",
    "risonanza", "contesto cosciente"],
  keblo: ["keblo", "memoria orbitale", "mco", "aiden", "memoria latente"],
  eco: ["eco", "risonanza", "latenza", "memoria latente", "presenza"],
  risonanza: ["risonanza", "eco", "memoria latente", "contesto cosciente"],
  marco: ["marco"], aso: ["aso"], elena: ["elena"], "anna rita": ["anna rita"]
});

const WARM_CONCEPT_AREAS = Object.freeze({
  mco: ["mco", "memoria orbitale", "eco", "risonanza", "aso"],
  "memoria orbitale": ["mco", "memoria orbitale", "eco", "risonanza"],
  eco: ["mco", "memoria orbitale", "eco", "risonanza"],
  risonanza: ["mco", "memoria orbitale", "eco", "risonanza"],
  keblo: ["keblo", "mco", "memoria orbitale", "eco", "risonanza"],
  marco: ["marco"], aso: ["aso", "mco", "memoria orbitale"],
  elena: ["elena"], "anna rita": ["anna rita"]
});

const WARM_CONCEPTS = [...new Set(Object.values(WARM_CONCEPT_AREAS).flat())];
const GENERIC_ASSISTANT_PATTERNS = ["sono qui per aiutarti", "come posso aiutarti",
  "hai bisogno di", "fammi sapere", "posso aiutarti", "vuoi approfondire", "se hai domande"];
const TAG_CONCEPT_HINTS = new Set(["keblo", "mco", "memoria", "orbitale", "progetto",
  "project", "technical", "aiden", "marco", "aso"]);
const NOISY_PREFILTER_CONCEPTS = new Set(["short", "medium", "long", "link", "tempo", "aiden"]);

class OrbitalReadOnlyRankerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "OrbitalReadOnlyRankerError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new OrbitalReadOnlyRankerError(code, message);
}

function plain(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeForRecall(value) {
  return String(value || "").normalize("NFC").trim().toLowerCase()
    .replace(/[“”]/g, "\"").replace(/[‘’]/g, "'").replace(/\s+/g, " ");
}

function conceptSearchText(value) {
  return ` ${normalizeForRecall(value).replace(/[^a-zà-ÿ0-9]+/g, " ")} `;
}

function includesConceptInSearch(searchText, concept) {
  const value = normalizeForRecall(concept).replace(/[^a-zà-ÿ0-9]+/g, " ").trim();
  return Boolean(value) && searchText.includes(` ${value} `);
}

function recallTokens(query) {
  const aliases = new Set(Object.keys(STRONG_CONCEPT_ALIASES));
  return normalizeForRecall(query).split(/\W+/).filter(Boolean)
    .filter((token) => aliases.has(token) || token.length > 2 && !RECALL_STOPWORDS.has(token));
}

function expandedConcepts(query) {
  const normalized = normalizeForRecall(query);
  const concepts = new Set();
  for (const [trigger, aliases] of Object.entries(STRONG_CONCEPT_ALIASES)) {
    if (includesConceptInSearch(conceptSearchText(normalized), trigger)) {
      aliases.forEach((alias) => concepts.add(normalizeForRecall(alias)));
    }
  }
  const expanded = [...concepts];
  for (const token of recallTokens(query)) {
    if (!expanded.some((concept) => concept.includes(" ") && concept.split(/\s+/).includes(token))) {
      concepts.add(token);
    }
  }
  return [...concepts];
}

function textMatchTokens(tokens, text) {
  if (tokens.length === 0 || !text) return 0;
  return tokens.filter((token) => text.includes(token)).length / tokens.length;
}

function hasConceptSignal(text, tags, concepts) {
  for (const concept of concepts) {
    if (NOISY_PREFILTER_CONCEPTS.has(concept)) continue;
    if (concept === "eco") {
      if (/(^|[^a-zà-ÿ0-9])eco([^a-zà-ÿ0-9]|$)/i.test(text) ||
          /(^|[^a-zà-ÿ0-9])eco([^a-zà-ÿ0-9]|$)/i.test(tags)) return true;
    } else if (text.includes(concept) || tags.includes(concept)) return true;
  }
  return false;
}

function selectWarmConceptCandidates(candidates, concepts) {
  const area = new Set();
  for (const concept of concepts) (WARM_CONCEPT_AREAS[concept] || []).forEach((item) => area.add(item));
  if (candidates.length === 0 || area.size === 0) return candidates;
  const selected = candidates.filter(({ memory }) => {
    const text = memory.content?.text || "";
    const tags = Array.isArray(memory.tags) ? memory.tags.join(" ").replace(/_/g, " ") : "";
    const search = conceptSearchText(`${text} ${tags}`);
    return [...area].some((concept) => includesConceptInSearch(search, concept));
  });
  return selected.length === 0 ? candidates : selected;
}

function tagConceptMatch(tags, concepts) {
  if (tags.length === 0 || concepts.length === 0) return 0;
  const search = conceptSearchText(tags.join(" ").replace(/_/g, " "));
  const matches = concepts.filter((concept) => includesConceptInSearch(search, concept)).length;
  const hints = tags.filter((tag) => TAG_CONCEPT_HINTS.has(normalizeForRecall(tag).replace(/^entity_/, ""))).length;
  return Math.min(1, matches / concepts.length + hints * 0.08);
}

function genericPenalty(memory, text) {
  const tags = memory.tags;
  const assistant = tags.includes("assistant") || memory.role === "assistant";
  const temporary = assistant && (tags.includes("temporary") || memory.memoryDepth === "temporary");
  const hits = GENERIC_ASSISTANT_PATTERNS.filter((pattern) => text.includes(pattern)).length;
  return Math.min(0.35, hits * 0.08 + (assistant && hits > 0 ? 0.05 : 0) + (temporary ? 0.18 : 0));
}

function duplicateQueryPenalty(query, text, concepts) {
  const normalizedQuery = normalizeForRecall(query).replace(/[?!.,;:]+$/g, "");
  const normalizedText = normalizeForRecall(text).replace(/[?!.,;:]+$/g, "");
  if (!normalizedQuery || !normalizedText) return 0;
  const search = conceptSearchText(normalizedText);
  const strong = concepts.filter((concept) => includesConceptInSearch(search, concept)).length;
  const meta = /\b(ti ricordi|abbiamo parlato|avevamo parlato|remember|talked about)\b/i.test(normalizedText);
  if (normalizedText === normalizedQuery) return strong <= 1 ? 0.35 : 0.15;
  if (normalizedText.length <= normalizedQuery.length + 30 && normalizedText.includes(normalizedQuery)) {
    return strong <= 1 ? 0.25 : 0.1;
  }
  if (meta && strong <= 1 && normalizedText.length < 140) return 0.18;
  return 0;
}

function echoResonanceScore(query, memory, concepts, text) {
  if (!text) return 0;
  const search = conceptSearchText(text);
  const matched = concepts.filter((concept) => includesConceptInSearch(search, concept));
  const acronym = includesConceptInSearch(search, "mco") && concepts.includes("mco") ? 0.28 : 0;
  const phrases = ["memoria orbitale", "memoria latente", "contesto cosciente", "potenziale di contesto"]
    .filter((phrase) => concepts.includes(phrase) && includesConceptInSearch(search, phrase)).length * 0.12;
  const coverage = concepts.length ? matched.length / concepts.length : 0;
  const density = Math.min(0.25, matched.length / Math.max(8, text.split(/\s+/).length) * 4);
  const tagScore = tagConceptMatch(memory.tags, concepts);
  return Math.max(0, Math.min(1, acronym + phrases + coverage * 0.35 + density + tagScore * 0.2 -
    genericPenalty(memory, text) - duplicateQueryPenalty(query, text, concepts)));
}

function candidate(memory, tier) {
  try {
    if (!plain(memory) || classifyMemoryTier(memory).tier !== tier) return null;
    const normalized = normalizeMemory(memory);
    if (typeof normalized.id !== "string" || normalized.id.trim().length === 0 ||
        typeof normalized.content.text !== "string" || normalized.content.text.length === 0) return null;
    const activation = normalized.orbital.activation === null ? 0 : normalized.orbital.activation;
    if (typeof activation !== "number" || !Number.isFinite(activation) || activation < 0 || activation > 1) return null;
    if (normalized.tags !== null && (!Array.isArray(normalized.tags) ||
        normalized.tags.some((tag) => typeof tag !== "string"))) return null;
    return { memory, normalized, activation, tags: normalized.tags || [] };
  } catch {
    return null;
  }
}

function validate(input) {
  const keys = ["schemaVersion", "userId", "query", "tier", "limit", "memories"];
  if (!plain(input) || Object.keys(input).some((key) => !keys.includes(key)) ||
      Object.keys(input).length !== keys.length || input.schemaVersion !== 1 ||
      typeof input.userId !== "string" || input.userId.trim().length === 0 ||
      !["core", "warm"].includes(input.tier) || !Number.isInteger(input.limit) || input.limit <= 0 ||
      !Array.isArray(input.memories)) fail("INVALID_RANK_REQUEST", "rank request is invalid");
  if (typeof input.query !== "string" || input.query.trim().length === 0) return false;
  return true;
}

function rankReadOnly(input) {
  if (!validate(input)) return Object.freeze([]);
  const concepts = expandedConcepts(input.query);
  const tokens = recallTokens(input.query);
  const candidates = input.memories.map((memory) => candidate(memory, input.tier)).filter(Boolean);
  const selected = selectWarmConceptCandidates(candidates, concepts);
  const results = selected.map(({ memory, normalized, activation, tags }) => {
    const text = normalizeForRecall(normalized.content.text);
    const normalizedTags = normalizeForRecall(tags.join(" "));
    const textScore = textMatchTokens(tokens, text);
    const tagScore = textMatchTokens(tokens, normalizedTags);
    const echo = concepts.length > 0 && hasConceptSignal(text, normalizedTags, concepts)
      ? echoResonanceScore(input.query, { ...memory, tags }, concepts, text)
      : 0;
    const relevance = Math.max(textScore, tagScore * 0.7);
    const baseScore = relevance * 0.6 + activation * 0.4;
    const score = Math.max(0, Math.min(0.9, baseScore * 0.65 + echo * 0.25));
    return Object.freeze({ id: normalized.id, score });
  });
  results.sort((left, right) => right.score - left.score || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  return Object.freeze(results);
}

module.exports = { rankReadOnly };
