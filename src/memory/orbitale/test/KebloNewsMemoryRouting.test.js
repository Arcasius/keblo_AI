import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  isExplicitNewsSaveCommand,
  isMemoryRecallRequest,
  maybeShowCard
} from "../../../../cards.js";
import { analyzeConversationTurn } from "../../../../intent_memory_router.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

function analysis(text) {
  return analyzeConversationTurn({ text, lastTurns: [], previousShortMemory: null,
    userPreferences: { preferredStyle: "direct" } });
}

for (const text of [
  "di cosa abbiamo parlato della memoria orbitale?",
  "cosa ricordi del progetto Keblo?",
  "cosa ricorda l'ippocampo?"
]) {
  test(`memory request reaches recall without News card: ${text}`, () => {
    const intent = analysis(text);
    assert.equal(intent.refinedIntent.primaryIntent, "recall");
    assert.equal(intent.refinedIntent.primaryDomain, "memory");
    assert.equal(isMemoryRecallRequest(text), true);
    assert.equal(maybeShowCard(text, { activeCard: null }, intent), null);
  });
}

test("orbital prompt content cannot turn a memory question into a News command", () => {
  const userText = "di cosa abbiamo parlato della memoria orbitale?";
  const enrichedPrompt = "ORBITAL MEMORY: previous news discussion\nUSER: " + userText;
  const intent = analysis(userText);
  assert.equal(maybeShowCard(enrichedPrompt, { activeCard: null }, intent), null);
  const engine = fs.readFileSync(path.join(root, "keblo_engine.js"), "utf8");
  const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
  assert.match(engine, /maybeShowCard\(normalizedCommandText, state, intentAnalysis\)/);
  assert.match(server, /\{ text: finalInputText, commandText: rawText, images \}/);
});

test("pending News does not seize a new memory question", () => {
  const state = { activeCard: { type: "news", status: "pending" } };
  const text = "cosa ricordi del progetto Keblo?";
  assert.equal(maybeShowCard(text, state, analysis(text)), null);
  assert.equal(state.activeCard, null);
});

for (const text of ["salva questa news", "salva questa notizia", "archivia questa notizia"]) {
  test(`explicit News save command remains supported: ${text}`, () => {
    assert.equal(isExplicitNewsSaveCommand(text), true);
    assert.equal(maybeShowCard(text, { activeCard: null })?.type, "news");
  });
}

test("generic News words and memory terms are not automatic News save commands", () => {
  for (const text of ["news sul microbiota", "novità sul progetto", "aggiornami sul progetto",
    "memoria", "recall", "SuperMemory", "salva questa news in memoria"]) {
    assert.equal(maybeShowCard(text, { activeCard: null }), null, text);
  }
  assert.equal(maybeShowCard("cerca memoria RAM", { activeCard: null })?.type, "search");
});

test("yes and no preserve the existing pending News confirmation path", () => {
  for (const text of ["si", "sì", "no"]) {
    const pending = { type: "news", status: "pending" };
    const state = { activeCard: pending };
    assert.equal(maybeShowCard(text, state), null);
    assert.equal(state.activeCard, pending);
  }
});

test("frontend opens News only when backend returns a card", () => {
  const source = fs.readFileSync(path.join(root, "public/index.html"), "utf8");
  const done = source.indexOf('if (data.type === "done")');
  const block = source.slice(done, source.indexOf('if (data.type === "error")', done));
  assert.match(block, /if \(data\.card\)/);
  assert.match(block, /spawnCard\(data\.card\.type/);
  assert.doesNotMatch(block, /news|memoria orbitale/i);
});
