"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const packageRoot = path.resolve(__dirname, "..");
const entrypoint = path.join(packageRoot, "index.js");
const manifestPath = path.join(packageRoot, "package.json");
const expectedExports = [
  "CAPABILITY_STATUS",
  "DEFAULT_RECALL_POLICY",
  "LEGACY_RECALL_ADAPTER_SCHEMA_VERSION",
  "LegacyRecallAdapterError",
  "RECALL_COMMANDS",
  "RECALL_MODES",
  "RECALL_REASON_CODES",
  "RECALL_ROUTER_SCHEMA_VERSION",
  "RECALL_TIERS",
  "RecallRequestBuilderError",
  "RecallRouterError",
  "STORAGE_CAPABILITIES",
  "StorageCapabilityError",
  "assertStorageCapabilities",
  "buildRecallRequest",
  "createLegacyRecallAdapter",
  "createRecallRouter",
  "detectMemoryContract",
  "getMissingStorageCapabilities",
  "hasStorageCapability",
  "inspectStorageCapabilities",
  "normalizeMemory",
  "projectMemoryForCandidateSelection",
  "rankReadOnly",
  "validateCapabilityDeclaration"
];

test("manifest closes the CommonJS package boundary", () => {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.name, "@keblo/memoria-orbitale");
  assert.equal(manifest.private, true);
  assert.equal(manifest.type, "commonjs");
  assert.equal(manifest.main, "index.js");
  assert.deepEqual(manifest.exports, { ".": "./index.js" });
  assert.equal(manifest.engines.node, ">=18.20.8");
  assert.deepEqual(manifest.scripts, { test: "node --test test/package-boundary.test.js" });
  assert.equal(Object.hasOwn(manifest, "dependencies"), false);
  assert.equal(Object.hasOwn(manifest, "devDependencies"), false);
});

test("plain import is lazy and has no observable runtime side effects", () => {
  const probe = String.raw`
    const fs = require("node:fs");
    const http = require("node:http");
    const https = require("node:https");
    const net = require("node:net");
    const Module = require("node:module");
    const entrypoint = process.argv[1];
    const packageRoot = process.argv[2];
    const calls = [];
    const block = (name) => function () { calls.push(name); throw new Error(name); };
    const originalReadFileSync = fs.readFileSync;
    fs.readFileSync = function (file, ...args) {
      if (file === entrypoint) return originalReadFileSync.call(this, file, ...args);
      return block("fs.readFileSync")(file, ...args);
    };
    fs.readFile = block("fs.readFile");
    fs.writeFileSync = block("fs.writeFileSync");
    fs.writeFile = block("fs.writeFile");
    fs.mkdirSync = block("fs.mkdirSync");
    fs.mkdir = block("fs.mkdir");
    net.connect = block("net.connect");
    net.createConnection = block("net.createConnection");
    net.Socket.prototype.connect = block("socket.connect");
    http.request = block("http.request");
    http.get = block("http.get");
    https.request = block("https.request");
    https.get = block("https.get");
    global.setTimeout = block("setTimeout");
    global.setInterval = block("setInterval");
    global.setImmediate = block("setImmediate");
    process.on = block("process.on");
    const api = Module.createRequire(packageRoot + "/package-boundary-probe.cjs")(entrypoint);
    const loaded = Object.keys(require.cache).filter((file) => file.startsWith(packageRoot));
    if (calls.length) throw new Error("side effects: " + calls.join(", "));
    if (loaded.length !== 1 || loaded[0] !== entrypoint) throw new Error("eager modules: " + loaded.join(", "));
    if (Object.keys(api).length !== ${expectedExports.length}) throw new Error("unexpected public API");
  `;
  execFileSync(process.execPath, ["-e", probe, entrypoint, packageRoot], { stdio: "pipe" });
});

test("entrypoint exposes exactly the explicit allowlist with expected types", () => {
  const api = require(entrypoint);
  assert.deepEqual(Object.keys(api).sort(), expectedExports);

  for (const name of [
    "RecallRouterError", "RecallRequestBuilderError", "LegacyRecallAdapterError",
    "StorageCapabilityError", "createRecallRouter", "buildRecallRequest",
    "createLegacyRecallAdapter", "detectMemoryContract", "normalizeMemory",
    "projectMemoryForCandidateSelection", "inspectStorageCapabilities",
    "hasStorageCapability", "assertStorageCapabilities",
    "getMissingStorageCapabilities", "validateCapabilityDeclaration", "rankReadOnly"
  ]) assert.equal(typeof api[name], "function", name);

  for (const name of [
    "RECALL_MODES", "RECALL_TIERS", "RECALL_REASON_CODES", "DEFAULT_RECALL_POLICY",
    "RECALL_COMMANDS", "STORAGE_CAPABILITIES", "CAPABILITY_STATUS"
  ]) assert.equal(typeof api[name], "object", name);

  assert.equal(typeof api.RECALL_ROUTER_SCHEMA_VERSION, "number");
  assert.equal(typeof api.LEGACY_RECALL_ADAPTER_SCHEMA_VERSION, "number");
  assert.equal(Object.isExtensible(api), false);
});

test("loading every public export never imports scripts", () => {
  const api = require(entrypoint);
  for (const name of expectedExports) void api[name];
  const packageModules = Object.keys(require.cache).filter((file) => file.startsWith(packageRoot));
  assert.equal(packageModules.some((file) => file.includes(`${path.sep}scripts${path.sep}`)), false);
});

test("Keblo ESM can consume the CommonJS entrypoint through createRequire", () => {
  const source = `
    import { createRequire } from "node:module";
    const api = createRequire(import.meta.url)(process.argv[1]);
    if (typeof api.createRecallRouter !== "function") process.exit(2);
    if (typeof api.buildRecallRequest !== "function") process.exit(3);
  `;
  execFileSync(process.execPath, ["--input-type=module", "-e", source, entrypoint], {
    cwd: packageRoot,
    stdio: "pipe"
  });
});

test("package directory is dynamically importable from ESM", async () => {
  const namespace = await import(pathToFileURL(entrypoint).href);
  assert.equal(typeof namespace.default.createRecallRouter, "function");
  assert.deepEqual(Object.keys(namespace.default).sort(), expectedExports);
});
