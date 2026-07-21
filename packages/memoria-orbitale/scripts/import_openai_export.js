#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const CONVERSATION_FILES = [
  "conversations-000.json",
  "conversations-001.json",
  "conversations-002.json",
  "conversations-003.json"
];

const MIN_TEXT_LENGTH = 8;
const LONG_MESSAGE_WARNING_LENGTH = 4000;
const CHUNK_THRESHOLD = 8000;
const CHUNK_MAX_LENGTH = 7500;
const DEFAULT_INPUT_DIR = "imports";
const DEFAULT_MODE = "current-path";
const DEFAULT_USER_ID = "francesco";
const MEMORY_DIR = "orbitale_chat_data";
const BACKUP_DIR = path.join("backups", "openai_import");

function usage() {
  return [
    "Usage:",
    "  node scripts/import_openai_export.js --dry-run --input-dir imports --mode current-path --user-id francesco",
    "  node scripts/import_openai_export.js --apply --input-dir imports --mode current-path --user-id francesco",
    "",
    "Required: exactly one of --dry-run or --apply.",
    "Options:",
    "  --input-dir <dir>          Default: imports",
    "  --mode current-path|all-nodes  Default: current-path",
    "  --user-id <id>            Default: francesco"
  ].join("\n");
}

function parseArgs(argv) {
  const args = {
    dryRun: false,
    apply: false,
    inputDir: DEFAULT_INPUT_DIR,
    mode: DEFAULT_MODE,
    userId: DEFAULT_USER_ID
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--apply") {
      args.apply = true;
    } else if (arg === "--input-dir") {
      args.inputDir = argv[++i];
    } else if (arg === "--mode") {
      args.mode = argv[++i];
    } else if (arg === "--user-id") {
      args.userId = argv[++i];
    } else if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}\n${usage()}`);
    }
  }

  if (args.dryRun && args.apply) {
    throw new Error(`--dry-run and --apply cannot be used together.\n${usage()}`);
  }

  if (!args.dryRun && !args.apply) {
    throw new Error(`Missing required mode. Use exactly one of --dry-run or --apply.\n${usage()}`);
  }

  if (!args.inputDir) {
    throw new Error(`--input-dir requires a value.\n${usage()}`);
  }

  if (!args.userId) {
    throw new Error(`--user-id requires a value.\n${usage()}`);
  }

  if (!["current-path", "all-nodes"].includes(args.mode)) {
    throw new Error(`Invalid --mode: ${args.mode}. Expected current-path or all-nodes.\n${usage()}`);
  }

  return args;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readJsonObject(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const data = readJson(filePath);
  if (Array.isArray(data)) {
    return data.reduce((acc, item) => {
      if (item && item.id) acc[item.id] = item;
      return acc;
    }, {});
  }
  if (data && typeof data === "object") return data;
  return {};
}

function stableHash(parts) {
  return crypto.createHash("sha256").update(parts.join("\u001f")).digest("hex").slice(0, 24);
}

function normalizeText(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function unixSecondsToMs(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.round(value * 1000);
}

function toIso(ms) {
  return typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : "";
}

function safeTitle(title) {
  if (typeof title !== "string") return "";
  return title.trim().slice(0, 240);
}

function isAssetOnlyPart(part) {
  if (!part || typeof part !== "object") return false;
  const type = String(part.content_type || part.type || "").toLowerCase();
  return [
    "image_asset_pointer",
    "audio_asset_pointer",
    "real_time_user_audio_video_asset_pointer",
    "file_asset_pointer"
  ].includes(type);
}

function textFromStructuredPart(part) {
  if (!part || typeof part !== "object" || isAssetOnlyPart(part)) return "";
  const type = String(part.content_type || part.type || "").toLowerCase();

  if (type === "audio_transcription") {
    return normalizeText(part.text || part.transcript || part.transcription || "");
  }

  if (typeof part.text === "string") return normalizeText(part.text);
  if (typeof part.transcript === "string") return normalizeText(part.transcript);
  if (typeof part.transcription === "string") return normalizeText(part.transcription);
  return "";
}

function extractText(content) {
  if (!content || typeof content !== "object") return "";

  const contentType = content.content_type;
  if (!["text", "multimodal_text"].includes(contentType)) return "";

  const pieces = [];
  if (typeof content.text === "string") pieces.push(content.text);

  if (Array.isArray(content.parts)) {
    for (const part of content.parts) {
      if (typeof part === "string") {
        pieces.push(part);
      } else {
        const text = textFromStructuredPart(part);
        if (text) pieces.push(text);
      }
    }
  }

  return normalizeText(pieces.filter(Boolean).join("\n"));
}

function classifyMessage(message) {
  if (!message) return { importable: false, reason: "empty" };

  const role = message.author?.role || message.role || "";
  if (!["user", "assistant"].includes(role)) {
    return { importable: false, reason: "internal" };
  }

  const contentType = message.content?.content_type || "";
  if (["thoughts", "reasoning_recap"].includes(contentType)) {
    return { importable: false, reason: "filtered" };
  }

  if (!["text", "multimodal_text"].includes(contentType)) {
    return { importable: false, reason: "filtered" };
  }

  const text = extractText(message.content);
  if (!text) return { importable: false, reason: "empty" };
  if (text.length < MIN_TEXT_LENGTH) return { importable: false, reason: "too_short" };

  return { importable: true, role, contentType, text };
}

function getConversationId(conversation, fallback) {
  return String(conversation.id || conversation.conversation_id || fallback);
}

function getMessageId(message, fallback) {
  return String(message.id || fallback);
}

function getConversationNodes(conversation, mode) {
  const mapping = conversation.mapping || {};

  if (mode === "all-nodes") {
    return Object.keys(mapping)
      .map((id) => ({ id, node: mapping[id] }))
      .filter((entry) => entry.node && entry.node.message)
      .sort((a, b) => {
        const at = a.node.message?.create_time || 0;
        const bt = b.node.message?.create_time || 0;
        if (at !== bt) return at - bt;
        return a.id.localeCompare(b.id);
      });
  }

  const reversed = [];
  const seen = new Set();
  let current = conversation.current_node;

  while (current && mapping[current] && !seen.has(current)) {
    seen.add(current);
    reversed.push({ id: current, node: mapping[current] });
    current = mapping[current].parent;
  }

  return reversed.reverse().filter((entry) => entry.node && entry.node.message);
}

function splitIntoChunks(text, maxLength = CHUNK_MAX_LENGTH) {
  const normalized = normalizeText(text);
  if (normalized.length <= CHUNK_THRESHOLD) return [normalized];

  const chunks = [];
  let remaining = normalized;

  while (remaining.length > maxLength) {
    let cut = remaining.lastIndexOf("\n\n", maxLength);
    if (cut < Math.floor(maxLength * 0.55)) cut = remaining.lastIndexOf("\n", maxLength);
    if (cut < Math.floor(maxLength * 0.55)) cut = remaining.lastIndexOf(". ", maxLength);
    if (cut < Math.floor(maxLength * 0.55)) cut = remaining.lastIndexOf(" ", maxLength);
    if (cut < Math.floor(maxLength * 0.55)) cut = maxLength;

    const chunk = normalizeText(remaining.slice(0, cut));
    if (chunk) chunks.push(chunk);
    remaining = normalizeText(remaining.slice(cut));
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

function memoryIdFor(conversationId, messageId, role, text, timestampMs, chunkIndex = null) {
  const hash = stableHash([
    conversationId,
    messageId,
    role,
    normalizeText(text).toLowerCase(),
    String(timestampMs || ""),
    chunkIndex === null ? "" : String(chunkIndex)
  ]);
  return chunkIndex === null ? `mem_openai_${hash}` : `mem_openai_chunk_${hash}`;
}

function linkIdFor(source, target, type) {
  return `lnk_openai_${stableHash([source, target, type])}`;
}

function makeMemory({ id, text, role, conversation, conversationId, messageId, timestampUnix, timestampMs, importedAtIso, mode, chunkMeta }) {
  const meta = {
    user_id: conversation.userId,
    source: "openai_export",
    conversation_id: conversationId,
    conversation_title: safeTitle(conversation.title),
    message_id: messageId,
    original_timestamp_unix: timestampUnix,
    original_timestamp_ms: timestampMs,
    original_timestamp_iso: toIso(timestampMs),
    imported_at_iso: importedAtIso,
    import_mode: mode,
    temporal_source: timestampUnix === conversation.messageTimestampUnix ? "openai_message_create_time" : "openai_conversation_create_time",
    temporal_role: "historical_memory"
  };

  if (chunkMeta) Object.assign(meta, chunkMeta);

  return {
    id,
    type: "dialogue",
    content: { text, role },
    activation: 0.25,
    orbitalState: 0.25,
    orbitalLevel: "long",
    memoryDepth: "historical",
    dualState: {
      cognitive: 0.25,
      affective: 0,
      lastUpdate: timestampMs
    },
    decay_rate: 0.005,
    tags: [
      "openai_import",
      "source_openai",
      "historical",
      "dialogue",
      `role_${role}`
    ],
    timestamp: timestampMs,
    lastAccess: timestampMs,
    accessCount: 0,
    meta
  };
}

function getTemporalGapClass(gapMs) {
  if (gapMs <= 5 * 60 * 1000) return "minutes";
  if (gapMs <= 60 * 60 * 1000) return "hour";
  if (gapMs <= 24 * 60 * 60 * 1000) return "day";
  if (gapMs <= 7 * 24 * 60 * 60 * 1000) return "week";
  if (gapMs <= 30 * 24 * 60 * 60 * 1000) return "month";
  return "long_gap";
}

function getTemporalLinkWeight(gapMs) {
  const gapClass = getTemporalGapClass(gapMs);
  return {
    minutes: 0.45,
    hour: 0.40,
    day: 0.32,
    week: 0.22,
    month: 0.14,
    long_gap: 0.08
  }[gapClass];
}

function makeLink({ source, target, type, weight, sourceTimestamp, targetTimestamp, temporalOrder, nowIso, temporalGapClass }) {
  return {
    id: linkIdFor(source, target, type),
    source,
    target,
    type,
    weight,
    created_at: nowIso,
    last_reinforced: nowIso,
    reinforcement_count: 1,
    source_timestamp: sourceTimestamp,
    target_timestamp: targetTimestamp,
    temporal_gap_ms: targetTimestamp - sourceTimestamp,
    ...(temporalGapClass ? { temporal_gap_class: temporalGapClass } : {}),
    temporal_order: temporalOrder
  };
}

function timestampFor(message, conversation) {
  const messageTime = message.create_time;
  const conversationTime = conversation.create_time;
  const timestampUnix = typeof messageTime === "number" && Number.isFinite(messageTime) ? messageTime : conversationTime;
  const timestampMs = unixSecondsToMs(timestampUnix);
  return { timestampUnix, timestampMs };
}

function updateTemporalStats(report, timestampMs) {
  if (typeof timestampMs !== "number" || !Number.isFinite(timestampMs)) return;
  if (report.oldestTimestampMs === null || timestampMs < report.oldestTimestampMs) report.oldestTimestampMs = timestampMs;
  if (report.newestTimestampMs === null || timestampMs > report.newestTimestampMs) report.newestTimestampMs = timestampMs;
}

function safeTimestampForFile(date = new Date()) {
  return date.toISOString().replace(/T/, "_").replace(/:/g, "-").replace(/\.\d{3}Z$/, "");
}

function ensureJsonSerializableAndValid(data) {
  return JSON.parse(JSON.stringify(data));
}

function writeJsonAtomic(filePath, data) {
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const json = JSON.stringify(data, null, 2);
  JSON.parse(json);
  fs.writeFileSync(tmpPath, json, "utf8");
  JSON.parse(fs.readFileSync(tmpPath, "utf8"));
  fs.renameSync(tmpPath, filePath);
}

function backupFile(sourcePath, backupPath) {
  fs.copyFileSync(sourcePath, backupPath);
  JSON.parse(fs.readFileSync(backupPath, "utf8"));
}

function printReport(report) {
  const oldest = report.oldestTimestampMs === null ? "" : toIso(report.oldestTimestampMs);
  const newest = report.newestTimestampMs === null ? "" : toIso(report.newestTimestampMs);
  const rangeDays = report.oldestTimestampMs === null || report.newestTimestampMs === null
    ? 0
    : (report.newestTimestampMs - report.oldestTimestampMs) / 86400000;

  console.log("OPENAI EXPORT IMPORT REPORT");
  console.log(`mode: ${report.mode}`);
  console.log(`input_dir: ${report.inputDir}`);
  console.log(`user_id: ${report.userId}`);
  console.log(`import_mode: ${report.importMode}`);
  console.log(`conversation_files_found: ${report.conversationFilesFound}`);
  console.log(`conversations_total: ${report.conversationsTotal}`);
  console.log(`conversations_processed: ${report.conversationsProcessed}`);
  console.log(`messages_seen: ${report.messagesSeen}`);
  console.log(`messages_on_current_path: ${report.messagesOnCurrentPath}`);
  console.log(`messages_importable: ${report.messagesImportable}`);
  console.log(`messages_created: ${report.messagesCreated}`);
  console.log(`messages_skipped_duplicate: ${report.messagesSkippedDuplicate}`);
  console.log(`messages_skipped_filtered: ${report.messagesSkippedFiltered}`);
  console.log(`messages_skipped_empty: ${report.messagesSkippedEmpty}`);
  console.log(`messages_skipped_too_short: ${report.messagesSkippedTooShort}`);
  console.log(`messages_skipped_internal: ${report.messagesSkippedInternal}`);
  console.log(`messages_chunked: ${report.messagesChunked}`);
  console.log(`chunks_created: ${report.chunksCreated}`);
  console.log(`links_created: ${report.linksCreated}`);
  console.log(`links_skipped_duplicate: ${report.linksSkippedDuplicate}`);
  console.log(`oldest_timestamp_iso: ${oldest}`);
  console.log(`newest_timestamp_iso: ${newest}`);
  console.log(`temporal_range_days: ${rangeDays.toFixed(2)}`);
  console.log(`max_temporal_gap_ms: ${report.maxTemporalGapMs}`);
  console.log(`temporal_links_by_gap: ${JSON.stringify(report.temporalLinksByGap)}`);
  console.log(`would_add_memories: ${report.mode === "dry-run" ? report.messagesCreated : 0}`);
  console.log(`would_add_links: ${report.mode === "dry-run" ? report.linksCreated : 0}`);
  if (report.backups.length) console.log(`backups: ${report.backups.join(", ")}`);
  if (report.updatedFiles.length) console.log(`updated_files: ${report.updatedFiles.join(", ")}`);
  const warningText = report.warnings.length ? report.warnings.slice(0, 20).join(" | ") + (report.warnings.length > 20 ? " | ... " + (report.warnings.length - 20) + " more warnings" : "") : "none";
  console.log(`warnings: ${warningText}`);
  console.log(`errors: ${report.errors.length ? report.errors.join(" | ") : "none"}`);
}

function main() {
  const args = parseArgs(process.argv);
  const memoryPath = path.join(MEMORY_DIR, `${args.userId}_memories.json`);
  const linksPath = path.join(MEMORY_DIR, `${args.userId}_links.json`);
  const importedAtIso = new Date().toISOString();
  const newMemories = {};
  const newLinks = {};
  const existingMemories = readJsonObject(memoryPath);
  const existingLinks = readJsonObject(linksPath);
  const knownMemoryIds = new Set(Object.keys(existingMemories));
  const knownLinkIds = new Set(Object.keys(existingLinks));
  const report = {
    mode: args.dryRun ? "dry-run" : "apply",
    inputDir: args.inputDir,
    userId: args.userId,
    importMode: args.mode,
    conversationFilesFound: 0,
    conversationsTotal: 0,
    conversationsProcessed: 0,
    messagesSeen: 0,
    messagesOnCurrentPath: 0,
    messagesImportable: 0,
    messagesCreated: 0,
    messagesSkippedDuplicate: 0,
    messagesSkippedFiltered: 0,
    messagesSkippedEmpty: 0,
    messagesSkippedTooShort: 0,
    messagesSkippedInternal: 0,
    messagesChunked: 0,
    chunksCreated: 0,
    linksCreated: 0,
    linksSkippedDuplicate: 0,
    oldestTimestampMs: null,
    newestTimestampMs: null,
    maxTemporalGapMs: 0,
    temporalLinksByGap: {
      minutes: 0,
      hour: 0,
      day: 0,
      week: 0,
      month: 0,
      long_gap: 0
    },
    warnings: [],
    errors: [],
    backups: [],
    updatedFiles: []
  };

  if (!fs.existsSync(memoryPath)) report.warnings.push(`memory file not found: ${memoryPath}`);
  if (!fs.existsSync(linksPath)) report.warnings.push(`links file not found: ${linksPath}`);

  for (const fileName of CONVERSATION_FILES) {
    const filePath = path.join(args.inputDir, fileName);
    if (!fs.existsSync(filePath)) {
      report.warnings.push(`missing conversation shard: ${filePath}`);
      continue;
    }

    report.conversationFilesFound++;
    const conversations = readJson(filePath);
    if (!Array.isArray(conversations)) {
      report.errors.push(`conversation shard is not an array: ${filePath}`);
      continue;
    }

    report.conversationsTotal += conversations.length;

    for (let conversationIndex = 0; conversationIndex < conversations.length; conversationIndex++) {
      const conversation = conversations[conversationIndex];
      const conversationId = getConversationId(conversation, `${fileName}:${conversationIndex}`);
      const entries = getConversationNodes(conversation, args.mode);
      const importedConversationMemories = [];
      let temporalOrder = 0;

      report.conversationsProcessed++;
      report.messagesSeen += Object.values(conversation.mapping || {}).filter((node) => node && node.message).length;
      if (args.mode === "current-path") report.messagesOnCurrentPath += entries.length;
      else report.messagesOnCurrentPath += getConversationNodes(conversation, "current-path").length;

      for (const entry of entries) {
        const message = entry.node.message;
        const classification = classifyMessage(message);

        if (!classification.importable) {
          if (classification.reason === "empty") report.messagesSkippedEmpty++;
          else if (classification.reason === "too_short") report.messagesSkippedTooShort++;
          else if (classification.reason === "internal") report.messagesSkippedInternal++;
          else report.messagesSkippedFiltered++;
          continue;
        }

        report.messagesImportable++;
        const { timestampUnix, timestampMs } = timestampFor(message, conversation);
        if (timestampMs === null) {
          report.messagesSkippedFiltered++;
          report.warnings.push("missing usable timestamp in one conversation");
          continue;
        }

        const role = classification.role;
        const messageId = getMessageId(message, entry.id);
        const text = classification.text;
        const chunks = splitIntoChunks(text);
        const isChunked = chunks.length > 1;

        if (text.length > LONG_MESSAGE_WARNING_LENGTH) {
          report.warnings.push(`long message detected: ${text.length} chars`);
        }
        if (isChunked) report.messagesChunked++;

        const chunkMemoryIds = [];
        for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
          const chunkText = chunks[chunkIndex];
          const id = memoryIdFor(conversationId, messageId, role, chunkText, timestampMs, isChunked ? chunkIndex : null);

          if (knownMemoryIds.has(id)) {
            report.messagesSkippedDuplicate++;
            continue;
          }

          const chunkMeta = isChunked ? {
            original_message_id: messageId,
            chunk_index: chunkIndex,
            chunk_count: chunks.length,
            is_chunk: true
          } : null;

          const memory = makeMemory({
            id,
            text: chunkText,
            role,
            conversation: {
              ...conversation,
              userId: args.userId,
              messageTimestampUnix: message.create_time
            },
            conversationId,
            messageId,
            timestampUnix,
            timestampMs,
            importedAtIso,
            mode: args.mode,
            chunkMeta
          });

          newMemories[id] = memory;
          knownMemoryIds.add(id);
          chunkMemoryIds.push(id);
          report.messagesCreated++;
          if (isChunked) report.chunksCreated++;
          updateTemporalStats(report, timestampMs);
        }

        for (let i = 1; i < chunkMemoryIds.length; i++) {
          const source = chunkMemoryIds[i - 1];
          const target = chunkMemoryIds[i];
          const link = makeLink({
            source,
            target,
            type: "continuation",
            weight: 0.45,
            sourceTimestamp: timestampMs,
            targetTimestamp: timestampMs,
            temporalOrder: i,
            nowIso: importedAtIso
          });
          if (knownLinkIds.has(link.id)) {
            report.linksSkippedDuplicate++;
          } else {
            newLinks[link.id] = link;
            knownLinkIds.add(link.id);
            report.linksCreated++;
          }
        }

        for (const id of chunkMemoryIds) {
          importedConversationMemories.push({ id, timestampMs, temporalOrder: temporalOrder++ });
        }
      }

      for (let i = 1; i < importedConversationMemories.length; i++) {
        const prev = importedConversationMemories[i - 1];
        const next = importedConversationMemories[i];
        const gap = next.timestampMs - prev.timestampMs;
        const absoluteGap = Math.abs(gap);
        const temporalGapClass = getTemporalGapClass(absoluteGap);
        if (Number.isFinite(gap)) {
          report.maxTemporalGapMs = Math.max(report.maxTemporalGapMs, absoluteGap);
          report.temporalLinksByGap[temporalGapClass]++;
        }
        const link = makeLink({
          source: prev.id,
          target: next.id,
          type: "dialogue_sequence",
          weight: getTemporalLinkWeight(absoluteGap),
          sourceTimestamp: prev.timestampMs,
          targetTimestamp: next.timestampMs,
          temporalOrder: next.temporalOrder,
          nowIso: importedAtIso,
          temporalGapClass
        });
        if (knownLinkIds.has(link.id)) {
          report.linksSkippedDuplicate++;
        } else {
          newLinks[link.id] = link;
          knownLinkIds.add(link.id);
          report.linksCreated++;
        }
      }
    }
  }

  ensureJsonSerializableAndValid(newMemories);
  ensureJsonSerializableAndValid(newLinks);

  if (args.apply) {
    const stamp = safeTimestampForFile(new Date());
    const memoryBackupPath = path.join(BACKUP_DIR, `${args.userId}_memories_${stamp}.json`);
    const linksBackupPath = path.join(BACKUP_DIR, `${args.userId}_links_${stamp}.json`);

    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    backupFile(memoryPath, memoryBackupPath);
    backupFile(linksPath, linksBackupPath);
    report.backups.push(memoryBackupPath, linksBackupPath);

    const mergedMemories = { ...existingMemories, ...newMemories };
    const mergedLinks = { ...existingLinks, ...newLinks };
    ensureJsonSerializableAndValid(mergedMemories);
    ensureJsonSerializableAndValid(mergedLinks);

    writeJsonAtomic(memoryPath, mergedMemories);
    writeJsonAtomic(linksPath, mergedLinks);
    report.updatedFiles.push(memoryPath, linksPath);
  }

  printReport(report);
}

try {
  main();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
