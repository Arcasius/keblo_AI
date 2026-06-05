// reminders_repo.js
import fs from "fs";
import path from "path";
const RERANKER_URL = process.env.RERANKER_URL || "http://localhost:8000/v1/rerank";
const RERANKER_API_KEY = process.env.API_KEY; // La tua chiave segreta

const BASE = path.join(process.cwd(), "storage", "users");

function userDir(userId) {
  return path.join(BASE, userId);
}

function filePath(userId) {
  return path.join(userDir(userId), "reminders.json");
}

function ensureUser(userId) {
  const dir = userDir(userId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const file = filePath(userId);
  if (!fs.existsSync(file)) fs.writeFileSync(file, "[]");
}

function readAll(userId) {
  ensureUser(userId);
  return JSON.parse(fs.readFileSync(filePath(userId), "utf-8"));
}

function writeAll(userId, data) {
  const file = filePath(userId);
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

export function addReminder(userId, reminder) {
  const list = readAll(userId);
  list.push(reminder);
  writeAll(userId, list);
  return reminder;
}

export function getReminders(userId) {
  return readAll(userId);
}

export function updateReminder(userId, id, patch) {
  const list = readAll(userId);
  const idx = list.findIndex(r => r.id === id);
  if (idx === -1) return null;
  list[idx] = { ...list[idx], ...patch };
  writeAll(userId, list);
  return list[idx];
}
// In fondo a reminders_repo.js
import { rerankNews } from "./news_pipeline.js";

// reminders_repo.js
export async function searchEvents(userId, query) {
  const allEvents = getReminders(userId);
  if (allEvents.length === 0) return [];

  // Puliamo la query da parole inutili
  const cleanQuery = query.replace(/cerca|trova|fammi|vedere|un|il|per/gi, "").trim();

  const documents = allEvents.map((e, i) => {
    const d = new Date(e.dueAt);
    const dateStr = d.toLocaleString("it-IT", { day: 'numeric', month: 'long' });
    const weekday = d.toLocaleString("it-IT", { weekday: 'long' });
    
    return {
      id: e.id,
      originalText: e.text,
      date: `${dateStr} (${weekday})`,
      // Testo ultra-pulito per il Reranker
      text: `${e.text} - ${dateStr} ${weekday}`
    };
  });

  try {
    const res = await fetch(RERANKER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": RERANKER_API_KEY },
      body: JSON.stringify({ query: cleanQuery, documents, top_k: 10 })
    });

    const data = await res.json();

    // 🕵️‍♂️ TESTER LOG: Vediamo cosa risponde l'IA nel terminale
    console.log(`\n--- DEBUG SCORES PER: "${cleanQuery}" ---`);
    data.results.forEach(r => {
        const doc = documents.find(d => d.id === r.id);
        console.log(`[Score: ${r.score.toFixed(3)}] -> ${doc.text}`);
    });
    console.log("------------------------------------------\n");

    // SOGLIA MOLTO BASSA PER IL TEST: 0.10
    // Una volta visti i log nel terminale, deciderai tu dove alzarla
    return data.results
      .filter(r => r.score > 0.15) 
      .sort((a, b) => a.rank - b.rank)
      .map(r => {
        const original = documents.find(d => d.id === r.id);
        return {
          text: original.originalText,
          date: original.date
        };
      });
  } catch (e) {
    console.error("❌ Errore Reranker:", e);
    return [];
  }
}