// --- 1. GESTIONE IMPORT ---
import { exec } from 'child_process';
import util from 'util';
const execPromise = util.promisify(exec);import express from "express";
import { ingestEmotion } from "./emotions/emotion_pipeline.js";
import { fileURLToPath } from 'url';
import { searchPubmed, healthPubmed } from "./pubmed_search.js";
import { dirname } from 'path';
import "dotenv/config";
import session from "express-session";
import { addReminder, getReminders, updateReminder, searchEvents } from "./reminders_repo.js";
import { processInput, initialState } from "./keblo_engine.js";
import { audit, userAudit } from "./custode.js";
import { startScheduler } from "./scheduler.js";
import { analyzeConversationTurn } from "./intent_memory_router.js";
import { getRelevantNews, buildNewsSnippets, cleanNewsQuery, rerankNews } from "./news_pipeline.js";
import { parseDueDate } from "./time_parser.js";
import { ensureConversationSession, appendTurn, readLastTurns, readAllTurns, readLastGreenExchanges,readContextTurns, searchTurns, convFilePath, semanticSearchTurns } from "./conversation_repo.js";
import { createOrbitaleMemoryAdapter } from "./src/memory/orbitale/index.js";
import fs from "fs";
import { buildWorldBrief, readWorldBrief } from "./world_brief.js";
import { startWorldBriefScheduler } from "./world_brief_scheduler.js";
import path from "path";
import axios from "axios"; // Usa import, non require!
import multer from "multer";
import { createRequire } from "module";
import { gptReply, gptDiaryReply,gptReplyStream} from './llm_router.js'; // Assicurati del percorso corretto

// --- AGGIUNGI QUESTO PER RICREARE __dirname ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const storage = multer.memoryStorage();
const upload = multer({ 
  storage: storage,
  limits: { fileSize: 20 * 1024 * 1024 } // Limite 5MB
})
//import * as cheerio from "cheerio";
const require = createRequire(import.meta.url);

// --- 2. 🛠️ FIX PER NODE v18 (POLYFILLS) ---
// Devono essere definiti PRIMA di caricare pdf-parse
if (typeof global.DOMMatrix === 'undefined') {
    global.DOMMatrix = class DOMMatrix {
        constructor() {
            this.a = 1; this.b = 0; this.c = 0; this.d = 1; this.e = 0; this.f = 0;
        }
    };
}
if (typeof global.ImageData === 'undefined') {
    global.ImageData = class ImageData {};
}
if (typeof global.Path2D === 'undefined') {
    global.Path2D = class Path2D {};
}

  // --- API CONTROLLO MOTORE VISION ---


// --- 3. CARICAMENTO LIBRERIE LEGACY ---
const pdf = require("pdf-parse");

// --- 4. CONFIGURAZIONE APP ---
const app = express();
app.use(express.json({ limit: '20mb' })); // Permette invii fino a 20 Mega
app.use(express.urlencoded({ limit: '20mb', extended: true }));
app.use(express.static("public"));

let orbitaleShadowAdapter = null;

function isOrbitaleShadowEnabled() {
  return process.env.ORBITALE_MEMORY_ENABLED === "true";
}

function getOrbitaleShadowAdapter() {
  if (!isOrbitaleShadowEnabled()) {
    console.log("[orbitale-shadow] disabled");
    return null;
  }

  if (!orbitaleShadowAdapter) {
    orbitaleShadowAdapter = createOrbitaleMemoryAdapter({
      enabled: true
    });
  }

  return orbitaleShadowAdapter;
}

async function saveOrbitaleShadowTurn(userId, turn, pairedUserTurn = null) {
  const turnId = turn?.ts || "unknown";
  const traffic = turn?.traffic;

  if (!isOrbitaleShadowEnabled()) {
    console.log("[orbitale-shadow] disabled");
    return { saved: false, marker: null };
  }

  if (typeof turn?.confidence === "number") {
    console.log(`[orbitale-shadow] confidence turn=${turnId} confidence=${turn.confidence}`);
  }

  if (traffic !== "green") {
    console.log(`[orbitale-shadow] skipped traffic=${traffic}`);
    return { saved: false, marker: null };
  }

  const role = turn?.role;
  const text = typeof turn?.text === "string" ? turn.text : "";

  if (role !== "user" && role !== "assistant") {
    console.log(`[orbitale-shadow] skipped unclear_role turn=${turnId} role=${role}`);
    return { saved: false, marker: null };
  }

  if (turn?.orbitaleSaved === true && role !== "assistant") {
    console.log(`[orbitale-shadow] skipped already_saved turn=${turnId}`);
    return { saved: false, marker: null };
  }

  let orbitale = null;
  try {
    orbitale = getOrbitaleShadowAdapter();
    if (!orbitale) {
      return { saved: false, marker: null };
    }
  } catch (err) {
    console.error(`[orbitale-shadow] error adapter turn=${turnId} ${err?.message || err}`);
    return { saved: false, marker: null };
  }

  if (role === "assistant") {
    if (!pairedUserTurn || pairedUserTurn.role !== "user") {
      console.log(`[orbitale-shadow] no_safe_user_pair turn=${turnId}`);
    } else if (pairedUserTurn.orbitaleSaved === true) {
      console.log(`[orbitale-shadow] skipped paired already_saved turn=${pairedUserTurn.ts || "unknown"}`);
    } else {
      try {
        await orbitale.saveUser(userId, typeof pairedUserTurn.text === "string" ? pairedUserTurn.text : "");
        pairedUserTurn.orbitaleSaved = true;
        pairedUserTurn.orbitaleSavedAt = new Date().toISOString();
        console.log(`[orbitale-shadow] saved paired role=user turn=${pairedUserTurn.ts || "unknown"}`);
      } catch (err) {
        console.error(`[orbitale-shadow] error paired role=user turn=${pairedUserTurn.ts || "unknown"} ${err?.message || err}`);
      }
    }
  }

  if (turn?.orbitaleSaved === true) {
    console.log(`[orbitale-shadow] skipped already_saved turn=${turnId}`);
    return { saved: false, marker: null };
  }

  try {
    if (role === "user") {
      await orbitale.saveUser(userId, text);
      console.log(`[orbitale-shadow] saved role=user turn=${turnId}`);
    } else {
      await orbitale.saveAssistant(userId, text);
      console.log(`[orbitale-shadow] saved role=assistant turn=${turnId}`);
    }

    return {
      saved: true,
      marker: {
        orbitaleSaved: true,
        orbitaleSavedAt: new Date().toISOString()
      }
    };
  } catch (err) {
    console.error(`[orbitale-shadow] error turn=${turnId} ${err?.message || err}`);
    return { saved: false, marker: null };
  }
}

function getOrbitaleCockpitMemoryPath() {
  return process.env.ORBITALE_MEMORY_PATH || "./orbitale_memory_data";
}

function readOrbitaleJsonFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return [];
    }

    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (Array.isArray(parsed)) {
      return parsed.filter(Boolean);
    }

    if (parsed && typeof parsed === "object") {
      return Object.values(parsed).filter(Boolean);
    }
  } catch (err) {
    console.error("[orbitale-cockpit] read error file=" + filePath + " " + (err?.message || err));
  }

  return [];
}

function hasOrbitaleUserFiles(memoryPath, userId) {
  return fs.existsSync(path.join(memoryPath, userId + "_memories.json")) ||
    fs.existsSync(path.join(memoryPath, userId + "_links.json"));
}

function resolveOrbitaleCockpitUserId(req, memoryPath) {
  const sessionUserId = req.session?.user?.id;
  if (sessionUserId) {
    return sessionUserId;
  }

  if (hasOrbitaleUserFiles(memoryPath, "u1")) {
    return "u1";
  }

  return "keblo_user";
}

function getOrbitaleText(memory) {
  return typeof memory?.content?.text === "string" ? memory.content.text :
    typeof memory?.text === "string" ? memory.text : "";
}

function getOrbitaleRole(memory) {
  const role = memory?.content?.role || memory?.role;
  return role === "user" || role === "assistant" ? role : "unknown";
}

function getOrbitaleOrbit(memory) {
  const orbit = memory?.orbitalLevel || memory?.orbital?.level;
  return orbit === "short" || orbit === "medium" || orbit === "long" ? orbit : "unknown";
}

function getOrbitaleDepth(memory) {
  const depth = memory?.memoryDepth || memory?.depth;
  return depth === "temporary" || depth === "normal" || depth === "deep" ? depth : "unknown";
}

function getOrbitaleTimestamp(memory) {
  return memory?.timestamp || memory?.created_at || memory?.meta?.timestamp || null;
}

function createOrbitaleNodeLabel(memory) {
  const text = getOrbitaleText(memory).replace(/\s+/g, " ").trim();
  const source = text || memory?.id || "memory";
  return source.length > 80 ? source.slice(0, 77) + "..." : source;
}

function normalizeOrbitaleNode(memory) {
  return {
    id: memory?.id || "unknown",
    label: createOrbitaleNodeLabel(memory),
    text: getOrbitaleText(memory),
    role: getOrbitaleRole(memory),
    orbit: getOrbitaleOrbit(memory),
    depth: getOrbitaleDepth(memory),
    activation: typeof memory?.activation === "number" ? memory.activation : memory?.orbital?.activation_score ?? null,
    importance: typeof memory?.meta?.importance === "number" ? memory.meta.importance : memory?.importance ?? null,
    tags: Array.isArray(memory?.tags) ? memory.tags : [],
    timestamp: getOrbitaleTimestamp(memory),
    lastAccess: memory?.lastAccess || memory?.last_access || memory?.meta?.lastAccess || null
  };
}

function normalizeOrbitaleLink(link) {
  return {
    id: link?.id || (link?.source || "unknown") + "_" + (link?.target || "unknown"),
    source: link?.source || null,
    target: link?.target || null,
    weight: typeof link?.weight === "number" ? link.weight : null,
    type: link?.type || "unknown"
  };
}

function readOrbitaleCockpitData(req) {
  const memoryPath = getOrbitaleCockpitMemoryPath();
  const userId = resolveOrbitaleCockpitUserId(req, memoryPath);
  const memories = readOrbitaleJsonFile(path.join(memoryPath, userId + "_memories.json"));
  const links = readOrbitaleJsonFile(path.join(memoryPath, userId + "_links.json"));

  return { memoryPath, userId, memories, links };
}

function countTopOrbitaleTags(memories, limit = 12) {
  const counts = new Map();
  for (const memory of memories) {
    for (const tag of Array.isArray(memory?.tags) ? memory.tags : []) {
      counts.set(tag, (counts.get(tag) || 0) + 1);
    }
  }

  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([tag, count]) => ({ tag, count }));
}

function buildOrbitaleStatus(memories, links, memoryPath) {
  const roles = { user: 0, assistant: 0, unknown: 0 };
  const orbits = { short: 0, medium: 0, long: 0, unknown: 0 };
  const depths = { temporary: 0, normal: 0, deep: 0, unknown: 0 };

  for (const memory of memories) {
    roles[getOrbitaleRole(memory)] += 1;
    orbits[getOrbitaleOrbit(memory)] += 1;
    depths[getOrbitaleDepth(memory)] += 1;
  }

  return {
    ok: true,
    enabled: isOrbitaleShadowEnabled(),
    memoryPath,
    memoriesCount: memories.length,
    linksCount: links.length,
    roles,
    orbits,
    depths,
    topTags: countTopOrbitaleTags(memories)
  };
}

// --- COPIA QUESTE NEL SERVER.JS ---
app.post("/api/pubmed-search", async (req, res) => {
  try {
    const { query, lastYears = 10, limit = 10 } = req.body;

    if (!query || !String(query).trim()) {
      return res.status(400).json({ ok: false, msg: "Query mancante" });
    }

    const results = await searchPubmed(String(query), {
      lastYears: Number(lastYears) || 10,
      limit: Math.min(Number(limit) || 10, 30),
    });

    res.json({
      ok: true,
      count: results.length,
      results,
    });
  } catch (err) {
    console.error("PUBMED SEARCH ERROR:", err);
    res.status(500).json({ ok: false, msg: "Errore ricerca PubMed" });
  }
});

app.get("/api/pubmed-health", async (req, res) => {
  try {
    const data = await healthPubmed();
    res.json({ ok: true, ...data });
  } catch (err) {
    console.error("PUBMED HEALTH ERROR:", err);
    res.status(500).json({ ok: false, msg: "Errore connessione PubMed DB" });
  }
});

