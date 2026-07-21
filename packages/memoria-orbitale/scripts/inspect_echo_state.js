#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const EchoStateBuilder = require("../core/EchoStateBuilder");

const DEFAULT_USER_ID = "francesco";
const DEFAULT_TOP = 20;
const DEFAULT_DATA_DIR = "orbitale_chat_data";

function usage() {
  return [
    "Usage:",
    "  node scripts/inspect_echo_state.js --user-id francesco --top 20",
    "",
    "Options:",
    "  --user-id <id>   Default: francesco",
    "  --top <n>        Default: 20",
    "  --data-dir <dir> Default: orbitale_chat_data"
  ].join("\n");
}

function parseArgs(argv) {
  const args = {
    userId: DEFAULT_USER_ID,
    top: DEFAULT_TOP,
    dataDir: DEFAULT_DATA_DIR
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--user-id") {
      args.userId = argv[++i];
    } else if (arg === "--top") {
      args.top = Number(argv[++i]);
    } else if (arg === "--data-dir") {
      args.dataDir = argv[++i];
    } else if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}\n${usage()}`);
    }
  }

  if (!args.userId) {
    throw new Error(`--user-id requires a value.\n${usage()}`);
  }

  if (!Number.isInteger(args.top) || args.top < 1) {
    throw new Error(`--top must be a positive integer.\n${usage()}`);
  }

  if (!args.dataDir) {
    throw new Error(`--data-dir requires a value.\n${usage()}`);
  }

  return args;
}

function safeUserId(userId) {
  return String(userId || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "_");
}

function eventPath(dataDir, userId) {
  return path.join(dataDir, `${safeUserId(userId)}_memory_events.jsonl`);
}

function metadataOnlyNode(state) {
  return {
    memoryId: state.memoryId,
    echoEnergy: state.echoEnergy,
    promotedCount: state.promotedCount,
    latentPresence: state.latentPresence,
    concepts: state.concepts,
    echoCount: state.echoCount,
    avgEchoScore: state.avgEchoScore,
    maxEchoScore: state.maxEchoScore,
    lastEchoAt: state.lastEchoAt,
    lastPromotedAt: state.promotedCount > 0 ? state.lastPromotedAt : null,
    dormantMs: state.dormantMs
  };
}

function main() {
  const args = parseArgs(process.argv);
  const filePath = eventPath(args.dataDir, args.userId);

  if (!fs.existsSync(filePath)) {
    throw new Error(`Memory events file not found: ${filePath}`);
  }

  const states = new EchoStateBuilder()
    .buildFromFile(filePath)
    .sort((a, b) =>
      (b.echoEnergy - a.echoEnergy) ||
      (b.promotedCount - a.promotedCount) ||
      a.memoryId.localeCompare(b.memoryId)
    );

  const output = {
    userId: safeUserId(args.userId),
    source: filePath,
    totalNodes: states.length,
    top: args.top,
    nodes: states.slice(0, args.top).map(metadataOnlyNode)
  };

  console.log(JSON.stringify(output, null, 2));
}

try {
  main();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
