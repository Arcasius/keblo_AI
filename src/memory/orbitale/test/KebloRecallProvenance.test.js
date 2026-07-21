import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createKebloRecallProvenanceStore } from "../KebloRecallProvenanceStore.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

function item(tier = "warm", rank = 1, excerpt = "bounded synthetic memory") {
  return { tier, rank, score: 0.876, matchedBy: "WARM_SELECTED",
    timestamp: "2026-01-02T03:04:05.000Z", excerpt, injected: true,
    ...(tier === "core" ? { sourceCount: 2 } : {}) };
}

test("provenance is isolated across sessions and users", () => {
  const store = createKebloRecallProvenanceStore();
  store.replace("session-a", "alice", { metrics: { durationMs: 4, truncated: false }, items: [item()] });
  assert.equal(store.read("session-a", "alice").lastRecall.selectedCount, 1);
  assert.equal(store.read("session-b", "alice").lastRecall, null);
  assert.equal(store.read("session-a", "bob").lastRecall, null);
  const serialized = JSON.stringify(store.read("session-a", "alice"));
  assert.doesNotMatch(serialized, /session-a|alice|userId|sessionID|internalId/);
});

test("trace replacement and TTL retain only the latest injected recall", () => {
  let clock = Date.parse("2026-01-01T00:00:00.000Z");
  const store = createKebloRecallProvenanceStore({ ttlMs: 1000, now: () => clock });
  store.replace("session", "alice", { metrics: { durationMs: 1, truncated: true },
    items: [item("warm", 1, "first")] });
  store.replace("session", "alice", { metrics: { durationMs: 2, truncated: false },
    items: [item("core", 1, "latest")] });
  const current = store.read("session", "alice");
  assert.equal(current.lastRecall.items.length, 1);
  assert.equal(current.lastRecall.items[0].excerpt, "latest");
  assert.equal(current.lastRecall.items[0].tier, "core");
  clock += 1000;
  assert.deepEqual(store.read("session", "alice"), { lastRecall: null, expiresAt: null });
});

test("store accepts only bounded injected provenance and has no persistence APIs", () => {
  const store = createKebloRecallProvenanceStore();
  assert.throws(() => store.replace("session", "alice", { metrics: {}, items: [] }));
  assert.throws(() => store.replace("session", "alice", { metrics: {},
    items: [item("warm", 1, "x".repeat(281))] }));
  const source = fs.readFileSync(path.join(root,
    "src/memory/orbitale/KebloRecallProvenanceStore.js"), "utf8");
  for (const forbidden of ["node:fs", "writeFile", "appendFile", "localStorage", "sessionStorage"]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});

test("authenticated endpoint uses server session identity and never accepts client userId", () => {
  const source = fs.readFileSync(path.join(root, "server.js"), "utf8");
  const start = source.indexOf('app.get("/api/orbitale/last-recall"');
  const end = source.indexOf('app.get("/api/orbitale/status"', start);
  const endpoint = source.slice(start, end);
  assert.equal(start >= 0 && end > start, true);
  assert.match(endpoint, /isAuthenticated/);
  assert.match(endpoint, /Cache-Control", "no-store"/);
  assert.match(endpoint, /req\.sessionID/);
  assert.match(endpoint, /req\.session\.user\.id/);
  assert.match(endpoint, /CLIENT_USER_ID_FORBIDDEN/);
  assert.doesNotMatch(endpoint, /req\.(body|params)\.userId/);
  for (const forbidden of ["sessionID:", "userId:", "memoryPath", "processingState"]) {
    assert.equal(endpoint.includes(forbidden), false, forbidden);
  }
});

test("chat hook clears stale provenance and stores only formatter-injected items", () => {
  const source = fs.readFileSync(path.join(root, "server.js"), "utf8");
  const routeStart = source.indexOf('app.post("/api/chat", isAuthenticated');
  const routeEnd = source.indexOf('app.post("/api/chat", isAuthenticated', routeStart + 1);
  const route = source.slice(routeStart, routeEnd);
  const clear = route.indexOf("kebloRecallTraceStore.clear(req.sessionID, userId)");
  const recall = route.indexOf("kebloChatRecallRuntime.recallForChat");
  const inject = route.indexOf("finalInputText = `${orbitalMemoryContext}");
  const replace = route.indexOf("kebloRecallTraceStore.replace(req.sessionID, userId");
  const process = route.indexOf("const result = await processInput");
  assert.equal(clear >= 0 && clear < recall, true);
  assert.equal(inject < replace && replace < process, true);
  assert.match(route, /items:\s*orbitalRecall\.provenance/);
  assert.match(route, /provenance\.length > 0/);
});

test("frontend exposes IPPOCAMPO provenance and refreshes it after chat completion", () => {
  const source = fs.readFileSync(path.join(root, "public/index.html"), "utf8");
  for (const expected of ["Ippocampo", "RECALL ONLINE", "RECALL OFF", "READ ONLY", "DAEMON OFF",
    "CORE SUPERMEMORY", "WARM RAW", "INJECTED INTO PROMPT",
    "Nessun recall eseguito in questa sessione", "/api/orbitale/last-recall"]) {
    assert.equal(source.includes(expected), true, expected);
  }
  const done = source.indexOf('if (data.type === "done")');
  assert.equal(source.indexOf("refreshOrbitaleRecallPanels();", done) > done, true);
  const rendererStart = source.indexOf("function renderOrbitaleRecallPanel");
  const rendererEnd = source.indexOf("function setOrbitaleMemoryTab", rendererStart);
  assert.doesNotMatch(source.slice(rendererStart, rendererEnd), /console\./);
});
