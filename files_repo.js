import fs from "fs";
import path from "path";

const FILES_BASE = path.join(process.cwd(), "storage", "users");

export function checkFileLimits(userId, newFileSize) {
  const userDir = path.join(FILES_BASE, userId, "files");
  if (!fs.existsSync(userDir)) return { ok: true };

  const files = fs.readdirSync(userDir);
  if (files.length >= 5) return { ok: false, msg: "Hai raggiunto il limite di 5 file." };

  let totalSize = 0;
  files.forEach(f => totalSize += fs.statSync(path.join(userDir, f)).size);
  
  if ((totalSize + newFileSize) > 5 * 1024 * 1024) {
    return { ok: false, msg: "Limite di 5MB totali superato." };
  }
  return { ok: true };
}

// Funzione per spezzare il testo in pezzi (chunking) per il Reranker
export function chunkText(text, size = 600) {
  const chunks = [];
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.substring(i, i + size));
  }
  return chunks;
}