function tryExtractPubmedQuery(text = "") {
  const t = String(text || "").trim();
  if (!t) return null;

  const lower = t.toLowerCase();

  // Trigger forti: solo questi attivano la ricerca DB
  const hasTrigger =
    lower.includes("pubmed") ||
    lower.includes("ricerca scientifica");

  if (!hasTrigger) return null;

  const patterns = [
    /pubmed.*?\b(?:su|sul|sulla|sullo|sui|sugli|del|della|dello|dei|degli|di)\b\s+(.+)$/i,
    /ricerca scientifica.*?\b(?:su|sul|sulla|sullo|sui|sugli|del|della|dello|dei|degli|di)\b\s+(.+)$/i,
    /cerca su pubmed\s+(.+)$/i,
    /articoli su pubmed.*?\b(?:su|sul|sulla|sullo|sui|sugli|del|della|dello|dei|degli|di)\b\s+(.+)$/i,
    /ultimi articoli della ricerca scientifica.*?\b(?:su|sul|sulla|sullo|sui|sugli|del|della|dello|dei|degli|di)\b\s+(.+)$/i
  ];

  for (const p of patterns) {
    const m = t.match(p);
    if (m && m[1]) {
      const topic = m[1]
        .replace(/[?.!,;:]+$/g, "")
        .trim();

      if (topic.length >= 2) return topic;
    }
  }

  return null;
}
function formatPubmedResults(results, query) {
  if (!results?.length) {
    return `Non ho trovato articoli recenti su "${query}".`;
  }

  const lines = results.map((r, i) => {
    const year = r.year ?? "s.d.";
    const journal = r.journal || "Rivista non indicata";
    return `${i + 1}. [${year}] ${r.title} — ${journal} (PMID: ${r.pmid})`;
  });

  return `Ecco alcuni articoli recenti su "${query}":\n\n${lines.join("\n")}`;
}

app.get("/api/vision/status", async (req, res) => {
    try {
        const { stdout } = await execPromise("docker inspect -f '{{.State.Running}}' comfyui-api");
        res.json({ ok: true, running: stdout.trim() === "true" });
    } catch (e) { 
        res.json({ ok: false, running: false }); 
    }
});
app.post("/api/chat/upload-image", isAuthenticated, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, msg: "Nessuna immagine inviata" });
    }

    const userId = req.session.user.id;
    const chatImgDir = path.join(process.cwd(), "storage", "users", userId, "chat_images");
    if (!fs.existsSync(chatImgDir)) fs.mkdirSync(chatImgDir, { recursive: true });

    const fileName = req.file.originalname;
    const filePath = path.resolve(chatImgDir, fileName);

    fs.writeFileSync(filePath, req.file.buffer);

    return res.json({
      ok: true,
      fileName,
      filePath,
      mime: req.file.mimetype
    });
  } catch (err) {
    console.error("Errore upload immagine chat:", err);
    return res.status(500).json({ ok: false, msg: "Errore upload immagine chat" });
  }
});

// 🚀 RIMUOVI "isAuthenticated" DA QUI (SOLO PER TEST O SE SEI IN LOCALE)
app.post("/api/vision/engine", async (req, res) => {
    const { action } = req.body;
    try {
        if (action === "start") {
            await execPromise("docker start comfyui-api");
            res.json({ ok: true, status: "online" });
        } else {
            await execPromise("docker stop comfyui-api");
            res.json({ ok: true, status: "offline" });
        }
    } catch (e) {
        // Se arriviamo qui, il problema è Docker, non l'auth
        console.error("❌ ERRORE DOCKER REALE:", e.message);
        res.json({ ok: false, error: e.message });
    }
});

const SESSION_SECRET = process.env.SESSION_SECRET || "CHANGE_ME_IN_PROD";
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production"
  }
}));

// --- GESTIONE UTENTI ---
const USERS_FILE = "./users.json";

function getUser(username) {
  if (!fs.existsSync(USERS_FILE)) {
    // Crea file utenti di default se non esiste
    const defaultUsers = {
      "admin": { "password": "123", "id": "u1" },
      "elena": { "password": "keblo2026", "id": "u2" }
    };
    fs.writeFileSync(USERS_FILE, JSON.stringify(defaultUsers, null, 2));
  }
  
  const data = JSON.parse(fs.readFileSync(USERS_FILE, "utf-8"));
  return data[username];
}


//Funzione estrapola immagine siti per RSS
async function getOgImage(url) {
  try {
    const urlObj = new URL(url);

    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0"
      },
      signal: AbortSignal.timeout(3000)
    });

    const html = await res.text();

    // OpenGraph
    let match =
      html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);

    // Twitter fallback
    if (!match) {
      match = html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i);
    }

    if (match) {
      let img = match[1];

      if (img.startsWith("//")) return "https:" + img;
      if (img.startsWith("/")) return urlObj.origin + img;
      if (!img.startsWith("http")) return urlObj.origin + "/" + img;

      return img;
    }

  } catch (e) {}

  return null;
}
//Fine Funzione estrapola Immagini 


async function callLlamaForVision(text, type = 'cognitiva') {
  // Definiamo le "Vesti" estetiche in Italiano
  const styles = {
    'cognitiva': "Un'illustrazione medica e scientifica in 3D di altissimo livello. La scena è ambientata in un laboratorio futuristico oscuro con proiezioni olografiche. Vediamo un modello tridimensionale traslucido del soggetto con nodi interni luminosi e percorsi bioluminescenti. Rendering stile Unreal Engine 5, luci cinematografiche e texture iper-realistiche.",
    'schema': "Un'interfaccia olografica HUD (Heads-Up Display) avanzata. Il design è minimalista e tecnico, con icone vettoriali pulite che rappresentano il concetto. Linee di flusso sottili e brillanti collegano i nodi di informazione. Sfondo blu notte profondo con effetto vetro smerigliato. Tipografia futuristica ultra-nitida. Solo poche etichette essenziali. Estetica da laboratorio di analisi dati ad alta tecnologia.",
    'realistico': "Fotografia iper-realistica, stile National Geographic, lenti Sony A7R IV 85mm, luce naturale, dettagli della pelle e pori visibili, texture organiche, NIENTE elementi futuristici o neon.",
    'cinematic': "Inquadratura cinematografica anamorfica, contrasto elevato, luci volumetriche (God rays), profondità di campo cinematografica (bokeh), atmosfera da grande produzione cinematografica.",
    'vintage': "Estetica pellicola analogica 35mm anni '70, colori caldi e desaturati, grana sottile, look nostalgico, lenti vintage, sapore di fotografia storica.",
    'artistico': "Concept art epica, stile digitale d'autore, pennellate visibili, composizione drammatica, stile videogiochi Tripla A, atmosfera evocativa.",
   'scomponi': "Una scomposizione tecnica avanzata (vista esplosa). Tutti i componenti sono smontati e fluttuano in un ambiente a gravità zero. Ogni parte ha una texture realistica, metallica o polimerica. Luci soffuse da studio fotografico con sottili accenti blu e viola."
  };

  // Istruzione in Italiano per Llama (5090)
  const instruction = `
    [RUOLO]: Sei un Senior Visual Architect esperto in vari stili fotografici.
    [COMPITO]: Espandi il SOGGETTO in una descrizione ricca.
    [REGOLA FERREA]: Se lo STILE RICHIESTO è 'VINTAGE' o 'REALISTICO', 
    evita ASSOLUTAMENTE parole come "laboratorio", "futuristico", "ologramma" o "neon". 
    Concentrati su texture naturali, polvere, grana della pellicola o luce solare.
    
    SOGGETTO: ${text}.
    STILE RICHIESTO: ${styles[type]}.
    
    RISPOSTA (Solo il prompt espanso in Italiano):`;

  try {
    const response = await fetch("http://localhost:11436/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "llama3.2:3b", // Il tuo modello sulla 5090
        prompt: instruction,
        stream: false,
        options: { 
          temperature: 0.8,
          num_predict: 120 // Diamo spazio a una descrizione ricca
        }
      })
    });
  // Leggiamo la risposta JSON
    const data = await response.json();
    
    // DEBUG: Vediamo cosa risponde davvero Llama (rimuovilo quando funziona)
    // console.log("[DEBUG OLLAMA]:", data);

    // Cerchiamo il testo: può essere in .response (standard) o in .message.content (chat)
    const resultText = data.response || (data.message ? data.message.content : null);

    if (resultText) {
        return resultText.trim();
    } else {
        // Se Llama risponde ma non c'è testo (es. solo statistiche)
        return text; 
    }

  } catch (e) {
    // Se la chiamata fetch fallisce o c'è un errore di rete
    console.error("Errore nel cervello visivo:", e.message);
    return text; // Fallback al prompt originale
  }
}

//Funzione estrazione Immagini 

// Middleware per proteggere le API
async function callLLMForEmotion(prompt) {
  // Questa funzione fa una chiamata "secca" a Ollama solo per estrarre il JSON delle emozioni
  const response = await fetch(OLLAMA_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL, // o un modello più piccolo se lo hai, per essere più veloce
      prompt: prompt,
      stream: false,
      options: { temperature: 0.01 } // Bassissima temperatura per avere JSON precisi
    })
  });
  const data = await response.json();
  return data.response;
}
function isAuthenticated(req, res, next) {
  // Verifica se l'utente è loggato nella sessione
  if (req.session && req.session.user) {
    return next();
  }
  // Se non è loggato, blocca la richiesta
  res.status(401).json({ ok: false, msg: "Sessione non valida o scaduta" });
}
// API LOGIN
app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;
  const user = getUser(username);

  if (user && user.password === password) {
    // AGGIUNTO: Inizializziamo lo 'state' usando initialState importato da keblo_engine
    req.session.user = { 
      id: user.id, 
      username: username,
      state: initialState() // <--- IMPORTANTE: Copia lo stato iniziale
    };

    console.log(`✅ Login riuscito per: ${username}`);
    
    const userDir = path.join(process.cwd(), "storage", "users", user.id, "files");
    if (!fs.existsSync(userDir)) fs.mkdirSync(userDir, { recursive: true });

    try {
      await ensureConversationSession(user.id);
    } catch (e) {
      console.error("Errore non critico in ensureConversationSession:", e);
    }

    req.session.save((err) => {
      if (err) {
        console.error("Errore salvataggio sessione:", err);
        return res.status(500).json({ ok: false });
      }
      res.json({ ok: true, username });
    });
    
  } else {
    res.status(401).json({ ok: false, msg: "Credenziali errate" });
  }
});

// API LOGOUT
app.post("/api/logout", (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

// API SESSION - modificata per autenticazione
app.post("/api/session", async (req, res) => {
  if (req.session && req.session.user) {
    try {
      // Refresh della sessione conversazione
      await ensureConversationSession(req.session.user.id);
      res.json({ 
        ok: true, 
        userId: req.session.user.id, 
        username: req.session.user.username 
      });
    } catch (e) {
      console.error("SESSION ensureConversationSession error:", e);
      // Rispondiamo comunque ok perché la sessione Express esiste
      res.json({ ok: true, userId: req.session.user.id });
    }
  } else {
    // Nessun utente loggato
    res.json({ ok: false, userId: null });
  }
});

// --- 5. HELPER FUNCTIONS ---
function logIntelEvent(cardId, message, payload = {}) {
  const cardLabel = cardId || "no-card";
  console.log(`[INTEL][${cardLabel}] ${message}`, payload);
}
function chunkText(text, chunkSize = 500, overlap = 50) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    const end = start + chunkSize;
    let chunk = text.substring(start, Math.min(end, text.length));
    if (end < text.length) {
      const breakIndex = Math.max(chunk.lastIndexOf('.'), chunk.lastIndexOf(' '), chunk.lastIndexOf('\n'));
      if (breakIndex > chunkSize * 0.7) {
        chunk = text.substring(start, start + breakIndex + 1);
        start = start + breakIndex + 1 - overlap;
      } else {
        start = end - overlap;
      }
    } else {
      start = text.length;
    }
    if (chunk.trim()) chunks.push(chunk.trim());
  }
  return chunks;
}

function chunkTextWithOverlap(text, size, overlap) {
  const chunks = [];
  let i = 0;
  while (i < text.length) {
    chunks.push(text.substring(i, i + size));
    i += size - overlap; // Torna indietro di 'overlap' caratteri per il prossimo chunk
  }
  return chunks;
}

