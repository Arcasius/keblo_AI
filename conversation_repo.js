// conversation_repo.js
import fs from "fs";
import { rerankNews } from "./news_pipeline.js";
import path from "path";

const STORAGE_DIR = path.join(process.cwd(), "storage");
const USERS_DIR = path.join(STORAGE_DIR, "users");

function ensureDirs() {
  if (!fs.existsSync(STORAGE_DIR)) fs.mkdirSync(STORAGE_DIR, { recursive: true });
  if (!fs.existsSync(USERS_DIR)) fs.mkdirSync(USERS_DIR, { recursive: true });
}

function safeUserId(userId) {
  return String(userId || "anon").replace(/[^a-zA-Z0-9_-]/g, "_");
}

function getUserDir(userId) {
  const safeId = safeUserId(userId);
  return path.join(USERS_DIR, safeId);
}

export function convFilePath(userId) {
  const userDir = getUserDir(userId);
  if (!fs.existsSync(userDir)) {
    fs.mkdirSync(userDir, { recursive: true });
  }
  return path.join(userDir, "conversation.jsonl");
}

export function ensureConversationSession(userId) {
  // Questa funzione ora è più semplice - si limita a garantire che la directory utente esista
  ensureDirs();
  const userDir = getUserDir(userId);
  if (!fs.existsSync(userDir)) {
    fs.mkdirSync(userDir, { recursive: true });
  }
  return userId;
}

export function appendTurn(userId, turn) {
  ensureDirs();
  const file = convFilePath(userId);

  const isAssistant = turn.role === "assistant";

  const row = {
    v: 1,
    ts: new Date().toISOString(),
    userId,
    ...turn,
    traffic: isAssistant ? (turn.traffic ?? "yellow") : turn.traffic,
    confidence: isAssistant ? (turn.confidence ?? 0.5) : turn.confidence
  };

  fs.appendFileSync(file, JSON.stringify(row) + "\n", "utf-8");
  return row;
}


// Utility: leggi ultimi N turni
export function readLastTurns(userId, limit = 50) {
  ensureDirs();
  const file = convFilePath(userId);
  if (!fs.existsSync(file)) return [];

  const lines = fs.readFileSync(file, "utf-8").trim().split("\n");
  const last = lines.slice(Math.max(0, lines.length - limit));
  return last.map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

export function readAllTurns(userId) {
  ensureDirs();
  const file = convFilePath(userId);
  if (!fs.existsSync(file)) return [];

  const lines = fs.readFileSync(file, "utf-8").trim().split("\n");
  return lines.map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

export async function readLastGreenExchanges(userId, limit = 8) {
  const allTurns = readAllTurns(userId); 
  let greenHistory = [];

  // Scorriamo all'indietro
  for (let i = allTurns.length - 1; i >= 0; i--) {
    const turn = allTurns[i];

    // Se troviamo una risposta dell'assistente marcata GREEN
    if (turn.role === "assistant" && turn.traffic === "green") {
      greenHistory.unshift(turn); // Aggiungiamo la risposta
      
      // Prendiamo anche il messaggio dell'utente subito prima
      if (i > 0 && allTurns[i-1].role === "user") {
        greenHistory.unshift(allTurns[i-1]);
      }
    }

    if (greenHistory.length >= limit) break;
  }
  return greenHistory;
}

export function readContextTurns(userId, limit = 50) {
  const all = readLastTurns(userId, limit);

  const exchanges = [];

  for (let i = 1; i < all.length; i++) {
    const prev = all[i - 1];
    const curr = all[i];

    if (
      prev.role === "user" &&
      curr.role === "assistant" &&
      curr.traffic === "green"
    ) {
      exchanges.push(prev);
      exchanges.push(curr);
    }
  }

  // Ultimi 5 scambi = 10 turni max
  return exchanges.slice(-10);
}



// Utility: cerca nei turni (ricerca semplice nel testo)
export function searchTurns(userId, query, limit = 30) {
  ensureDirs();
  const file = convFilePath(userId);
  if (!fs.existsSync(file)) return [];
  
  if (!query || query.trim() === "") return readLastTurns(userId, limit);
  
  const q = query.toLowerCase();
  const lines = fs.readFileSync(file, "utf-8").trim().split("\n");
  const hits = [];
  
  for (let i = lines.length - 1; i >= 0 && hits.length < limit; i--) {
    try {
      const turn = JSON.parse(lines[i]);
      const text = turn.text || "";
      const role = turn.role || "";
      
      if (text.toLowerCase().includes(q) || role.toLowerCase().includes(q)) {
        hits.push(turn);
      }
    } catch (e) {
      // Ignora righe non valide
    }
  }
  
  return hits.reverse(); // Mantieni ordine cronologico
}

// Utility: ottieni statistiche conversazione
export function getConversationStats(userId) {
  ensureDirs();
  const file = convFilePath(userId);
  if (!fs.existsSync(file)) return { totalTurns: 0, firstTurn: null, lastTurn: null };
  
  const lines = fs.readFileSync(file, "utf-8").trim().split("\n");
  if (lines.length === 0) return { totalTurns: 0, firstTurn: null, lastTurn: null };
  
  let firstTurn = null;
  let lastTurn = null;
  
  try {
    firstTurn = JSON.parse(lines[0]);
    lastTurn = JSON.parse(lines[lines.length - 1]);
  } catch (e) {
    // Gestione errori di parsing
  }
  
  return {
    totalTurns: lines.length,
    userTurns: lines.filter(l => {
      try { 
        const t = JSON.parse(l); 
        return t.role === "user"; 
      } catch { 
        return false; 
      }
    }).length,
    assistantTurns: lines.filter(l => {
      try { 
        const t = JSON.parse(l); 
        return t.role === "assistant"; 
      } catch { 
        return false; 
      }
    }).length,
    firstTurn,
    lastTurn
  };
}
export async function semanticSearchTurns(userId, query, limit = 5) {
  const history = readLastTurns(userId, 100); // Carica gli ultimi 100 messaggi
  if (history.length === 0) return [];

  // Prepariamo i documenti per il Reranker
  const docs = history.map((h, i) => ({
    id: `msg_${i}`,
    text: `[${h.ts}] ${h.role}: ${h.text}`
  }));

  try {
    // Usiamo la tua funzione rerankNews per trovare i momenti più rilevanti
    const ranked = await rerankNews(query, docs);
    return ranked.slice(0, limit);
  } catch (e) {
    console.error("Ricerca semantica fallita, uso ricerca testuale");
    return searchTurns(userId, query, limit);
  }
}