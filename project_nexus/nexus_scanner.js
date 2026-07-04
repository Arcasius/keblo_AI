import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import crypto from "crypto";
import { shouldIgnorePath } from "./nexus_ignore.js";

const TEXT_EXTENSIONS = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".jsx",
  ".json",
  ".html",
  ".css",
  ".scss",
  ".md",
  ".txt",
  ".env",
  ".example",
  ".yml",
  ".yaml",
  ".py",
  ".sh",
  ".sql"
]);

const IMPORT_PATTERNS = [
  /\bimport\s+(?:.+?\s+from\s+)?["']([^"']+)["']/g,
  /\brequire\(\s*["']([^"']+)["']\s*\)/g,
  /\bfrom\s+["']([^"']+)["']/g,
  /<script[^>]+src=["']([^"']+)["']/g,
  /<link[^>]+href=["']([^"']+)["']/g
];

function isInsideRoot(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function createProjectId(realRootPath) {
  const hash = crypto.createHash("sha1").update(realRootPath).digest("hex").slice(0, 12);
  const name = path.basename(realRootPath).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `${name || "project"}-${hash}`;
}

function isTextCandidate(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const name = path.basename(filePath).toLowerCase();
  return TEXT_EXTENSIONS.has(ext) || name.startsWith(".env") || name === "dockerfile";
}

async function readPreview(filePath, maxBytes) {
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

function extractImports(preview) {
  const imports = new Set();
  const lines = preview.split(/\r?\n/).slice(0, 80).join("\n");

  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(lines)) !== null) {
      if (match[1]) imports.add(match[1]);
      if (imports.size >= 40) break;
    }
  }

  return Array.from(imports);
}

function makeFolderNode(fullPath, relativePath, depth) {
  return {
    type: "folder",
    name: path.basename(fullPath),
    path: fullPath,
    relativePath: relativePath || ".",
    depth,
    children: []
  };
}

export async function scanProject(rootPath, options = {}) {
  const maxDepth = Number.isInteger(options.maxDepth) ? options.maxDepth : 6;
  const maxFiles = Number.isInteger(options.maxFiles) ? options.maxFiles : 2000;
  const maxFileSize = Number.isInteger(options.maxFileSize) ? options.maxFileSize : 512 * 1024;
  const previewBytes = Number.isInteger(options.previewBytes) ? options.previewBytes : 24 * 1024;

  const resolvedRoot = path.resolve(rootPath);
  const warnings = [];
  let realRoot;

  try {
    realRoot = await fs.realpath(resolvedRoot);
  } catch (error) {
    throw new Error(`Project root is not accessible: ${resolvedRoot} (${error.message})`);
  }

  const rootStats = await fs.lstat(realRoot);
  if (!rootStats.isDirectory()) {
    throw new Error(`Project root is not a directory: ${realRoot}`);
  }

  const projectName = path.basename(realRoot);
  const projectId = options.projectId || createProjectId(realRoot);
  const files = [];
  const folders = [];
  const stats = {
    totalFiles: 0,
    scannedFiles: 0,
    skippedFiles: 0,
    skippedLargeFiles: 0,
    skippedIgnoredPaths: 0,
    folders: 0,
    totalBytes: 0,
    maxDepthReached: 0
  };

  const tree = makeFolderNode(realRoot, ".", 0);

  async function walk(currentPath, depth, treeNode) {
    if (depth > maxDepth) {
      warnings.push(`Max depth reached at ${path.relative(realRoot, currentPath) || "."}`);
      return;
    }

    let entries;
    try {
      entries = await fs.readdir(currentPath, { withFileTypes: true });
    } catch (error) {
      warnings.push(`Cannot read directory ${path.relative(realRoot, currentPath) || "."}: ${error.message}`);
      return;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (files.length >= maxFiles) {
        warnings.push(`Max file limit reached (${maxFiles})`);
        return;
      }

      const fullPath = path.join(currentPath, entry.name);
      const resolved = path.resolve(fullPath);
      if (!isInsideRoot(realRoot, resolved)) {
        warnings.push(`Skipped path outside root: ${entry.name}`);
        continue;
      }

      const relativePath = path.relative(realRoot, resolved);
      const normalizedRelativePath = relativePath.split(path.sep).join("/");

      if (shouldIgnorePath(normalizedRelativePath) || shouldIgnorePath(resolved)) {
        stats.skippedIgnoredPaths += 1;
        continue;
      }

      let itemStats;
      try {
        itemStats = await fs.lstat(resolved);
      } catch (error) {
        warnings.push(`Cannot stat ${normalizedRelativePath}: ${error.message}`);
        continue;
      }

      if (itemStats.isSymbolicLink()) {
        stats.skippedFiles += 1;
        warnings.push(`Skipped symlink: ${normalizedRelativePath}`);
        continue;
      }

      if (itemStats.isDirectory()) {
        const folderInfo = {
          path: resolved,
          relativePath: normalizedRelativePath,
          name: entry.name,
          depth: depth + 1
        };
        folders.push(folderInfo);
        stats.folders += 1;
        stats.maxDepthReached = Math.max(stats.maxDepthReached, depth + 1);

        const childNode = makeFolderNode(resolved, normalizedRelativePath, depth + 1);
        treeNode.children.push(childNode);
        await walk(resolved, depth + 1, childNode);
        continue;
      }

      if (!itemStats.isFile()) {
        stats.skippedFiles += 1;
        continue;
      }

      stats.totalFiles += 1;
      stats.totalBytes += itemStats.size;
      stats.maxDepthReached = Math.max(stats.maxDepthReached, depth + 1);

      if (itemStats.size > maxFileSize) {
        stats.skippedLargeFiles += 1;
        treeNode.children.push({
          type: "file",
          name: entry.name,
          relativePath: normalizedRelativePath,
          depth: depth + 1,
          skipped: "maxFileSize"
        });
        continue;
      }

      let imports = [];
      if (isTextCandidate(resolved)) {
        try {
          const preview = await readPreview(resolved, Math.min(previewBytes, maxFileSize));
          imports = extractImports(preview);
        } catch (error) {
          warnings.push(`Cannot preview ${normalizedRelativePath}: ${error.message}`);
        }
      }

      const fileInfo = {
        path: resolved,
        relativePath: normalizedRelativePath,
        name: entry.name,
        extension: path.extname(entry.name).toLowerCase(),
        size: itemStats.size,
        depth: depth + 1,
        imports
      };

      files.push(fileInfo);
      stats.scannedFiles += 1;
      treeNode.children.push({
        type: "file",
        name: entry.name,
        relativePath: normalizedRelativePath,
        extension: fileInfo.extension,
        size: itemStats.size,
        depth: depth + 1
      });
    }
  }

  if (!fsSync.existsSync(realRoot)) {
    throw new Error(`Project root disappeared during scan: ${realRoot}`);
  }

  await walk(realRoot, 0, tree);

  return {
    rootPath: realRoot,
    projectName,
    projectId,
    scannedAt: new Date().toISOString(),
    tree,
    files,
    folders,
    stats,
    warnings
  };
}