// --- API VOCE UNIVERSALE ---
// --- API VOCE UNIVERSALE (PIPER LOCALE) ---
app.post("/api/tts", isAuthenticated, async (req, res) => {
  try {
    const { text } = req.body;
    if (!text) return res.json({ ok: false });

    const userId = req.session.user.id;
    const audioDir = path.join(process.cwd(), "storage", "users", userId, "audio");
    
    // Crea la cartella audio se non esiste
    if (!fs.existsSync(audioDir)) fs.mkdirSync(audioDir, { recursive: true });

    const fileName = `voice_${Date.now()}.wav`;
    const filePath = path.join(audioDir, fileName);

    // Pulizia testo per evitare che caratteri come " o $ rompano il comando bash
    const cleanText = text.replace(/["'$`\\]/g, "").substring(0, 1000);

    // COMANDO DEFINITIVO (Testato con il tuo successo manuale)
    const piperCmd = `echo "${cleanText}" | docker exec -i keblo-voice-engine /app/piper/piper --model /app/models/it_IT-paola-medium.onnx --output_file /tmp/out.wav && docker cp keblo-voice-engine:/tmp/out.wav "${filePath}"`;

    await execPromise(piperCmd);

    console.log(`🔊 [TTS] Audio generato per ${userId}: ${fileName}`);
    
    // Inviamo l'URL relativo per far sì che il frontend lo possa suonare
    res.json({ ok: true, url: `/api/audio-stream/${userId}/${fileName}` });

  } catch (e) {
    console.error("ERRORE TTS:", e.message);
    res.json({ ok: false, error: "Sintesi vocale fallita." });
  }
});
// --- ROTTA SERVIZIO AUDIO ---
app.get("/api/audio-stream/:uid/:file", isAuthenticated, (req, res) => {
    const { uid, file } = req.params;
    
    // Sicurezza: verifichiamo che l'utente chieda solo i PROPRI file
    if (req.session.user.id !== uid && req.session.user.username !== 'admin') {
        return res.status(403).send("Access Denied");
    }

    const filePath = path.join(process.cwd(), "storage", "users", uid, "audio", file);
    
    if (fs.existsSync(filePath)) {
        res.sendFile(filePath);
    } else {
        res.status(404).send("Audio not found");
    }
});
// Rotta per servire l'audio al browser
app.get("/api/audio-stream/:uid/:file", (req, res) => {
    const p = path.join(process.cwd(), "storage", "users", req.params.uid, "audio", req.params.file);
    if (fs.existsSync(p)) res.sendFile(p);
    else res.status(404).end();
});
// importa anche tutto il resto che già usi:
// ensureConversationSession, appendTurn, userAudit, ingestEmotion,
// readLastGreenExchanges, processInput, ecc.

function isWorldBriefRequest(text = "") {
  const t = String(text || "").toLowerCase().trim();

  return (
    t.includes("aggiorna notizie") ||
    t.includes("sincronizza notizie") ||
    t.includes("sincronizza mondo") ||
    t.includes("brief del mondo") ||
    t.includes("cosa succede oggi") ||
    t.includes("notizie di oggi") ||
    t.includes("che succede in italia") ||
    t.includes("che succede nel mondo")
  );
}

function formatWorldBriefForChat(brief) {
  const italy = (brief.italy || []).slice(0, 8);
  const world = (brief.world || []).slice(0, 8);
  const signals = (brief.signals || []).slice(0, 5);

  const italyText = italy.length
    ? italy.map((n, i) => `${i + 1}. ${n.title} — ${n.source}`).join("\n")
    : "Nessuna notizia Italia disponibile.";

  const worldText = world.length
    ? world.map((n, i) => `${i + 1}. ${n.title} — ${n.source}`).join("\n")
    : "Nessuna notizia mondo disponibile.";

  const signalsText = signals.length
    ? signals.map((s, i) => `${i + 1}. ${s}`).join("\n")
    : "Nessun segnale sintetico disponibile.";

  return `Ecco il brief del mondo aggiornato.

ITALIA
${italyText}

MONDO
${worldText}

SEGNALI
${signalsText}

Generato: ${brief.generated_at}`;
}
async function safeReadWorldBrief() {
  try {
    return await readWorldBrief();
  } catch (err) {
    return null;
  }
}

function isWorldRelevantTurn(text = "", intentAnalysis = null) {
  const t = String(text || "").toLowerCase();

  if (
    t.includes("notizie") ||
    t.includes("mondo") ||
    t.includes("italia") ||
    t.includes("governo") ||
    t.includes("guerra") ||
    t.includes("ucraina") ||
    t.includes("russia") ||
    t.includes("usa") ||
    t.includes("cina") ||
    t.includes("israele") ||
    t.includes("iran") ||
    t.includes("economia") ||
    t.includes("mercati") ||
    t.includes("borsa") ||
    t.includes("politica") ||
    t.includes("attualità") ||
    t.includes("attualita")
  ) {
    return true;
  }

  const domain = intentAnalysis?.refinedIntent?.primaryDomain?.toLowerCase() || "";
  const topic = intentAnalysis?.shortMemory?.activeTopic?.toLowerCase() || "";
  const need = intentAnalysis?.shortMemory?.unresolvedNeed?.toLowerCase() || "";

  return (
    domain.includes("news") ||
    domain.includes("current") ||
    domain.includes("politic") ||
    topic.includes("notizie") ||
    topic.includes("italia") ||
    topic.includes("mondo") ||
    need.includes("notizie")
  );
}

function wantsDeepWorldContext(text = "") {
  const t = String(text || "").toLowerCase();

  return (
    t.includes("approfond") ||
    t.includes("analizza") ||
    t.includes("commenta") ||
    t.includes("spiegami meglio") ||
    t.includes("che ne pensi") ||
    t.includes("fammi un quadro") ||
    t.includes("dimmi di più") ||
    t.includes("dimmi di piu") ||
    t.includes("nel dettaglio")
  );
}

function buildWorldBriefLightContext(brief) {
  if (!brief) return "";

  const italy = (brief.italy || []).slice(0, 3);
  const world = (brief.world || []).slice(0, 3);
  const signals = (brief.signals || []).slice(0, 3);

  return `STATO DEL MONDO RECENTE (CONTEXTO LEGGERO)
ITALIA:
${italy.map((n, i) => `- ${n.title}`).join("\n") || "- Nessun dato disponibile"}

MONDO:
${world.map((n, i) => `- ${n.title}`).join("\n") || "- Nessun dato disponibile"}

SEGNALI:
${signals.map(s => `- ${s}`).join("\n") || "- Nessun segnale disponibile"}

Generato: ${brief.generated_at}`;
}

function buildWorldBriefDeepContext(brief) {
  if (!brief) return "";

  const italy = (brief.italy || []).slice(0, 8);
  const world = (brief.world || []).slice(0, 8);
  const tech = (brief.technology || []).slice(0, 4);
  const science = (brief.science_health || []).slice(0, 4);
  const signals = (brief.signals || []).slice(0, 5);

  return `STATO DEL MONDO RECENTE (CONTESTO PROFONDO)

ITALIA:
${italy.map((n, i) => `${i + 1}. ${n.title} — ${n.source}`).join("\n") || "Nessun dato disponibile"}

MONDO:
${world.map((n, i) => `${i + 1}. ${n.title} — ${n.source}`).join("\n") || "Nessun dato disponibile"}

TECNOLOGIA:
${tech.map((n, i) => `${i + 1}. ${n.title} — ${n.source}`).join("\n") || "Nessun dato disponibile"}

SCIENZA/SALUTE:
${science.map((n, i) => `${i + 1}. ${n.title} — ${n.source}`).join("\n") || "Nessun dato disponibile"}

SEGNALI:
${signals.map((s, i) => `${i + 1}. ${s}`).join("\n") || "Nessun segnale disponibile"}

Generato: ${brief.generated_at}`;
}


app.post("/api/chat", isAuthenticated, async (req, res) => {
  // Configurazione SSE
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");

  const sendEvent = (obj) => {
    try {
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    } catch (e) {
      console.error("SSE write error:", e);
    }
  };

  // sveglia frontend
  sendEvent({ type: "chunk", text: " " });

  const userId = req.session.user.id;
  await ensureConversationSession(userId);

  const { text, images = [] } = req.body;
  const rawText = typeof text === "string" ? text : "";
  const t = rawText.trim().toLowerCase();

  // Gestione sessione veloce
  if (t === "init_session" || t === "ping" || t === "session") {
    sendEvent({
      type: "done",
      reply: "ok",
      card: null,
      meta: {
        tokenUsed: 0,
        tokenLimit: 10000000,
        blocked: false
      }
    });
    return res.end();
  }

  // --- WORLD BRIEF ROUTE DIRETTA ---
  if (isWorldBriefRequest(rawText)) {
    try {
      let brief;

      if (t.includes("aggiorna") || t.includes("sincronizza")) {
        console.log("[WORLD BRIEF] refresh richiesto da chat");
        brief = await buildWorldBrief(true);
      } else {
        console.log("[WORLD BRIEF] lettura brief salvato");
        brief = await readWorldBrief();
      }

      const reply = formatWorldBriefForChat(brief);

      const finalMeta = {
        tokenUsed: 0,
        tokenLimit: 10000,
        promptTokens: 0,
        speed: "WORLD_BRIEF",
        blocked: false,
        source: "world_brief",
        route: {
          baseIntent: "explain",
          domainIntent: "news_intelligence",
          subdomain: "world_brief",
          domainSource: "current_text",
          responseProfile: {
            register: "analytical",
            tone: "sobrio_fonti_chiare",
            rhetoric: "low",
            structure: "briefing",
            depth: "medium"
          },
          voiceCalibration: false,
          confidence: 1,
          signals: ["worldBrief"],
          contextLift: true
        }
      };

      await appendTurn(userId, {
        role: "user",
        text: rawText,
        meta: {
          tokenUsed: 0,
          tokenLimit: 10000,
          blocked: false,
          images: [],
          multimodal: false
        }
      });

      const saved = await appendTurn(userId, {
        role: "assistant",
        text: reply,
        traffic: "green",
        confidence: 0.9,
        card: null,
        intent: "world_brief",
        domain: "current_events",
        shortMemorySummary: "Brief del mondo richiesto",
        meta: finalMeta
      });

      sendEvent({
        type: "done",
        reply,
        ts: saved.ts,
        mood: "focus",
        card: null,
        meta: finalMeta
      });

      return res.end();
    } catch (err) {
      console.error("[WORLD BRIEF CHAT] errore:", err);
      // fallback: se fallisce, continua col flusso normale
    }
  }

  try {
    // Stato sessione minimo
    if (!req.session.user.state) req.session.user.state = {};
    if (!("shortMemory" in req.session.user.state)) {
      req.session.user.state.shortMemory = null;
    }

    // 1. Salva messaggio utente
    await appendTurn(userId, {
      role: "user",
      text: rawText,
      meta: {
        tokenUsed: 0,
        tokenLimit: 10000,
        blocked: false,
        images: images.map(img => ({
          name: img.name || null,
          path: img.path,
          mime: img.mime || "image/jpeg"
        })),
        multimodal: images.length > 0
      }
    });
    userAudit(userId, "CHAT_INPUT", { chars: rawText.length });

    // 2. EMA / Mood
    const emoData = await ingestEmotion({
      baseDir: process.cwd(),
      userId,
      text: rawText,
      callLLM: async (prompt) => {
        const response = await fetch("http://localhost:11436/api/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "llama3.2:3b",
            prompt,
            stream: false,
            options: {
              temperature: 0.01,
              num_ctx: 512
            }
          })
        });

        const data = await response.json();
        return data.response;
      }
    });

    const currentMood = emoData?.promptEmotion?.mood_line ?? "mood=neutral";
    const primaryMood = currentMood.split("=")[1]?.split("+")[0] || "neutral";

    console.log(`[STREAMING] Mood rilevato: ${primaryMood}`);

    // 3. Recupero storia per contesto
    const history = await readLastGreenExchanges(userId, 8);

    // 4. Analisi intent + short memory
    const intentAnalysis = analyzeConversationTurn({
      text: rawText,
      lastTurns: history,
      previousShortMemory: req.session.user.state.shortMemory || null,
      userPreferences: {
        preferredStyle: "direct"
      }
    });

    // 5. Persist short memory in session
    req.session.user.state.shortMemory = intentAnalysis.shortMemory;

    console.log("[INTENT ANALYSIS]", {
      intent: intentAnalysis?.refinedIntent?.primaryIntent,
      domain: intentAnalysis?.refinedIntent?.primaryDomain,
      topic: intentAnalysis?.shortMemory?.activeTopic,
      subTopic: intentAnalysis?.shortMemory?.subTopic,
      need: intentAnalysis?.shortMemory?.unresolvedNeed,
      shift: intentAnalysis?.contextShift
    });

    // --- WORLD CONTEXT INJECTION (LIGHT / DEEP) ---
    const brief = await safeReadWorldBrief();
    const worldRelevant = isWorldRelevantTurn(rawText, intentAnalysis);

    let worldContext = "";

    if (brief && worldRelevant) {
      if (wantsDeepWorldContext(rawText)) {
        worldContext = buildWorldBriefDeepContext(brief);
        console.log("[WORLD CONTEXT] modalità PROFONDA");
      } else {
        worldContext = buildWorldBriefLightContext(brief);
        console.log("[WORLD CONTEXT] modalità LEGGERA");
      }
    }
        console.log("[WORLD DEBUG] brief exists =", !!brief);
    console.log("[WORLD DEBUG] worldRelevant =", worldRelevant);
    console.log("[WORLD DEBUG] rawText =", rawText);

    // --- COSTRUZIONE CONTESTO FINALE ---
    let finalInputText = rawText;
    const pubmedTopic = tryExtractPubmedQuery(rawText);

    if (pubmedTopic) {
      console.log(`[PUBMED] Ricerca rilevata per: ${pubmedTopic}`);
      sendEvent({ type: "chunk", text: "_Consulto l'archivio scientifico..._\n\n" });

      try {
        const pubmedResults = await searchPubmed(pubmedTopic, { lastYears: 10, limit: 8 });
        const formattedPubmed = formatPubmedResults(pubmedResults, pubmedTopic);

        finalInputText = `
${worldContext ? worldContext + "\n\n---\n\n" : ""}CONTESTO PUBMED RICERCATO:
${formattedPubmed}

DOMANDA UTENTE:
${rawText}

ISTRUZIONI:
- Usa i dati PubMed sopra citati per rispondere in modo scientifico.
- Se non ci sono risultati, dillo chiaramente.
- Se è presente anche il contesto del mondo, usalo solo come sfondo generale e non come fonte primaria scientifica.
- Non trattare le risposte precedenti della conversazione come fonte scientifica.
`.trim();

        console.log("[PUBMED] Iniezione completata nel prompt.");
      } catch (pErr) {
        console.error("[PUBMED] Fallimento durante la ricerca:", pErr);

        if (worldContext) {
          finalInputText = `
${worldContext}

DOMANDA UTENTE:
${rawText}

ISTRUZIONI:
- Usa il contesto del mondo solo se rilevante.
- Se non basta, dillo chiaramente.
- Non trattare la conversazione precedente come fonte fattuale primaria.
`.trim();
        }
      }
    } else if (worldContext) {
      finalInputText = `
${worldContext}

DOMANDA UTENTE:
${rawText}

ISTRUZIONI:
- Usa il contesto del mondo solo se rilevante per la richiesta.
- Se la domanda non riguarda attualità o mondo, trattalo come sfondo secondario.
- Non trattare la conversazione precedente come fonte fattuale primaria.
`.trim();
    }

        console.log("\n================ WORLD CONTEXT RAW ================");
    console.log(worldContext || "[VUOTO]");
    console.log("===================================================\n");

    console.log("\n================ PROMPT FINALE ====================");
    console.log((finalInputText || "").slice(0, 4000));
    console.log("===================================================\n");
    // 6. Streaming LLM
    let fullReply = "";

    const result = await processInput(
      { text: finalInputText, images },
      req.session.user.state,
      history,
      currentMood,
      (chunk) => {
        fullReply += chunk;
        sendEvent({ type: "chunk", text: chunk });
      },
      intentAnalysis
    );

    // 7. Calcolo metriche finali
    const evalCount = result.raw?.eval_count || 0;
    const evalDuration = result.raw?.eval_duration || 1;
    const tps = (evalCount / (evalDuration / 1_000_000_000)).toFixed(2);
    const totalTokens = (result.raw?.prompt_eval_count || 0) + evalCount;
    const promptTokens = result.raw?.prompt_eval_count || 0;
    const routeMeta = intentAnalysis?.domainRoute
      ? {
          baseIntent: intentAnalysis.domainRoute.baseIntent,
          domainIntent: intentAnalysis.domainRoute.domainIntent,
          subdomain: intentAnalysis.domainRoute.subdomain,
          domainSource: intentAnalysis.domainRoute.domainSource,
          responseProfile: intentAnalysis.domainRoute.responseProfile,
          voiceCalibration: intentAnalysis.domainRoute.voiceCalibration,
          confidence: intentAnalysis.domainRoute.confidence,
          signals: intentAnalysis.domainRoute.signals,
          contextLift: intentAnalysis.domainRoute.contextLift
        }
      : null;

    const finalMeta = {
      tokenUsed: totalTokens,
      tokenLimit: 10000,
      promptTokens,
      speed: tps,
      blocked: totalTokens >= 10000,
      route: routeMeta
    };

    // 8. Salva assistant turn
    const saved = await appendTurn(userId, {
      role: "assistant",
      text: result.reply,
      traffic: "yellow",
      confidence: 0.5,
      card: result.card ?? null,
      intent: intentAnalysis?.refinedIntent?.primaryIntent || null,
      domain: intentAnalysis?.refinedIntent?.primaryDomain || null,
      shortMemorySummary: intentAnalysis?.shortMemory?.summary || "",
      meta: finalMeta
    });

    if (req.session.user.state.memoryContext) {
      req.session.user.state.memoryContext = null;
    }

    // 9. Evento finale DONE
    sendEvent({
      type: "done",
      reply: result.reply,
      ts: saved.ts,
      mood: primaryMood,
      card: result.card ?? null,
      meta: finalMeta
    });

    console.log(`[STREAMING] Completato. Speed: ${tps} tps`);
    return res.end();
  } catch (err) {
    console.error("ERRORE NELLA ROTTA CHAT STREAMING:", err);
    sendEvent({
      type: "error",
      message: "Errore nel flusso neurale."
    });
    return res.end();
  }
});
//Backup api/chat 29/03/2026
/*
app.post("/api/chat", isAuthenticated, async (req, res) => {
  // Configurazione SSE
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");

  const sendEvent = (obj) => {
    try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } 
    catch (e) { console.error("SSE write error:", e); }
  };
  sendEvent({ type: "chunk", text: " " }); // Uno spazio sveglia il frontend

  const userId = req.session.user.id;
  await ensureConversationSession(userId);

  const { text } = req.body;
  const t = (text || "").trim().toLowerCase();

  // Gestione sessione veloce
  if (t === "init_session" || t === "ping" || t === "session") {
    sendEvent({ type: "done", reply: "ok", card: null, meta: { tokenUsed: 0, tokenLimit: 10000000, blocked: false } });
    return res.end();
  }

  // 1. Salva messaggio utente (immediato)
  await appendTurn(userId, { 
    role: "user", 
    text,
    meta: { tokenUsed: 0, tokenLimit: 10000, blocked: false }
  });

  userAudit(userId, "CHAT_INPUT", { chars: text.length });

  try {
    // --- 🚀 INIEZIONE EMA (IL CUORE EMOTIVO) ---
    const emoData = await ingestEmotion({
      baseDir: process.cwd(),
      userId: userId,
      text: text,
      callLLM: async (prompt) => {
        const response = await fetch("http://localhost:11436/api/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "llama3.2:3b",
            prompt: prompt,
            stream: false,
            options: { temperature: 0.01, num_ctx: 512 }
          })
        });
        const data = await response.json();
        return data.response;
      }
    });

    const currentMood = emoData?.promptEmotion?.mood_line ?? "mood=neutral";
    const primaryMood = currentMood.split('=')[1].split('+')[0];

    console.log(`[STREAMING] Mood rilevato: ${primaryMood}`);

    // 2. Recupero storia per il contesto
    const history = await readLastGreenExchanges(userId, 8);

    // --- 🚀 AVVIO STREAMING LLM ---
    let fullReply = "";
    let finalRawMetadata = null;

    // Chiamiamo processInput (che ora deve gestire il callback onChunk)
    // Se processInput non è ancora pronto per lo stream, chiamiamo gptReplyStream direttamente
    const result = await processInput(
      text,
      req.session.user.state,
      history,
      currentMood,
      (chunk) => {
        fullReply += chunk;
        // Invia il chunk al frontend in tempo reale
        sendEvent({ type: "chunk", text: chunk });
      }
    );

    // Il result conterrà i metadati finali raccolti dopo la chiusura dello stream
    const metaEngine = result.meta || {};
    
    // --- 🚀 CALCOLO PRESTAZIONI FINALI ---
    const evalCount = result.raw?.eval_count || 0;
    const evalDuration = result.raw?.eval_duration || 1;
    const tps = (evalCount / (evalDuration / 1_000_000_000)).toFixed(2);
    
    const totalTokens = (result.raw?.prompt_eval_count || 0) + evalCount;
    const promptTokens = result.raw?.prompt_eval_count || 0;

    const finalMeta = {
      tokenUsed: totalTokens,
      tokenLimit: 10000,
      promptTokens: promptTokens,
      speed: tps, 
      blocked: totalTokens >= 10000
    };

    // 3. Salvataggio assistant nel DB (solo a generazione completata)
    const saved = await appendTurn(userId, {
      role: "assistant",
      text: result.reply, // Testo completo
      traffic: "yellow",
      confidence: 0.5,
      card: result.card ?? null,
      meta: finalMeta
    });

    if (req.session.user.state.memoryContext) {
      req.session.user.state.memoryContext = null;
    }

    // 4. INVIO EVENTO FINALE "DONE"
    // Questo serve al frontend per sapere che lo stream è finito e aggiornare i metadati
    sendEvent({
      type: "done",
      reply: result.reply,
      ts: saved.ts,
      mood: primaryMood, 
      card: result.card ?? null,
      meta: finalMeta 
    });
    
    console.log(`[STREAMING] Completato. Speed: ${tps} tps`);
    res.end();

  } catch (err) {
    console.error("ERRORE NELLA ROTTA CHAT STREAMING:", err);
    sendEvent({ type: "error", message: "Errore nel flusso neurale." });
    res.end();
  }
});

*/
//Route Notizie dal mondo 
app.get("/api/world-brief", isAuthenticated, async (req, res) => {
  try {
    const brief = await readWorldBrief();
    res.json(brief);
  } catch (err) {
    console.error("[WORLD BRIEF] read error:", err);
    res.status(500).json({ ok: false, msg: "Brief del mondo non disponibile." });
  }
});

