import fs from "fs/promises";
import path from "path";

const STORAGE_ROOT = path.join(process.cwd(), "storage", "users");

function sanitizeSegment(value, fallback) {
  const sanitized = String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return sanitized || fallback;
}

function nexusRoot(userId) {
  return path.join(STORAGE_ROOT, sanitizeSegment(userId, "unknown_user"), "nexus");
}

function projectRoot(userId, projectId) {
  return path.join(nexusRoot(userId), sanitizeSegment(projectId, "unknown_project"));
}

function indexPath(userId) {
  return path.join(nexusRoot(userId), "project_index.json");
}

async function readJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function snapshotBase(snapshot) {
  const analysis = snapshot.analysis || snapshot;
  return {
    projectId: analysis.projectId || snapshot.projectId,
    projectName: analysis.projectName || snapshot.projectName,
    rootPath: analysis.rootPath || snapshot.rootPath
  };
}

export async function saveSnapshot(userId, snapshot) {
  const base = snapshotBase(snapshot);
  const projectId = sanitizeSegment(base.projectId, "unknown_project");
  const projectName = base.projectName || projectId;
  const now = new Date().toISOString();
  const timestamp = now.replace(/[:.]/g, "-");
  const snapshotId = `snapshot_${timestamp}`;
  const dir = projectRoot(userId, projectId);
  const snapshotFile = path.join(dir, `${snapshotId}.json`);
  const latestFile = path.join(dir, "latest.json");

  const payload = {
    snapshotId,
    savedAt: now,
    ...snapshot,
    projectId,
    projectName,
    rootPath: base.rootPath
  };

  await writeJson(snapshotFile, payload);
  await writeJson(latestFile, payload);

  const indexFile = indexPath(userId);
  const index = await readJson(indexFile, { projects: [] });
  const projects = Array.isArray(index.projects) ? index.projects : [];
  const existingIndex = projects.findIndex((project) => project.projectId === projectId);
  const indexEntry = {
    projectId,
    projectName,
    rootPath: base.rootPath,
    lastAuditAt: now,
    latestSnapshot: snapshotId
  };

  if (existingIndex >= 0) {
    projects[existingIndex] = indexEntry;
  } else {
    projects.push(indexEntry);
  }

  projects.sort((a, b) => String(a.projectName).localeCompare(String(b.projectName)));
  await writeJson(indexFile, { projects });

  return {
    snapshotId,
    snapshotPath: snapshotFile,
    latestPath: latestFile,
    projectId
  };
}

export async function listProjects(userId) {
  const index = await readJson(indexPath(userId), { projects: [] });
  return Array.isArray(index.projects) ? index.projects : [];
}

export async function listSnapshots(userId, projectId) {
  const dir = projectRoot(userId, projectId);
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && /^snapshot_.*\.json$/.test(entry.name))
      .map((entry) => ({
        snapshotId: entry.name.replace(/\.json$/, ""),
        path: path.join(dir, entry.name)
      }))
      .sort((a, b) => b.snapshotId.localeCompare(a.snapshotId));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

export async function loadSnapshot(userId, projectId, snapshotId) {
  const safeSnapshotId = sanitizeSegment(snapshotId, "latest");
  const fileName = safeSnapshotId === "latest" ? "latest.json" : `${safeSnapshotId}.json`;
  return readJson(path.join(projectRoot(userId, projectId), fileName), null);
}
