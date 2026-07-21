import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const source = fs.readFileSync(path.join(root, "server.js"), "utf8");
const firstRoute = source.indexOf('app.post("/api/chat", isAuthenticated');
const secondRoute = source.indexOf('app.post("/api/chat", isAuthenticated', firstRoute + 1);
const first = source.slice(firstRoute, secondRoute);
const second = source.slice(secondRoute);

test("KINT-4 hook is only in the first route and has the required pipeline position", () => {
  const shortMemory = first.indexOf("req.session.user.state.shortMemory = intentAnalysis.shortMemory");
  const recall = first.indexOf("kebloChatRecallRuntime.recallForChat");
  const world = first.indexOf("WORLD CONTEXT INJECTION");
  const inject = first.indexOf("if (orbitalMemoryContext)");
  const process = first.indexOf("const result = await processInput");
  assert.equal(firstRoute >= 0 && secondRoute > firstRoute, true);
  assert.equal(shortMemory < recall && recall < world, true);
  assert.equal(world < inject && inject < process, true);
  assert.equal(second.includes("kebloChatRecallRuntime"), false);
  assert.equal(source.split("kebloChatRecallRuntime.recallForChat").length - 1, 1);
});

test("hook takes identity from session and imports no daemon/provider/commit bridge", () => {
  assert.match(first, /session:\s*req\.session/);
  assert.doesNotMatch(first, /userId:\s*req\.(body|query|headers)/);
  assert.match(source, /kebloChatRecallConfig\.enabled\s*\?\s*createKebloChatRecallRuntime/);
  for (const forbidden of ["HippocampusDaemon", "Provider", "CommitBridge", "control-plane"]) {
    assert.equal(source.includes(`import ${forbidden}`), false);
  }
});