app.post("/api/world-brief/refresh", isAuthenticated, async (req, res) => {
  try {
    const brief = await buildWorldBrief();
    res.json({
      ok: true,
      generated_at: brief.generated_at,
      counts: brief.counts
    });
  } catch (err) {
    console.error("[WORLD BRIEF] refresh error:", err);
    res.status(500).json({ ok: false, msg: "Errore aggiornamento brief del mondo." });
  }
});
//Api confidence
app.post("/api/set-confidence", isAuthenticated, async (req, res) => {
  const { ts, traffic, confidence } = req.body;
  const userId = req.session.user.id;

  // 1. Carichiamo TUTTA la storia, non solo 200 turni
  const turns = readAllTurns(userId);

  // 2. Aggiorniamo solo il turno che ci interessa
  const updated = [];

  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    if (t.ts !== ts) {
      updated.push(t);
      continue;
    }

    let nextTurn = { ...t, traffic, confidence };
    const pairedUserTurn = nextTurn.role === "assistant" ? turns[i - 1] : null;
    const shadowResult = await saveOrbitaleShadowTurn(userId, nextTurn, pairedUserTurn);

    if (shadowResult.marker) {
      nextTurn = { ...nextTurn, ...shadowResult.marker };
    }

    updated.push(nextTurn);
  }

  const file = convFilePath(userId);

  // 3. Sovrascriviamo il file con la storia completa aggiornata
  fs.writeFileSync(
    file,
    updated.map(t => JSON.stringify(t)).join("\n") + "\n",
    "utf-8"
  );

  console.log(`[CONFIDENCE] Messaggio ${ts} impostato a ${traffic}`);
  res.json({ ok: true });
});


// Endpoint cockpit Memoria Orbitale (read-only)
app.get("/api/orbitale/status", isAuthenticated, async (req, res) => {
  try {
    const { memoryPath, memories, links } = readOrbitaleCockpitData(req);
    const status = buildOrbitaleStatus(memories, links, memoryPath);
    console.log("[orbitale-cockpit] status memories=" + status.memoriesCount + " links=" + status.linksCount);
    res.json(status);
  } catch (err) {
    console.error("[orbitale-cockpit] status error " + (err?.message || err));
    res.json(buildOrbitaleStatus([], [], getOrbitaleCockpitMemoryPath()));
  }
});

app.get("/api/orbitale/graph", isAuthenticated, async (req, res) => {
  try {
    const { memories, links } = readOrbitaleCockpitData(req);
    const nodes = memories.map(normalizeOrbitaleNode);
    const graphLinks = links.map(normalizeOrbitaleLink);
    console.log("[orbitale-cockpit] graph nodes=" + nodes.length + " links=" + graphLinks.length);
    res.json({ ok: true, nodes, links: graphLinks });
  } catch (err) {
    console.error("[orbitale-cockpit] graph error " + (err?.message || err));
    res.json({ ok: true, nodes: [], links: [] });
  }
});

// Endpoint per leggere lo storico (protetto)
app.get("/api/history", isAuthenticated, async (req, res) => {
  const userId = req.session.user.id;
  const limit = Number(req.query.limit || 30);
  const turns = await readLastTurns(userId, limit);
  res.json({ userId, turns });
});


// Endpoint per cercare nello storico (protetto)
app.get("/api/history/search", isAuthenticated, async (req, res) => {
  const userId = req.session.user.id;
  const q = String(req.query.q || "");
  const limit = Number(req.query.limit || 30);
  const hits = await searchTurns(userId, q, limit);
  res.json({ userId, q, hits });
});

function extractGoogleNewsRealUrl(html) {
  // data-n-au (molto comune)
  let match = html.match(/data-n-au="(https?:\/\/[^"]+)"/i);
  if (match) return match[1];

  // fallback: primo link esterno
  match = html.match(/<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>/i);
  if (match && !match[1].includes("news.google.com")) {
    return match[1];
  }

  return null;
}

function resolveGoogleNewsArticleUrl(rssUrl) {
  if (!rssUrl.includes("/rss/articles/")) return rssUrl;
  return rssUrl.replace("/rss/articles/", "/articles/");
}

app.post('/api/generate-image', async (req, res) => {
    // Riceviamo i nuovi parametri: refine (boolean) e ratio (1:1, 16:9, etc.)
    const { prompt, visionType, refine, ratio } = req.body; 
    const comfyUrl = "http://localhost:8188";

    try {
        console.log(`[VISION] Richiesta: ${visionType || 'Manuale'} | Refine: ${refine} | Ratio: ${ratio}`);

        // 1. ESPANSIONE PROMPT (Solo se richiesto, sulla 5090)
        let finalPrompt = prompt;
        if (refine) {
            console.log("🧠 [AI REFINER] Espansione in corso...");
            finalPrompt = await callLlamaForVision(prompt, visionType || 'cognitiva');
        }
        console.log(`[VISION] Prompt Finale: ${finalPrompt.substring(0, 50)}...`);

        // 2. CARICAMENTO E MODIFICA WORKFLOW
        const workflowPath = path.join(__dirname, 'workflow_api.json');
        let workflow = JSON.parse(fs.readFileSync(workflowPath, 'utf8'));

        // --- 🚀 FIX ASPECT RATIO ---
       // --- 🚀 UPGRADE QUALITÀ ASPECT RATIO (Ottimizzato per Flux su 3090) ---
        const sizes = {
            "1:1":  { w: 1024, h: 1024 }, // Classico Quadrato (1.0 MP)
            "16:9": { w: 1344, h: 768  }, // Cinema HD (Look molto più nitido)
            "9:16": { w: 768,  h: 1344 }, // Mobile/TikTok verticale
            "21:9": { w: 1536, h: 640  }  // Ultra-Wide (Per paesaggi epici)
        };
                const targetSize = sizes[ratio] || sizes["1:1"];

       let foundSizeNode = false;

        // Cerchiamo il nodo giusto analizzando gli inputs
        for (const id in workflow) {
            const node = workflow[id];
            // Se il nodo ha sia width che height tra gli inputs, è quello che cerchiamo!
            if (node.inputs && node.inputs.width !== undefined && node.inputs.height !== undefined) {
                console.log(`🎯 [MATCH] Trovato nodo dimensioni: ID ${id} (${node.class_type})`);
                node.inputs.width = targetSize.w;
                node.inputs.height = targetSize.h;
                foundSizeNode = true;
                // Non ci fermiamo al primo, alcuni workflow complessi ne hanno due (es. per il VAE)
            }
        }

        if (!foundSizeNode) {
            console.error("❌ [ERRORE] Nessun nodo con width/height trovato nel JSON del workflow!");
        }

        // Inseriamo il testo (Nodo 2) e il Seed (Nodo 4)
        if (workflow["2"]) workflow["2"].inputs.text = finalPrompt;
        if (workflow["4"]) workflow["4"].inputs.seed = Math.floor(Math.random() * 1000000000000);

        // 3. INVIO A COMFYUI (3090)
        const response = await axios.post(`${comfyUrl}/prompt`, { prompt: workflow });
        const promptId = response.data.prompt_id;

        // 4. POLLING (Attesa immagine)
        let completed = false;
        let fileName = "";
        while (!completed) {
            await new Promise(r => setTimeout(r, 1000));
            const history = await axios.get(`${comfyUrl}/history/${promptId}`);
            if (history.data[promptId]) {
                // Nodo 6 è SaveImage
                fileName = history.data[promptId].outputs["6"].images[0].filename;
                completed = true;
            }
        }

        res.json({ ok: true, url: `/output/${fileName}`, expandedPrompt: finalPrompt });

    } catch (error) {
        console.error("Errore Vision Station:", error.message);
        res.status(500).json({ ok: false, msg: "Errore durante la generazione." });
    }
});
app.use('/output', express.static('/home/elena/Aiden/Progetti/Reranker/output'));

// Endpoint per i promemoria attivi (protetto)
app.get("/api/reminders", isAuthenticated, async (req, res) => {
  const userId = req.session.user.id;
  const reminders = getReminders(userId);
  // Restituiamo solo quelli NON cancellati
  const visible = reminders.filter(r => r.status !== "dismissed");
  res.json({ userId, reminders: visible });
});

// --- DEEP READER API (Scraper + Summarizer su GPU 3090) ---
// --- DEEP READER API (Scraper Potenziato Anti-Blocco) ---
// --- DECODER URL GOOGLE NEWS (Versione Base64 Hack) ---
function decodeGoogleNewsUrl(sourceUrl) {
  try {
    const url = new URL(sourceUrl);
    const path = url.pathname.split('/');
    
    // Cerca la parte lunga e strana nell'URL (es. CBMi...)
    // Di solito è l'ultimo pezzo o quello dopo "articles"
    let base64Part = path[path.length - 1];
    
    if (base64Part.length < 20) return sourceUrl; // Troppo corto per essere criptato

    // Pulizia Base64 (Google usa _ e - invece di / e +)
    let b64 = base64Part.replace(/-/g, '+').replace(/_/g, '/');
    
    // Padding
    while (b64.length % 4) b64 += '=';

    // Decodifica
    const decoded = Buffer.from(b64, 'base64').toString('latin1'); // Usa latin1 per mantenere i byte grezzi

    // Cerca URL http/https dentro la stringa decodata
    // La stringa decodata contiene caratteri spazzatura + l'URL vero in mezzo
    const urlMatch = decoded.match(/(https?:\/\/[^\s\x00-\x1F\x7F]+)/);
    
    if (urlMatch && urlMatch[0]) {
        console.log(`🔓 DECODED: ${urlMatch[0]}`);
        return urlMatch[0];
    }

    return sourceUrl;
  } catch (e) {
    console.error("Decode Error:", e.message);
    return sourceUrl;
  }
}

// --- DEEP READER API (Decoder + Scraper + AI) ---
// --- DEEP READER API AGGIORNATA (Con estrazione Immagine Reale) ---
app.post("/api/deep-read", isAuthenticated, async (req, res) => {
  let { url } = req.body;
  if (!url) return res.json({ ok: false, error: "URL mancante" });

  console.log(`📖 [READER] Input: ${url}`);

  try {
    // 1. TENTATIVO DI DECODIFICA LOCALE
    const decodedUrl = decodeGoogleNewsUrl(url);
    if (decodedUrl !== url) {
        console.log(`🔓 URL Decodificato: ${decodedUrl}`);
        url = decodedUrl;
    }

    // 2. SCARICA LA PAGINA
    const response = await fetch(url, {
      redirect: 'follow',
      headers: { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7'
      },
      timeout: 10000 
    });
    
    const finalUrl = response.url;
    let html = await response.text();
     
    // --- 🚀 SCUDO 1: PULIZIA CODICE (Aggiunto per stabilità monitor) ---
    // Eliminiamo solo i blocchi script e style che "sporcano" la memoria della GPU
    html = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
               .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "");
    console.log(`🔗 Atterrato su: ${finalUrl}`);

    // 3. GESTIONE REDIRECT GOOGLE NEWS
    if (finalUrl.includes("news.google.com") || finalUrl.includes("consent.google.com")) {
        console.warn("⚠️ Muro di Google rilevato. Cerco via di fuga...");
        const linkMatch = html.match(/<a[^>]+href="([^"]+)"[^>]*>(?!.*google).+?<\/a>/i) || 
                          html.match(/<a[^>]+href="([^"]+)"[^>]*>here<\/a>/i) ||
                          html.match(/window\.location\.replace\("([^"]+)"\)/);

        if (linkMatch && linkMatch[1]) {
            let realUrl = linkMatch[1].replace(/\\x3d/g, "=").replace(/\\x26/g, "&");
            console.log(`🚀 Trovato link di scampo: ${realUrl}`);
            const realRes = await fetch(realUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36' }
            });
            html = await realRes.text();
        } else {
            throw new Error("Contenuto protetto da Google News.");
        }
    }

    // --- 🚀 FIX: ESTRAZIONE IMMAGINE ORIGINALE (Subito dopo aver ottenuto l'HTML finale) ---
    console.log("📸 [READER] Estrazione immagine originale...");
    let articleImage = null;

    // Prova con Open Graph o Twitter Card (le immagini scelte dai giornalisti per i social)
    const ogMatch = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i) ||
                    html.match(/<meta[^>]+name="twitter:image"[^>]+content="([^"]+)"/i);
    
    if (ogMatch && ogMatch[1]) {
        articleImage = ogMatch[1];
    } else {
        // Fallback: se non ci sono meta tag, prendiamo la prima immagine nel corpo
        const imgMatch = html.match(/<img[^>]+src="([^"]+)"/i);
        if (imgMatch && imgMatch[1]) {
            articleImage = imgMatch[1];
        }
    }

    // Se l'URL dell'immagine è relativo, lo rendiamo assoluto usando l'URL dell'articolo
    if (articleImage && !articleImage.startsWith('http')) {
        try {
            const urlObj = new URL(finalUrl);
            articleImage = urlObj.origin + (articleImage.startsWith('/') ? '' : '/') + articleImage;
        } catch(e) { articleImage = null; }
    }
    console.log(`🖼️ Immagine trovata: ${articleImage || "Nessuna"}`);
    // --------------------------------------------------------------------------------------

    // 4. ESTRAZIONE E PULIZIA TESTO
    let articleText = "";
    const pMatches = html.match(/<p[^>]*>([\s\S]*?)<\/p>/gim);
    if (pMatches) {
        articleText = pMatches
            .map(p => p.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim())
            .filter(t => t.length > 50)
            .join("\n\n");
    }

    if (articleText.length < 200) {
        articleText = html.replace(/<[^>]+>/g, " ").trim();
    }

    const truncatedText = articleText.substring(0, 4000);

    // 5. INFERENZA AI (GPU 3090 - Porta 11435)
    const prompt = `Sei un assistente editoriale esperto. Riassumi il testo seguente in italiano chiaro, preciso e fedele. ... ${truncatedText} ... RISPOSTA HTML:`;

    const ollamaRes = await fetch("http://localhost:11435/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "llama3:8b", 
        prompt: prompt,
        stream: false,
        options: { num_ctx: 2048, temperature: 0.3 }
      })
    });
    
    const data = await ollamaRes.json();

    // 6. RISPOSTA AL FRONTEND CON IMMAGINE
    res.json({ 
        ok: true, 
        summary: data.response, 
        articleImage: articleImage // <--- Aggiunta qui!
    });

  } catch (e) {
    console.error("READER ERROR:", e.message);
    res.json({ ok: false, error: "Impossibile estrarre il testo dall'articolo." });
  }




// --- FACT CHECKER API ---Ricerca Fattibilita Fonti
app.post("/api/fact-check", isAuthenticated, async (req, res) => {
  const { title, originalSummary } = req.body;
  if (!title) return res.json({ ok: false, error: "Titolo mancante" });

  console.log(`🔍 [FACT-CHECK] Analisi in corso per: ${title}`);

  try {
    // 1. Cerchiamo notizie simili su Google News (utilizziamo il tuo sistema di ricerca)
    const searchQuery = encodeURIComponent(title);
    const searchUrl = `https://news.google.com/search?q=${searchQuery}&hl=it&gl=IT&ceid=IT%3Ait`;
    
    const response = await fetch(searchUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36' }
    });
    const html = await response.text();

    // 2. Estraiamo i titoli delle altre testate (Cross-Sampling)
    const otherTitlesMatch = html.match(/<a[^>]+class="WwrGf"[^>]*>([\s\S]*?)<\/a>/g) || [];
    const crossSources = otherTitlesMatch
      .slice(0, 5) // Prendiamo i primi 5 risultati diversi
      .map(t => t.replace(/<[^>]+>/g, "").trim());

    // 3. Chiediamo a Llama di confrontare le versioni (Porta 11435 sulla 3090)
    const comparisonPrompt = `
      Sei un Analista Fact-Checker di Intelligence.
      NOTIZIA ORIGINALE: "${title}"
      RIASSUNTO ATTUALE: "${originalSummary.substring(0, 500)}..."
      ALTRE FONTI TROVATE:
      ${crossSources.join("\n")}

      COMPITO:
      1. Verifica se le altre fonti confermano la notizia originale.
      2. Segnala eventuali discrepanze o dettagli aggiuntivi importanti.
      3. Dai un punteggio di "Affidabilità Cross-Source" (da 1 a 10).

      RISPOSTA BREVE IN ITALIANO (Usa grassetto per i punti chiave):`;

    const ollamaRes = await fetch("http://localhost:11435/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "llama3:8b",
        prompt: comparisonPrompt,
        stream: false
      })
    });

    const data = await ollamaRes.json();
    res.json({ ok: true, report: data.response });

  } catch (e) {
    console.error("FACT-CHECK ERROR:", e.message);
    res.json({ ok: false, error: "Impossibile verificare la notizia." });
  }
});});

// Endpoint per l'upload (protetto)
app.post("/api/upload", isAuthenticated, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, msg: "Nessun file inviato" });
    }

    const userId = req.session.user.id;
    const userFilesDir = path.join(process.cwd(), "storage", "users", userId, "files");

    if (!fs.existsSync(userFilesDir)) {
      fs.mkdirSync(userFilesDir, { recursive: true });
    }

    const fileName = req.file.originalname;
    const filePath = path.resolve(userFilesDir, fileName);
    fs.writeFileSync(filePath, req.file.buffer);

    const mime = req.file.mimetype || "";
    const lowerName = fileName.toLowerCase();
    const isImage = mime.startsWith("image/");

    // =========================
    // CASO 1: IMMAGINI
    // =========================
    if (isImage) {
      console.log(`🖼️ [UPLOAD-IMAGE] ${fileName} salvata correttamente`);

      return res.json({
        ok: true,
        message: "Immagine caricata con successo!",
        fileName,
        filePath,
        mime
      });
    }

    // =========================
    // CASO 2: DOCUMENTI / FILE TESTUALI
    // =========================
    let extractedText = "";

    if (lowerName.endsWith(".pdf")) {
      const data = await pdf(req.file.buffer);
      extractedText = data?.text || "";
    } else {
      extractedText = req.file.buffer.toString("utf-8");
    }

    if (!extractedText.trim()) {
      extractedText = "[Nessun testo estratto]";
    }

    // Salvataggio versione per Reranker
    const txtPath = path.join(
      userFilesDir,
      fileName.replace(/\.[^/.]+$/, "") + ".rerank"
    );
    fs.writeFileSync(txtPath, extractedText);

    console.log(`🧠 [AI-LLAMA] Analisi rapida di: ${fileName}`);

    let metaData = {
      summary: "Sintesi non disponibile.",
      tags: ["Documento"]
    };

    try {
      const aiRes = await fetch("http://localhost:11435/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "llama3:8b",
          prompt: `Analizza questo testo e rispondi ESCLUSIVAMENTE con un oggetto JSON.
Struttura richiesta: {"summary": "riassunto di max 12 parole", "tags": ["tag1", "tag2", "tag3"]}

TESTO: ${extractedText.substring(0, 1200)}`,
          stream: false,
          format: "json"
        })
      });

      if (!aiRes.ok) {
        throw new Error("Llama offline sulla 11435");
      }

      const aiData = await aiRes.json();

      if (aiData.response) {
        const cleanJson = aiData.response
          .replace(/```json/g, "")
          .replace(/```/g, "")
          .trim();

        const parsed = JSON.parse(cleanJson);

        metaData.summary = parsed.summary || "Sintesi completata.";
        metaData.tags = Array.isArray(parsed.tags) ? parsed.tags : ["Analisi"];

        console.log(`✅ [AI-SUCCESS] ${fileName}: ${metaData.summary}`);
      }
    } catch (e) {
      console.error(`⚠️ Analisi Llama fallita per ${fileName}:`, e.message);

      metaData.summary = "Documento pronto per l'analisi profonda.";
      metaData.tags = [fileName.split(".").pop().toUpperCase(), "Sandbox"];
    }

    // Salvataggio metadati
    const metaPath = path.join(
      userFilesDir,
      fileName.replace(/\.[^/.]+$/, "") + ".meta"
    );
    fs.writeFileSync(metaPath, JSON.stringify(metaData));

    return res.json({
      ok: true,
      message: "File analizzato con successo!",
      fileName,
      filePath,
      mime
    });
  } catch (err) {
    console.error("Errore durante l'upload:", err);
    return res.status(500).json({ ok: false, msg: "Errore durante l'upload." });
  }
});
//App post per la funzione diario di Keblo Promp nel file llm_router.js
//const DIARY_FILE = path.join(__dirname, 'diary_data.json');//File di salvataggio history Diario
/* --- KEBLO DIARIO: LOGICA MULTI-UTENTE --- */

app.post("/api/diary-chat", isAuthenticated, async (req, res) => {
  const { text } = req.body;
  if (!text) return res.json({ error: "No text" });

  const userId = req.session.user.id;
  
  // 1. PERCORSO FILE DINAMICO (SPECIFICO PER UTENTE)
  // Usiamo la cartella storage/users/ID_UTENTE che hai già creato per i file upload
  const userDir = path.join(process.cwd(), "storage", "users", userId);
  if (!fs.existsSync(userDir)) fs.mkdirSync(userDir, { recursive: true });
  
  const userDiaryFile = path.join(userDir, "diary.json");

  try {
    // 2. RECUPERA STORIA DELL'UTENTE
    let history = [];
    if (fs.existsSync(userDiaryFile)) {
      history = JSON.parse(fs.readFileSync(userDiaryFile, 'utf8'));
    }

    // 3. CONTESTO (Uguale a prima)
    // Prendi i 5 più recenti e girali per l'ordine cronologico corretto nel prompt
    const recentHistory = history.slice(0, 5).reverse(); 
    const contextString = recentHistory.map(entry => 
      `[${new Date(entry.date).toLocaleString()}] Utente: ${entry.user}\nDiario: ${entry.ai}`
    ).join("\n\n");

    // 4. CHIAMATA A OLLAMA
    const aiResponse = await gptDiaryReply(text, contextString);

    // 5. SALVATAGGIO PRIVATO
    const newEntry = {
      id: Date.now(),
      date: new Date().toISOString(),
      user: text,
      ai: aiResponse
    };

    history.unshift(newEntry); // Metti in cima (più recente)
    fs.writeFileSync(userDiaryFile, JSON.stringify(history, null, 2));

    res.json({ ok: true, reply: aiResponse, entry: newEntry });

  } catch (e) {
    console.error("Diary Error:", e);
    res.status(500).json({ error: "Errore elaborazione diario" });
  }
});
// --- SCRATCHPAD API (Note persistenti lato server) ---

// SALVA NOTE (Aggiornata per Multi-Pagina)
app.post("/api/scratchpad", isAuthenticated, (req, res) => {
  const { pages } = req.body; // Riceviamo l'intero array di pagine
  const userId = req.session.user.id;
  const userDir = path.join(process.cwd(), "storage", "users", userId);
  if (!fs.existsSync(userDir)) fs.mkdirSync(userDir, { recursive: true });
  const padFile = path.join(userDir, "scratchpad.json");

  try {
    fs.writeFileSync(padFile, JSON.stringify({ pages: pages || [], lastUpdate: new Date() }));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false });
  }
});

// LEGGI NOTE (Aggiornata per Multi-Pagina)
app.get("/api/scratchpad", isAuthenticated, (req, res) => {
  const userId = req.session.user.id;
  const padFile = path.join(process.cwd(), "storage", "users", userId, "scratchpad.json");
  
  try {
    if (fs.existsSync(padFile)) {
      const data = JSON.parse(fs.readFileSync(padFile, 'utf8'));

      // 🔍 CONTROLLO RECUPERO: Se c'è il vecchio campo 'text' ma non ci sono 'pages'
      if (data.text && (!data.pages || data.pages.length === 0)) {
        console.log("💾 Recupero appunti storici in corso...");
        return res.json({ 
          pages: [{ id: 'legacy', title: 'VECCHI APPUNTI', content: data.text }] 
        });
      }

      // Se il formato è già quello nuovo a pagine
      res.json({ pages: data.pages || [] });
    } else {
      res.json({ pages: [] });
    }
  } catch (e) {
    res.json({ pages: [] });
  }
});


// Endpoint per leggere la storia all'apertura (DEVI AGGIUNGERE QUESTO SE MANCA)
app.get("/api/diary-history", isAuthenticated, (req, res) => {
  const userId = req.session.user.id;
  const userDiaryFile = path.join(process.cwd(), "storage", "users", userId, "diary.json");
  
  if (!fs.existsSync(userDiaryFile)) {
    return res.json([]);
  }
  
  try {
    const data = JSON.parse(fs.readFileSync(userDiaryFile, 'utf8'));
    res.json(data);
  } catch(e) {
    res.json([]);
  }
});
// Endpoint per eliminare un file (protetto)
app.delete("/api/delete-file", isAuthenticated, (req, res) => {
  const { fileName } = req.body;
  const userId = req.session.user.id;
  const userFilesDir = path.join(process.cwd(), "storage", "users", userId, "files");
  try {
    const filePath = path.join(userFilesDir, fileName);
    const txtPath = path.join(userFilesDir, fileName.replace(/\.[^/.]+$/, "") + ".txt");
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    if (fs.existsSync(txtPath)) fs.unlinkSync(txtPath);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, msg: "Errore eliminazione" });
  }
});

// Endpoint per la lista file dell'utente (protetto)
// --- FIX: ROTTA RECUPERO LISTA FILE ---
app.get("/api/user-files", isAuthenticated, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const userFilesDir = path.join(process.cwd(), "storage", "users", userId, "files");
    if (!fs.existsSync(userFilesDir)) return res.json({ ok: true, files: [] });

    // Leggiamo tutti i file originali (non .rerank e non .meta)
    const rawFiles = fs.readdirSync(userFilesDir).filter(f => !f.endsWith(".rerank") && !f.endsWith(".meta"));

    // Per ogni file, cerchiamo se esiste il suo .meta
    const filesWithMeta = rawFiles.map(name => {
      const metaPath = path.join(userFilesDir, name.replace(/\.[^/.]+$/, "") + ".meta");
      let info = { summary: "In attesa di analisi...", tags: [] };
      if (fs.existsSync(metaPath)) {
        info = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
      }
      return { name, ...info };
    });

    res.json({ ok: true, files: filesWithMeta });
  } catch (err) {
    res.json({ ok: false, files: [] });
  }
});
// --- API: ESPORTA ANALISI NELLO SCRATCHPAD ---
app.post("/api/export-to-scratchpad", isAuthenticated, async (req, res) => {
  try {
    const { title, content } = req.body;
    const userId = req.session.user.id;
    const scratchPath = path.join(process.cwd(), "storage", "users", userId, "scratchpad.json");

    let data = { pages: [] };
    if (fs.existsSync(scratchPath)) {
      data = JSON.parse(fs.readFileSync(scratchPath, "utf-8"));
    }

    // Creiamo la nuova pagina con l'analisi
    const newPage = {
      id: "pg_" + Date.now(),
      title: title || "Analisi Intelligence",
      content: content
    };

    data.pages.push(newPage);
    fs.writeFileSync(scratchPath, JSON.stringify(data, null, 2));

    res.json({ ok: true, msg: "Analisi salvata nello Scratchpad!" });
  } catch (e) {
    res.json({ ok: false, msg: "Errore durante il salvataggio." });
  }
});
// --- ENDPOINT RSS PROXY ---
app.post("/api/fetch-rss", isAuthenticated, async (req, res) => {
  const { topic } = req.body;
  if (!topic) return res.json({ error: "No topic" });

  try {
    // Usiamo Google News RSS perché è affidabile e gratuito
    // hl=it&gl=IT&ceid=IT:it forza le notizie in Italiano
    // Byapassiamo RSS Google const url = `https://news.google.com/rss/search?q=${encodeURIComponent(topic)}&hl=it&gl=IT&ceid=IT:it`;
    const url = `https://www.bing.com/news/search?q=${encodeURIComponent(topic)}&format=rss&setlang=it-IT`;

    const response = await fetch(url);
    const xmlText = await response.text();
    
    // Mandiamo l'XML grezzo al client, che lo parserà facilmente
    res.send(xmlText); 
  } catch (e) {
    console.error("RSS Error:", e);
    res.status(500).send("Error fetching RSS");
  }
});

// Endpoint Ricerca Semantica in Streaming per la Card (protetto)
app.post("/api/card-search-stream", isAuthenticated, async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");

  const sendEvent = (obj) => {
    try {
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    } catch (e) {
      console.error("SSE write error:", e.message);
    }
  };

  let clientClosed = false;
  req.on("close", () => {
    clientClosed = true;
    console.log("🛑 Client disconnected from /api/card-search-stream");
  });

  try {
    const { fileNames, query, cardId } = req.body;
    const userId = req.session.user.id;

    if (!Array.isArray(fileNames) || fileNames.length === 0) {
      sendEvent({ error: "Nessun file selezionato." });
      return res.end();
    }

    if (!query || !String(query).trim()) {
      sendEvent({ error: "Query vuota." });
      return res.end();
    }

    // =========================================================================
    // HELPERS
    // =========================================================================

    function escapeRegExp(str = "") {
      return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    function normalizeText(str = "") {
      return String(str)
        .replace(/\r/g, "\n")
        .replace(/[ \t]+/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    }

    function tokenize(str = "") {
      return normalizeText(str)
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .split(/\s+/)
        .filter(Boolean);
    }

    function uniqueById(items = []) {
      const seen = new Set();
      const out = [];
      for (const item of items) {
        if (!item || !item.id || seen.has(item.id)) continue;
        seen.add(item.id);
        out.push(item);
      }
      return out;
    }

    function chunkTextTechnical(text, chunkSize = 700, overlap = 180) {
      const clean = normalizeText(text);
      const chunks = [];
      let start = 0;

      while (start < clean.length) {
        let end = Math.min(start + chunkSize, clean.length);
        let chunk = clean.slice(start, end);

        if (end < clean.length) {
          const candidates = [
            chunk.lastIndexOf("\n\n"),
            chunk.lastIndexOf(". "),
            chunk.lastIndexOf(": "),
            chunk.lastIndexOf("; "),
            chunk.lastIndexOf("\n"),
            chunk.lastIndexOf(" ")
          ];
          const breakAt = Math.max(...candidates);

          if (breakAt > chunkSize * 0.55) {
            chunk = chunk.slice(0, breakAt + 1);
            end = start + breakAt + 1;
          }
        }

        if (chunk.trim()) chunks.push(chunk.trim());
        if (end >= clean.length) break;

        start = Math.max(end - overlap, start + 1);
      }

      return chunks;
    }

    function splitIntoPseudoPages(rawText) {
      const text = normalizeText(rawText);

      const explicitPages = text.split(/\[\s*PAGE\s*:\s*\d+\s*\]/i);
      if (explicitPages.length > 1) {
        return explicitPages
          .map((p, i) => ({ pageNum: i + 1, text: p.trim() }))
          .filter(p => p.text);
      }

      const approxPageSize = 3500;
      const pages = [];
      let i = 0;
      let pageNum = 1;

      while (i < text.length) {
        const slice = text.slice(i, i + approxPageSize);
        pages.push({ pageNum, text: slice.trim() });
        i += approxPageSize;
        pageNum++;
      }

      return pages;
    }

    function detectSections(text = "") {
      const t = text.toLowerCase();
      const sections = [];

      if (t.includes("codice di riferimento guasti")) sections.push("fault_codes");
      if (t.includes("risoluzione dei problemi")) sections.push("troubleshooting");
      if (t.includes("indicatore di avviso")) sections.push("warnings");
      if (t.includes("display lcd")) sections.push("lcd");
      if (t.includes("impostazione lcd")) sections.push("settings");
      if (t.includes("appendice")) sections.push("appendix");
      if (t.includes("comunicazione bms")) sections.push("bms");
      if (t.includes("tabella")) sections.push("table");

      return sections;
    }

    function extractTechnicalSignals(rawQuery = "") {
      const q = String(rawQuery).trim();
      const qLower = q.toLowerCase();

      const errorMatch =
        qLower.match(/\b(?:errore|codice|code|fault|warning|avviso)\s*[:#-]?\s*0?(\d{1,3})\b/i) ||
        qLower.match(/\bf\s*0?(\d{1,3})\b/i);

      const plainNumberMatches = [...qLower.matchAll(/\b(\d{1,3})\b/g)].map(m => m[1]);

      const signals = {
        original: q,
        normalized: qLower,
        tokens: tokenize(q),
        explicitErrorCode: errorMatch ? String(parseInt(errorMatch[1], 10)) : null,
        numbers: [...new Set(plainNumberMatches.map(n => String(parseInt(n, 10))))],
        wantsTable: /tabella|table|riga|colonna|manuale|pdf/i.test(qLower),
        wantsTroubleshooting: /risoluzione|troubleshooting|causa|perché|motivo|guasto/i.test(qLower),
        wantsWarnings: /warning|avviso|allarme/i.test(qLower),
        terms: []
      };

      const technicalTerms = [
        "bus", "batteria", "bms", "inverter", "tensione", "corrente",
        "uscita", "ingresso", "sovratensione", "sottotensione",
        "sovracorrente", "carica", "scarica", "fault", "warning",
        "display", "guasto", "allarme", "troubleshooting"
      ];

      for (const term of technicalTerms) {
        if (qLower.includes(term)) signals.terms.push(term);
      }

      return signals;
    }

    function lexicalScore(docText = "", signals) {
      const t = docText.toLowerCase();
      let score = 0;

      if (signals.explicitErrorCode) {
        const code = escapeRegExp(signals.explicitErrorCode);

        if (new RegExp(`codice\\s+errore\\s+0?${code}\\b`, "i").test(t)) score += 120;
        if (new RegExp(`errore\\s+0?${code}\\b`, "i").test(t)) score += 90;
        if (new RegExp(`codice\\s+0?${code}\\b`, "i").test(t)) score += 80;
        if (new RegExp(`\\bf\\s*0?${code}\\b`, "i").test(t)) score += 70;
        if (new RegExp(`\\b0?${code}\\b`, "i").test(t)) score += 40;
      }

      for (const n of signals.numbers) {
        if (!n) continue;
        if (new RegExp(`\\b${escapeRegExp(n)}\\b`).test(t)) score += 8;
      }

      for (const term of signals.terms) {
        if (t.includes(term)) score += 10;
      }

      if (t.includes("codice di riferimento guasti")) score += 35;
      if (t.includes("risoluzione dei problemi")) score += 35;
      if (t.includes("indicatore di avviso")) score += 25;
      if (t.includes("tabella")) score += 10;

      return score;
    }

    function sectionBoost(sections = [], signals) {
      let score = 0;

      if (sections.includes("fault_codes")) score += 20;
      if (sections.includes("troubleshooting")) score += 20;
      if (sections.includes("warnings")) score += 10;
      if (sections.includes("table")) score += 5;

      if (signals.wantsTroubleshooting && sections.includes("troubleshooting")) score += 20;
      if (signals.wantsWarnings && sections.includes("warnings")) score += 20;
      if (signals.wantsTable && sections.includes("table")) score += 10;

      return score;
    }

    function hybridMerge(exactHits, lexicalHits, rerankedHits, topLimit = 10) {
      const byId = new Map();

      const pushOrMerge = (item, source, baseScore = 0) => {
        if (!item || !item.id) return;

        if (!byId.has(item.id)) {
          byId.set(item.id, {
            ...item,
            sources: [source],
            fusionScore: baseScore
          });
          return;
        }

        const prev = byId.get(item.id);
        prev.sources = [...new Set([...prev.sources, source])];
        prev.fusionScore += baseScore;
        if (!prev.text && item.text) prev.text = item.text;
        if (!prev.fileName && item.fileName) prev.fileName = item.fileName;
        if (!prev.pageNum && item.pageNum) prev.pageNum = item.pageNum;
      };

      for (const item of exactHits) pushOrMerge(item, "exact", 120 + (item.exactScore || 0));
      for (const item of lexicalHits) pushOrMerge(item, "lexical", 70 + (item.lexicalScore || 0));
      for (const item of rerankedHits) {
        const score = typeof item.score === "number" ? item.score * 100 : 40;
        pushOrMerge(item, "semantic", score);
      }

      return [...byId.values()]
        .sort((a, b) => b.fusionScore - a.fusionScore)
        .slice(0, topLimit);
    }

    // =========================================================================
    // 1. QUERY ANALYSIS
    // =========================================================================

    const signals = extractTechnicalSignals(query);
    console.log("🧠 QUERY SIGNALS:", signals);

    // =========================================================================
    // 2. LOAD + CHUNK DOCUMENTS
    // =========================================================================

    let allDocs = [];
    let totalRawChars = 0;

    for (const fileName of fileNames) {
      const txtPath = path.join(
        process.cwd(),
        "storage",
        "users",
        userId,
        "files",
        fileName.replace(/\.[^/.]+$/, "") + ".rerank"
      );

      if (!fs.existsSync(txtPath)) continue;

      const rawText = fs.readFileSync(txtPath, "utf-8");
      totalRawChars += rawText.length;

      const pseudoPages = splitIntoPseudoPages(rawText);

      for (const page of pseudoPages) {
        const sections = detectSections(page.text);
        const chunks = chunkTextTechnical(page.text, 700, 180);

        chunks.forEach((chunk, idx) => {
          allDocs.push({
            id: `${fileName}_p${page.pageNum}_c${idx}`,
            fileName,
            pageNum: page.pageNum,
            chunkIndex: idx,
            sections,
            text: `[FILE: ${fileName}] [PAGE: ${page.pageNum}] [CHUNK: ${idx}] ${chunk}`
          });
        });
      }
    }

    if (!allDocs.length) {
      sendEvent({ error: "Nessun contenuto disponibile nei file selezionati." });
      return res.end();
    }

    // =========================================================================
    // 3. EXACT + LEXICAL RETRIEVAL
    // =========================================================================

    let exactHits = [];
    let lexicalHits = [];

    if (signals.explicitErrorCode) {
      exactHits = allDocs
        .map(doc => {
          const exactScore = lexicalScore(doc.text, signals) + sectionBoost(doc.sections, signals);
          return { ...doc, exactScore };
        })
        .filter(doc => doc.exactScore >= 100)
        .sort((a, b) => b.exactScore - a.exactScore)
        .slice(0, 12);
    }

    lexicalHits = allDocs
      .map(doc => {
        const lexical = lexicalScore(doc.text, signals);
        const secBoost = sectionBoost(doc.sections, signals);
        return {
          ...doc,
          lexicalScore: lexical + secBoost
        };
      })
      .filter(doc => doc.lexicalScore > 0)
      .sort((a, b) => b.lexicalScore - a.lexicalScore)
      .slice(0, 40);

    // =========================================================================
    // 4. PRE-RANK FOR RERANKER
    // =========================================================================

    const MAX_RERANK_DOCS = 200;

    const preRankedDocs = uniqueById([
      ...exactHits,
      ...lexicalHits,
      ...allDocs
    ])
      .map(doc => {
        const preScore =
          (doc.exactScore || 0) +
          (doc.lexicalScore || 0) +
          sectionBoost(doc.sections, signals);
        return { ...doc, preScore };
      })
      .sort((a, b) => b.preScore - a.preScore);

    const safeDocsFor3090 = preRankedDocs.slice(0, MAX_RERANK_DOCS);

    // =========================================================================
    // 5. SEMANTIC RETRIEVAL + RERANKER
    // =========================================================================

    let rerankedHits = [];
    const rerankQuery = signals.explicitErrorCode
      ? `${query} codice errore ${signals.explicitErrorCode} descrizione ufficiale troubleshooting manuale tabella`
      : query;

    try {
      console.log(`📡 [3090] Reranker su ${safeDocsFor3090.length} frammenti`);
      const ranked = await rerankNews(rerankQuery, safeDocsFor3090);

      rerankedHits = ranked
        .map(r => {
          if (r.text) return r;
          const original = safeDocsFor3090.find(d => d.id === r.id);
          if (!original) return null;
          return {
            ...original,
            score: r.score ?? 0
          };
        })
        .filter(Boolean)
        .slice(0, 20);
    } catch (e) {
      console.error("❌ Reranker failure:", e.message);
      rerankedHits = lexicalHits.slice(0, 10).map(doc => ({
        ...doc,
        score: 0.25
      }));
    }

    // =========================================================================
    // 6. HYBRID FUSION
    // =========================================================================

    const topLimit = signals.explicitErrorCode ? 10 : 8;
    const fusedHits = hybridMerge(exactHits, lexicalHits, rerankedHits, topLimit);

    if (!fusedHits.length) {
      sendEvent({ error: "Nessun frammento rilevante trovato." });
      return res.end();
    }

    const topContext = fusedHits.map((doc, i) => {
      const meta = [
        `RANK=${i + 1}`,
        `FILE=${doc.fileName}`,
        `PAGE=${doc.pageNum}`,
        `FUSION=${Math.round(doc.fusionScore || 0)}`,
        `SRC=${(doc.sources || []).join("+") || "unknown"}`
      ];

      if (typeof doc.exactScore === "number") meta.push(`EXACT=${Math.round(doc.exactScore)}`);
      if (typeof doc.lexicalScore === "number") meta.push(`LEX=${Math.round(doc.lexicalScore)}`);
      if (typeof doc.score === "number") meta.push(`SEM=${doc.score.toFixed(3)}`);
      if (Array.isArray(doc.sections) && doc.sections.length) meta.push(`SEC=${doc.sections.join(",")}`);

      return `[${meta.join(" | ")}]\n${doc.text}`;
    }).join("\n\n---\n\n");

    // =========================================================================
    // 7. PROMPT
    // =========================================================================

    const prompt = `
Sei un analista tecnico specializzato in manuali di inverter, diagnostica e troubleshooting.

DOMANDA UTENTE:
${query}

SEGNALI RILEVATI:
- Codice errore esplicito: ${signals.explicitErrorCode || "nessuno"}
- Focus troubleshooting: ${signals.wantsTroubleshooting ? "sì" : "no"}
- Focus warning: ${signals.wantsWarnings ? "sì" : "no"}
- Focus tabella/manuale: ${signals.wantsTable ? "sì" : "no"}

REGOLE OBBLIGATORIE:
1. Usa SOLO i frammenti forniti.
2. Se compare un codice numerico nei frammenti, NON dire mai che non esiste.
3. Se la domanda riguarda un codice errore o avviso:
   - identifica il codice
   - riporta la descrizione ufficiale
   - indica eventuale voce di troubleshooting collegata
   - indica file e pagina
4. Se trovi informazioni in più punti, uniscile senza inventare.
5. Se c'è incertezza, dillo esplicitamente.
6. Non confondere codici errore, codici warning e numeri di programma LCD.
7. Se una voce numerica nel manuale non è un errore ma un'impostazione, precisalo chiaramente.
8. Rispondi in HTML semplice, leggibile e professionale.
9. Non usare markdown.
10. Non scrivere che “non è presente” se il numero compare nei frammenti.

FORMATO RISPOSTA:
- <h3> per il titolo principale
- <p> per sintesi iniziale
- <ul><li> per dettagli tecnici
- usa <b> per codice, descrizione, file, pagina
- se utile aggiungi <h3>Verifica tecnica</h3>

FRAMMENTI:
${topContext}

RISPOSTA HTML:
`;

    // =========================================================================
    // 8. LLM STREAMING
    // =========================================================================

    const ollamaRes = await fetch("http://localhost:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen3.5:27b",
        prompt,
        stream: true,
        options: {
          num_ctx: 8192,
          temperature: 0.15
        }
      })
    });

    if (!ollamaRes.ok || !ollamaRes.body) {
      throw new Error(`Ollama 5090 non raggiungibile: HTTP ${ollamaRes.status}`);
    }

    const reader = ollamaRes.body.getReader();
    const decoder = new TextDecoder();
    let lineBuffer = "";
    let fullReply = "";
    let evalCount = 0;

    while (true) {
      if (clientClosed) break;

      const { done, value } = await reader.read();
      if (done) break;

      lineBuffer += decoder.decode(value, { stream: true });
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop();

      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const json = JSON.parse(line);

          if (json.response) {
            fullReply += json.response;
            sendEvent({ text: json.response });
          }

          if (typeof json.eval_count === "number") {
            evalCount = json.eval_count;
          }

          if (json.done) break;
        } catch (e) {
          // chunk parziale, ignoriamo
        }
      }
    }

    // =========================================================================
    // 9. LOG + DEBUG
    // =========================================================================

    logIntelEvent(cardId, "Analisi intelligence completata", {
      reranker_gpu: "RTX_3090",
      inference_gpu: "RTX_5090",
      query,
      explicit_error_code: signals.explicitErrorCode,
      selected_files: fileNames.length,
      total_docs: allDocs.length,
      reranker_docs: safeDocsFor3090.length,
      exact_hits: exactHits.length,
      lexical_hits: lexicalHits.length,
      reranked_hits: rerankedHits.length,
      fused_hits: fusedHits.length,
      total_chars: totalRawChars,
      tokens: evalCount
    });

    sendEvent({
      type: "debug_log",
      title: "Analisi intelligence completata",
      payload: {
        explicit_error_code: signals.explicitErrorCode,
        reranker_docs: safeDocsFor3090.length,
        exact_hits: exactHits.length,
        lexical_hits: lexicalHits.length,
        reranked_hits: rerankedHits.length,
        fused_hits: fusedHits.length
      }
    });

    res.end();
  } catch (err) {
    console.error("CRASH /api/card-search-stream:", err);
    sendEvent({ error: err.message });
    res.end();
  }
});
// --- KEBLO READER: PROXY "CHIRURGICO" ---
app.post("/api/proxy-read", isAuthenticated, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.json({ ok: false, error: "URL mancante." });

  try {
    console.log(`[READER] Intercettazione: ${url}`);
    
    // 1. Scarica la pagina fingendosi un browser normale
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });

    if (!response.ok) throw new Error(`Status: ${response.status}`);
    let html = await response.text();

    // 2. LOBOTOMIA: Rimuovi il cervello (Script) e le pubblicità (Iframe/Object)
    html = html.replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gim, ""); // Via JS
    html = html.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gim, "");   // Via CSS originali
    html = html.replace(/<iframe\b[^>]*>([\s\S]*?)<\/iframe>/gim, ""); // Via Banner
    html = html.replace(/<object\b[^>]*>([\s\S]*?)<\/object>/gim, ""); // Via Flash/Media vecchi
    html = html.replace(/on\w+="[^"]*"/g, ""); // Via eventi click pericolosi

    // 3. Estrai solo il body per evitare conflitti
    const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/im);
    const cleanContent = bodyMatch ? bodyMatch[1] : html;

    res.json({ ok: true, html: cleanContent });

  } catch (e) {
    console.error("[READER ERROR]", e.message);
    res.json({ ok: false, error: "Fonte non accessibile o protetta." });
  }
});

// Endpoint per l'inferenza indipendente della Card News (protetto)
app.post("/api/news-inference", isAuthenticated, async (req, res) => {
  const { topic } = req.body;
  if (!topic) return res.status(400).json({ ok: false, content: "Topic mancante." });

  try {
    const newsResults = await getRelevantNews(topic);
        console.log(`1. Notizie trovate: ${newsResults.length}`);
        // RECUPERO IMMAGINI
    await Promise.all(newsResults.map(async (n, i) => {
      n.realImg = await getOgImage(n.url);
      console.log(`   [NOTIZIA ${i+1}] Immagine OG: ${n.realImg ? "TROVATA" : "NULL"}`);
      if (n.realImg) console.log(`   URL: ${n.realImg.substring(0, 60)}...`);
    }));
    

    const context = newsResults.map((n, i) => {
      // Usiamo Pollinations come base sicura perché i siti spesso bloccano le foto
      const fallbackImg = `https://image.pollinations.ai/prompt/high_tech_news_${encodeURIComponent(n.title.substring(0,30))}?width=300&height=300&nologo=true`;
      
      return `--- NOTIZIA ${i + 1} ---
      TITOLO: ${n.title}
      LINK: ${n.url}
      IMG: ${n.realImg || fallbackImg}
      TESTO: ${n.snippet}`;
    }).join("\n\n");

    const prompt = `Sei un analista. Genera un dossier HTML su: ${topic}.
Dati carichi:
${context}

PER OGNI NOTIZIA GENERA QUESTO CODICE:
<div class="news-entry-row">
    <img src="METTI_QUI_IL_LINK_CHE_LEGGI_IN_IMG" class="news-report-img">
    <div class="news-text-column">
        <div class="news-report-h">SCRIVI_IL_TITOLO</div>
        <p class="news-report-p">Riassunto dettagliato di 4-5 righe...</p>
        <a href="METTI_QUI_IL_LINK_CHE_LEGGI_IN_LINK" target="_blank" class="news-report-link">🔗 FONTE</a>
    </div>
</div>

IMPORTANTE: 
- Sostituisci METTI_QUI_IL_LINK... con i link reali che trovi sopra.
- Rispondi SOLO con HTML. Niente Markdown.
RISPONDI IN ITALIANO:`;

    const ollamaRes = await fetch("http://localhost:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen3.5:27b",
        prompt: prompt,
        stream: false,
        options: { num_ctx: 8192, temperature: 0.2 } // Bassissima temperatura = Massima precisione
      })
    });

    const data = await ollamaRes.json();
    res.json({ ok: true, content: data.response });

  } catch (err) {
    res.status(500).json({ ok: false, content: "Errore." });
  }
});
// Endpoint per eliminare un promemoria dall'agenda (protetto)
app.delete("/api/reminders/:id", isAuthenticated, (req, res) => {
  const userId = req.session.user.id;
  const reminderId = req.params.id;

  // Invece di cancellare, lo segniamo come 'dismissed'
  updateReminder(userId, reminderId, { status: "dismissed" });
  
  console.log(`🔕 Reminder ${reminderId} segnato come DISMISSED`);
  res.json({ ok: true });
});

// Endpoint per aggiunta rapida da card (protetto)
app.post("/api/reminders/quick-add", isAuthenticated, async (req, res) => {
  const { text, selectedDate } = req.body; // <--- Riceviamo anche selectedDate
  const userId = req.session.user.id;

  let finalDate;

  // Se il frontend ci manda una data selezionata dal calendario, usiamo quella!
  if (selectedDate) {
    finalDate = new Date(selectedDate);
    // Settiamo un'ora standard (es. le 9 del mattino)
    finalDate.setHours(9, 0, 0, 0);
  } else {
    // Altrimenti usiamo il vecchio metodo del parser testuale
    const parsed = parseDueDate(text);
    if (!parsed || !parsed.date) {
      return res.json({ ok: false, msg: "Data non valida o non capita." });
    }
    finalDate = parsed.date;
  }

  const newRem = {
    id: "r_" + Date.now(),
    userId,
    text: text,
    dueAt: finalDate.toISOString(),
    status: "pending", 
    createdAt: new Date().toISOString()
  };

  addReminder(userId, newRem);
  res.json({ ok: true });
});

// Endpoint per la ricerca semantica avanzata nell'agenda (protetto)
app.get("/api/reminders/search", isAuthenticated, async (req, res) => {
  try {
    const query = String(req.query.q || "").trim().toLowerCase();
    const userId = req.session.user.id;
    
    const all = getReminders(userId).filter(r => r.status !== "dismissed");
    if (all.length === 0) return res.json({ hits: [] });

    // 1. Filtro testuale immediato (se la parola è contenuta, passa subito)
    const literalMatches = all.filter(r => r.text.toLowerCase().includes(query));

    // 2. Chiamata al Reranker per trovare match semantici
    const docs = all.map(r => ({ id: r.id, text: r.text }));
    const ranked = await rerankNews(query, docs);

    // 3. Uniamo i risultati: prendiamo literal match + quelli del reranker con punteggio decente
    const threshold = 0.35; // SOGLIA: sotto il 35% di somiglianza ignoriamo
    
    const hits = ranked
      .map(h => {
        const item = all.find(r => r.id === h.id);
        // Uniamo il punteggio: se è un literal match gli diamo un bonus
        const isLiteral = literalMatches.some(m => m.id === h.id);
        return { ...item, score: isLiteral ? 1.0 : h.score };
      })
      .filter(h => h.score > threshold) // SCARTIAMO la spazzatura (come il tuo 9999)
      .sort((a, b) => b.score - a.score); // I più pertinenti in alto

    console.log(`🔎 [SEARCH] Query: "${query}" | Rilevanti: ${hits.length} (Scartati: ${ranked.length - hits.length})`);
    res.json({ hits });
  } catch (err) {
    console.error("ERRORE RICERCA:", err);
    res.json({ hits: [] });
  }
});

// Endpoint per gli archivi (protetto)
app.get("/api/reminders/archived", isAuthenticated, async (req, res) => {
  const userId = req.session.user.id;
  const reminders = getReminders(userId);
  // Restituiamo solo quelli marchiati come dismissed
  const archived = reminders.filter(r => r.status === "dismissed");
  res.json({ archived });
});
// --- API: MODIFICA IMPEGNO ---

app.put("/api/reminders/:id", isAuthenticated, (req, res) => {
  const userId = req.session.user.id;
  const reminderId = req.params.id;
  const { newText } = req.body;

  if (!newText) return res.json({ ok: false, msg: "Testo mancante" });

  // Utilizziamo la tua funzione di update esistente
  const updated = updateReminder(userId, reminderId, { text: newText });
  
  if (updated) {
    console.log(`📝 [AGENDA] Impegno ${reminderId} aggiornato: ${newText}`);
    res.json({ ok: true });
  } else {
    res.json({ ok: false, msg: "Impegno non trovato" });
  }
});

// Avvia il scheduler
startScheduler();
startWorldBriefScheduler();

const PORT = Number(process.env.PORT || 3002);
app.listen(PORT, () => console.log("Keblo Final running on http://localhost:" + PORT));