// --- 1. GESTIONE IMPORT ---
import express from "express";
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import "dotenv/config";
import session from "express-session";
import { addReminder, getReminders, updateReminder, searchEvents } from "./reminders_repo.js";
import { processInput, initialState } from "./keblo_engine.js";
import { audit, userAudit } from "./custode.js";
import { startScheduler } from "./scheduler.js";
import { getRelevantNews, buildNewsSnippets, cleanNewsQuery, rerankNews } from "./news_pipeline.js";
import { parseDueDate } from "./time_parser.js";
import { ensureConversationSession, appendTurn, readLastTurns, searchTurns, semanticSearchTurns } from "./conversation_repo.js";
import fs from "fs";
import path from "path";
import axios from "axios"; // Usa import, non require!
import multer from "multer";
import { createRequire } from "module";
import { gptReply, gptDiaryReply } from './llm_router.js'; // Assicurati del percorso corretto

// --- AGGIUNGI QUESTO PER RICREARE __dirname ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const storage = multer.memoryStorage();
const upload = multer({ 
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 } // Limite 5MB
})

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

// --- 3. CARICAMENTO LIBRERIE LEGACY ---
const pdf = require("pdf-parse");

// --- 4. CONFIGURAZIONE APP ---
const app = express();
app.use(express.json());
app.use(express.static("public"));

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

// Middleware per proteggere le API
function isAuthenticated(req, res, next) {
  if (req.session.user) return next();
  res.status(401).json({ ok: false, msg: "Accesso negato" });
  console.log(`尝试登录: Utente=${username}, Pass=${password}`); // Log di controllo
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

// --- ROTTE PROTETTE ---
app.post("/api/chat", isAuthenticated, async (req, res) => {
  // Configurazione SSE (Server-Sent Events)
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

  const userId = req.session.user.id;
  await ensureConversationSession(userId);

  const { text } = req.body;
  const rawText = (text || "");
  const t = rawText.trim().toLowerCase();

  // Handshake: non scrive nello storico
  if (t === "init_session" || t === "ping" || t === "session") {
    sendEvent({ type: "done", reply: "ok", card: null, meta: { tokenUsed: 0, tokenLimit: 10000, blocked: false } });
    return res.end();
  }

  // --- 1. PRIORITÀ: ALLARMI E FOLLOW-UP ---
  const reminders = getReminders(userId);

  const fired = reminders.find(r => r.status === "fired" && !r.acknowledged);
  if (fired) {
    updateReminder(userId, fired.id, { acknowledged: true });
    const reply = `⏰ È IL MOMENTO: ${fired.text}`;
    await appendTurn(userId, { 
      role: "assistant", 
      text: reply,
      meta: { tokenUsed: 0, tokenLimit: 10000, blocked: false }
    });
    sendEvent({ 
      type: "done",
      reply, 
      card: { 
        type: "reminder", 
        title: "Ora!", 
        content: fired.text, 
        status: "fired" 
      },
      meta: { tokenUsed: 0, tokenLimit: 10000, blocked: false }
    });
    return res.end();
  }

  const feedback = reminders.find(r => r.followUpReady && !r.feedbackDone);
  if (feedback && !t.includes("si") && !t.includes("sì") && !t.includes("no")) {
    updateReminder(userId, feedback.id, { feedbackDone: true });
    const reply = `💬 Volevo chiederti: com'è andata con "${feedback.text}"?`;
    await appendTurn(userId, { 
      role: "assistant", 
      text: reply,
      meta: { tokenUsed: 0, tokenLimit: 10000, blocked: false }
    });
    sendEvent({ 
      type: "done",
      reply, 
      card: null,
      meta: { tokenUsed: 0, tokenLimit: 10000, blocked: false }
    });
    return res.end();
  }

  const emerging = reminders.find(
    r => r.status === "pending" && 
         r.notifiedBefore === true && 
         !r.emerged
  );
  if (emerging) {
    updateReminder(userId, emerging.id, { emerged: true });
    const reply = `🔔 Tra un'ora hai: ${emerging.text}`;
    await appendTurn(userId, { 
      role: "assistant", 
      text: reply,
      meta: { tokenUsed: 0, tokenLimit: 10000, blocked: false }
    });
    sendEvent({ 
      type: "done",
      reply, 
      card: { 
        type: "reminder", 
        title: "Promemoria", 
        content: emerging.text, 
        status: "alert" 
      },
      meta: { tokenUsed: 0, tokenLimit: 10000, blocked: false }
    });
    return res.end();
  }

  // --- 2. RICERCA NEI FILE ---
  if (t.includes("cosa dice il file") || t.includes("cerca nel documento") || t.includes("analizza il file")) {
    try {
      const fileNameMatch = text.match(/file\s+([\w.]+)/i) || text.match(/documento\s+([\w.]+)/i);
      const fileName = fileNameMatch?.[1];
      
      let query = "";
      if (fileName) {
        query = text.replace(new RegExp(`(file|documento)\\s+${fileName}`, 'i'), '').trim();
      } else {
        query = text.replace(/cosa dice (il )?|cerca (nel )?|analizza (il )?/gi, '').trim();
      }

      const userFilesDir = path.join(process.cwd(), "storage", "users", userId, "files");
      
      if (!fs.existsSync(userFilesDir)) {
        fs.mkdirSync(userFilesDir, { recursive: true });
      }

      let filesToSearch = [];
      
      if (fileName) {
        const filePath = path.join(userFilesDir, fileName + ".txt");
        if (fs.existsSync(filePath)) {
          filesToSearch.push({ name: fileName, path: filePath });
        } else {
          const filePath2 = path.join(userFilesDir, fileName);
          if (fs.existsSync(filePath2)) {
            filesToSearch.push({ name: fileName, path: filePath2 });
          }
        }
      } else {
        const allFiles = fs.readdirSync(userFilesDir).filter(f => f.endsWith('.txt'));
        allFiles.forEach(f => {
          filesToSearch.push({ name: f.replace('.txt', ''), path: path.join(userFilesDir, f) });
        });
      }

      if (filesToSearch.length === 0) {
        const reply = fileName 
          ? `Non ho trovato il file "${fileName}" nella tua directory.`
          : "Non ho trovato file nella tua directory.";
        
        await appendTurn(userId, { 
          role: "assistant", 
          text: reply,
          meta: { tokenUsed: 0, tokenLimit: 10000, blocked: false }
        });
        
        sendEvent({ 
          type: "done",
          reply, 
          card: { 
            type: "search", 
            title: "Ricerca file", 
            content: reply, 
            status: "done" 
          },
          meta: { tokenUsed: 0, tokenLimit: 10000, blocked: false }
        });
        return res.end();
      }

      const allChunks = [];
      
      for (const file of filesToSearch) {
        try {
          const fullText = fs.readFileSync(file.path, "utf-8");
          const chunks = chunkText(fullText);
          
          chunks.forEach((chunk, chunkIndex) => {
            allChunks.push({
              id: `file_${file.name}_chunk_${chunkIndex}`,
              text: chunk,
              fileName: file.name
            });
          });
        } catch (err) {
          console.error(`Errore lettura file ${file.path}:`, err);
        }
      }

      if (allChunks.length === 0) {
        const reply = "I file sono vuoti o non leggibili.";
        await appendTurn(userId, { 
          role: "assistant", 
          text: reply,
          meta: { tokenUsed: 0, tokenLimit: 10000, blocked: false }
        });
        
        sendEvent({ 
          type: "done",
          reply, 
          card: { 
            type: "search", 
            title: "Ricerca file", 
            content: reply, 
            status: "done" 
          },
          meta: { tokenUsed: 0, tokenLimit: 10000, blocked: false }
        });
        return res.end();
      }

      let topChunks = allChunks;
      if (query.trim()) {
        const docs = allChunks.map(c => ({ id: c.id, text: c.text }));
        const rankedDocs = await rerankNews(query, docs);
        
        const rankedIds = rankedDocs.map(d => d.id);
        topChunks = rankedIds
          .map(id => allChunks.find(c => c.id === id))
          .filter(Boolean)
          .slice(0, 5);
      }

      let answer = "";
      if (query.trim()) {
        if (topChunks.length > 0) {
          answer = await buildNewsSnippets(
            topChunks.map(c => ({ title: c.fileName, snippet: c.text.substring(0, 500), url: "" })),
            `Ricerca: ${query}`,
            `Cerca nei file per: ${query}`
          );
        } else {
          answer = "Non ho trovato contenuti rilevanti nei tuoi file.";
        }
      } else {
        const fileSummary = filesToSearch.map(f => {
          try {
            const content = fs.readFileSync(f.path, "utf-8");
            return `📄 ${f.name}: ${content.length} caratteri`;
          } catch (err) {
            return `📄 ${f.name}: errore lettura`;
          }
        }).join("\n");
        
        answer = `Ecco i tuoi file:\n${fileSummary}`;
      }

      const reply = answer;
      await appendTurn(userId, { 
        role: "assistant", 
        text: reply,
        card: { 
          type: "search", 
          title: filesToSearch.length === 1 ? `Analisi ${filesToSearch[0].name}` : "Analisi file",
          content: answer,
          status: "done" 
        },
        meta: { tokenUsed: 0, tokenLimit: 10000, blocked: false }
      });
      
      sendEvent({ 
        type: "done",
        reply, 
        card: { 
          type: "search", 
          title: filesToSearch.length === 1 ? `Analisi ${filesToSearch[0].name}` : "Analisi file",
          content: answer,
          status: "done" 
        },
        meta: { tokenUsed: 0, tokenLimit: 10000, blocked: false }
      });
      return res.end();
    } catch (err) {
      console.error("File search error:", err);
    }
  }

  // --- 3. GESTIONE MEMORIA SEMANTICA ---
  if (t.includes("ti ricordi") || t.includes("cosa avevamo detto") || t.includes("com'è andata") || t.includes("memoria")) {
    try {
      const hits = await searchTurns(userId, text, 10);
      if (hits.length > 0) {
        const memoryContext = hits.map(h => `${h.role}: ${h.text}`).join("\n");
        req.session.user.state.memoryContext = memoryContext;
        
        if (t.includes("ti ricordi") || t.includes("memoria")) {
          const summary = hits.slice(0, 3).map(h => 
            `- ${h.role === "user" ? "Tu" : "Io"}: "${h.text.substring(0, 100)}${h.text.length > 100 ? '...' : ''}"`
          ).join("\n");
          
          const reply = `Ecco cosa ricordo della nostra conversazione:\n${summary}`;
          await appendTurn(userId, { 
            role: "assistant", 
            text: reply,
            meta: { tokenUsed: 0, tokenLimit: 10000, blocked: false }
          });
          sendEvent({ 
            type: "done",
            reply, 
            card: null,
            meta: { tokenUsed: 0, tokenLimit: 10000, blocked: false }
          });
          return res.end();
        }
      }
    } catch (err) {
      console.error("Memory search error:", err);
    }
  }

  // --- 4. LOGICA STANDARD ---
  await appendTurn(userId, { 
    role: "user", 
    text,
    meta: { tokenUsed: 0, tokenLimit: 10000, blocked: false }
  });

  userAudit(userId, "CHAT_INPUT", { chars: text.length });

  try {
    // B. RECUPERIAMO LA STORIA (Novità)
    // Leggiamo gli ultimi 6 turni (3 botta e risposta)
    // Escludiamo l'ultimo (che è quello appena inserito sopra, 'text') perché glielo passiamo già come prompt attuale
    const rawHistory = await readLastTurns(userId, 7); 
    const history = rawHistory.slice(0, -1); // Togliamo l'ultimo (input attuale) per non duplicarlo nel contesto

    // C. Passiamo la history a processInput
    const result = await processInput(text, req.session.user.state, history);
    
    // Se l'engine propone un reminder, lo annulliamo: non vogliamo card reminder in chat
    if (result.card?.type === "reminder") {
      result.card = null;
    }
    
    // RICERCA (Questa la teniamo perché è utile cercare nell'agenda via chat)
    if (result.card?.type === "search") {
      try {
        const queryRicerca = text.replace(/cerca|trova|ricerca/gi, "").trim();
        const hits = await searchEvents(userId, queryRicerca);

        if (hits.length > 0) {
          const content = hits
            .map(h => `📌 ${h.text}\n   (${h.date})`)
            .join("\n\n");

          result.reply = `Ecco cosa ho trovato per "${queryRicerca}":`;
          result.card.content = content;
          result.card.status = "done";
        } else {
          result.reply = "Non ho trovato nulla nei tuoi impegni.";
          result.card.content = "Nessun risultato trovato.";
          result.card.status = "done";
        }
      } catch (err) {
        console.error("SEARCH ERROR:", err);
        result.reply = "Errore durante la ricerca.";
      }
    }

    // NEWS PIPELINE con STREAMING
    if (result.card?.type === "news") {
      try {
        const topic = cleanNewsQuery(text) || text;
        
        // Invia messaggio iniziale
        sendEvent({ type: "chunk", text: `Analizzo le ultime notizie su "${topic}"...\n\n` });
        
        const newsResults = await getRelevantNews(topic);
        if (newsResults && newsResults.length > 0) {
          // Streaming della risposta
          const summary = await buildNewsSnippets(newsResults, topic, text);
          
          // Simula streaming dividendo la risposta
          const chunks = summary.match(/.{1,50}/g) || [summary];
          for (const chunk of chunks) {
            sendEvent({ type: "chunk", text: chunk });
            await new Promise(resolve => setTimeout(resolve, 30)); // Ritardo per effetto streaming
          }
          
          result.card.content = summary;
          result.reply = `Ecco cosa ho trovato su ${topic}:`;
        } else {
          sendEvent({ type: "chunk", text: "Non ho trovato notizie recenti su questo argomento." });
          result.card.content = "Non ho trovato notizie recenti su questo argomento.";
        }
        
        result.card.status = "done";
      } catch (err) {
        console.error("NEWS ERROR:", err);
        result.card.content = "Errore nel recupero delle notizie.";
        result.card.status = "error";
      }
    }

    await appendTurn(userId, {
      role: "assistant",
      text: result.reply,
      card: result.card ?? null,
      meta: result.meta ?? { tokenUsed: 0, tokenLimit: 10000, blocked: false }
    });

    if (req.session.user.state.memoryContext) {
      req.session.user.state.memoryContext = null;
    }

    sendEvent({ type: "done", ...result });
    res.end();
  } catch (err) {
    console.error(err);
    await appendTurn(userId, {
      role: "system",
      text: `Errore: ${err.message}`,
      meta: { tokenUsed: 0, tokenLimit: 10000, blocked: false, error: true }
    });
    sendEvent({ 
      type: "error",
      error: "Engine error",
      meta: { tokenUsed: 0, tokenLimit: 10000, blocked: false }
    });
    res.end();
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

//Api di generazione Immagine ComfyUI Flux

app.post('/api/generate-image', async (req, res) => {
    const { prompt } = req.body;
    const comfyUrl = "http://localhost:8188"; // Nome del container docker

    try {
        // 1. Carica il file che mi hai appena mandato
        const workflowPath = path.join(__dirname, 'workflow_api.json');
        let workflow = JSON.parse(fs.readFileSync(workflowPath, 'utf8'));

        // 2. Inserisci il prompt dell'utente nel nodo corretto (ID 2)
        workflow["2"]["inputs"]["text"] = prompt;

        // 3. Genera un SEED casuale (ID 4) per avere immagini sempre diverse
        workflow["4"]["inputs"]["seed"] = Math.floor(Math.random() * 10000000000000);

        // 4. Invia la richiesta a ComfyUI
        const response = await axios.post(`${comfyUrl}/prompt`, { prompt: workflow });
        const promptId = response.data.prompt_id;

        console.log(`Generazione avviata: ${promptId}`);

        // 5. POLLING: Aspettiamo che l'immagine sia pronta
        // Controlliamo ogni secondo se la storia del promptId esiste
        let completed = false;
        let fileName = "";

        while (!completed) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            try {
                const history = await axios.get(`${comfyUrl}/history/${promptId}`);
                if (history.data[promptId]) {
                    // Trovata! Prendiamo il nome del file dal nodo SaveImage (ID 6)
                    fileName = history.data[promptId].outputs["6"].images[0].filename;
                    completed = true;
                }
            } catch (e) {
                // In attesa che il server processi...
            }
        }

        // 6. Rispondi al frontend con l'URL dell'immagine
        // Nota: Assicurati che la cartella output di Comfy sia servita come statica da Node
        res.json({ ok: true, url: `/output/${fileName}` });

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
app.post("/api/deep-read", isAuthenticated, async (req, res) => {
  let { url } = req.body; // 'let' perché potremmo cambiarlo
  if (!url) return res.json({ ok: false, error: "URL mancante" });

  console.log(`📖 [READER] Input: ${url}`);

  try {
    // 1. TENTATIVO DI DECODIFICA LOCALE (Se possibile)
    const decodedUrl = decodeGoogleNewsUrl(url);
    if (decodedUrl !== url) {
        console.log(`🔓 URL Decodificato: ${decodedUrl}`);
        url = decodedUrl;
    }

    // 2. SCARICA LA PAGINA
    const response = await fetch(url, {
      redirect: 'follow', // Seguiamo i redirect
      headers: { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7'
      },
      timeout: 10000 
    });
    
    // Controlliamo dove siamo finiti
    const finalUrl = response.url;
    let html = await response.text();
    console.log(`🔗 Atterrato su: ${finalUrl}`);

    // 3. SE SIAMO ANCORA SU GOOGLE, CERCHIAMO DENTRO L'HTML
    // Google spesso mette un tag <a href="...">Clicca qui</a> se il redirect JS fallisce
    if (finalUrl.includes("news.google.com") || finalUrl.includes("consent.google.com")) {
        console.warn("⚠️ Muro di Google rilevato. Cerco via di fuga...");
        
        // Cerca il primo link utile che NON sia google
        const linkMatch = html.match(/<a[^>]+href="([^"]+)"[^>]*>(?!.*google).+?<\/a>/i) || 
                          html.match(/<a[^>]+href="([^"]+)"[^>]*>here<\/a>/i) ||
                          html.match(/window\.location\.replace\("([^"]+)"\)/); // Redirect JS semplice

        if (linkMatch && linkMatch[1]) {
            let realUrl = linkMatch[1];
            // Pulizia URL (a volte ci sono escape strani)
            realUrl = realUrl.replace(/\\x3d/g, "=").replace(/\\x26/g, "&");
            
            console.log(`🚀 Trovato link di scampo: ${realUrl}`);
            
            // Riprova sul link vero
            const realRes = await fetch(realUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36' }
            });
            html = await realRes.text();
        } else {
            // Extrema Ratio: Se fallisce tutto, chiedi scusa
            throw new Error("Contenuto protetto da Google News.");
        }
    }

    // 4. ESTRAZIONE E PULIZIA TESTO
    let articleText = "";
    // Prende i paragrafi <p> lunghi (testo articolo)
    const pMatches = html.match(/<p[^>]*>([\s\S]*?)<\/p>/gim);
    if (pMatches) {
        articleText = pMatches
            .map(p => p.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim())
            .filter(t => t.length > 50) // Solo frasi lunghe
            .join("\n\n");
    }

    // Fallback brutale se non trova <p>
    if (articleText.length < 200) {
        articleText = html.replace(/<[^>]+>/g, " ").trim();
    }

    const truncatedText = articleText.substring(0, 12000);

    // 5. INFERENZA AI (Llama3 su 3090)
// 4. INFERENZA SU OLLAMA NEWS (Porta 11435 - GPU 3090)
    const prompt = `
Sei un assistente editoriale esperto.

Riassumi il testo seguente in italiano chiaro, preciso e fedele.

Regole obbligatorie:
- Usa SOLO le informazioni presenti nel testo.
- NON creare titoli, sezioni o intestazioni.
- NON usare grassetto, corsivo o markdown.
- NON riorganizzare il contenuto in categorie.
- NON aggiungere spiegazioni generiche o contesto esterno.
- NON trarre conclusioni che non siano esplicitamente presenti.

Linee guida:
- Evidenzia i fatti principali e lo stato della ricerca.
- Mantieni un tono neutro e informativo.
- Usa frasi complete ma brevi.
- Un’idea chiave per paragrafo.

Struttura:
- 5–7 paragrafi brevi.
- Solo testo continuo.
${truncatedText}

RISPOSTA HTML:`;

    const ollamaRes = await fetch("http://localhost:11435/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "llama3:8b", 
        prompt: prompt,
        stream: false,
        options: { 
            num_ctx: 4096, 
            temperature: 0.3, // Teniamola bassa per evitare allucinazioni
            top_p: 0.9
        }
      })
    });

    
    const data = await ollamaRes.json();
    res.json({ ok: true, summary: data.response });

  } catch (e) {
    console.error("READER ERROR:", e.message);
    res.json({ ok: false, error: "Impossibile estrarre il testo dall'articolo." });
  }
});
// Endpoint per l'upload (protetto)
app.post("/api/upload", isAuthenticated, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, msg: "Nessun file inviato" });

    const userId = req.session.user.id;
    const userFilesDir = path.join(process.cwd(), "storage", "users", userId, "files");

    // Crea la cartella se non esiste
    if (!fs.existsSync(userFilesDir)) {
      fs.mkdirSync(userFilesDir, { recursive: true });
    }

    // Controlliamo il limite di 5 file
    const existingFiles = fs.readdirSync(userFilesDir).filter(f => !f.endsWith(".txt"));
    if (existingFiles.length >= 5) {
      return res.status(400).json({ ok: false, msg: "Limite di 5 file raggiunto. Cancella qualcosa." });
    }

    const fileName = req.file.originalname;
    const filePath = path.join(userFilesDir, fileName);

    // 1. Salviamo il file originale
    fs.writeFileSync(filePath, req.file.buffer);

    // 2. Estraiamo il testo (Conversione PDF -> Testo)
    let extractedText = "";
    if (fileName.toLowerCase().endsWith(".pdf")) {
      console.log(`📄 Conversione PDF in corso: ${fileName}`);
      try {
        const data = await pdf(req.file.buffer);
        extractedText = data?.text || "";
      } catch (e) {
        console.error("PDF parse error:", e);
        extractedText = "";
      }
    } else {
      // best-effort: se è binario verrà fuori spazzatura, ma non crasha
      extractedText = req.file.buffer.toString("utf-8");
    }

    if (!extractedText || !extractedText.trim()) {
      extractedText = "[Nessun testo estratto]";
    }

    // 3. Salviamo la versione .txt per il Reranker (stesso nome ma estensione .txt)
    const txtPath = path.join(userFilesDir, fileName.replace(/\.[^/.]+$/, "") + ".txt");
    fs.writeFileSync(txtPath, extractedText);

    console.log(`✅ File pronto per Reranker: ${txtPath}`);
    res.json({ ok: true, message: "File caricato e analizzato con successo!" });

  } catch (err) {
    console.error("❌ Errore durante l'upload:", err);
    res.status(500).json({ ok: false, msg: "Errore interno durante l'analisi del file." });
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

// SALVA NOTE
app.post("/api/scratchpad", isAuthenticated, (req, res) => {
  const { text } = req.body;
  const userId = req.session.user.id;
  
  // Cartella utente
  const userDir = path.join(process.cwd(), "storage", "users", userId);
  if (!fs.existsSync(userDir)) fs.mkdirSync(userDir, { recursive: true });
  
  const padFile = path.join(userDir, "scratchpad.json");

  try {
    // Salviamo un oggetto JSON semplice
    fs.writeFileSync(padFile, JSON.stringify({ text: text || "", lastUpdate: new Date() }));
    res.json({ ok: true });
  } catch (e) {
    console.error("Scratchpad Save Error:", e);
    res.status(500).json({ ok: false });
  }
});

// LEGGI NOTE
app.get("/api/scratchpad", isAuthenticated, (req, res) => {
  const userId = req.session.user.id;
  const padFile = path.join(process.cwd(), "storage", "users", userId, "scratchpad.json");
  
  try {
    if (fs.existsSync(padFile)) {
      const data = JSON.parse(fs.readFileSync(padFile, 'utf8'));
      res.json({ text: data.text || "" });
    } else {
      res.json({ text: "" }); // Nessuna nota salvata
    }
  } catch (e) {
    res.json({ text: "" });
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
app.get("/api/user-files", isAuthenticated, (req, res) => {
  const userId = req.session.user.id;
  const dir = path.join(process.cwd(), "storage", "users", userId, "files");
  
  if (!fs.existsSync(dir)) return res.json({ files: [] });
  
  // Prendiamo solo i file originali (evitiamo i .txt duplicati nell'elenco)
  const files = fs.readdirSync(dir).filter(f => !f.endsWith(".txt"));
  res.json({ files });
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
  // Imposta gli header SSE subito
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");

  const sendEvent = (obj) => {
    try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch (e) {}
  };

  try {
    const { fileName, query } = req.body;
    const userId = req.session.user.id;
    const txtPath = path.join(process.cwd(), "storage", "users", userId, "files", fileName.replace(/\.[^/.]+$/, "") + ".txt");

    if (!fs.existsSync(txtPath)) {
      sendEvent({ error: "File di testo non trovato" });
      return res.end();
    }

    const fullText = fs.readFileSync(txtPath, "utf-8");
    const chunks = chunkText(fullText, 600);
    const docs = chunks.map((c, i) => ({ id: `c${i}`, text: c }));

    // Reranker
    let ranked = docs;
    try { ranked = await rerankNews(query, docs); } catch (e) { console.error("Rerank error", e); }
    const topContext = ranked.slice(0, 3).map(r => r.text).join("\n\n");

    const prompt = `Analizza questo testo tratto dal file ${fileName} e rispondi alla domanda: ${query}

REGOLE DI FORMATTAZIONE:
- Usa esclusivamente tag HTML per la risposta.
- Usa <h3> per i titoli delle sezioni.
- Usa <p> per i paragrafi.
- Usa <ul> e <li> per le liste puntate.
- Usa <b> per evidenziare i termini importanti.
- Usa <hr> per separare le sezioni principali.
- NON usare Markdown (niente cancelletti o asterischi).

CONTESTO:
${topContext}

RISPOSTA IN HTML:`;

    const ollamaRes = await fetch("http://localhost:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-oss:20b",
        prompt,
        stream: true,
           options: {
           num_ctx: 4096,       // <--- FONDAMENTALE: Deve essere uguale alla Chat!
           temperature: 0.3,    // Bassa per analisi documenti
           repeat_penalty: 1.2,
           keep_alive: "30m"    // Forza il modello a restare in memoria per 30 min
        }
      })
    });

    const reader = ollamaRes.body.getReader();
    const decoder = new TextDecoder();
    
    let clientClosed = false;
    let lineBuffer = ""; 

    // Gestione disconnessione utente
    req.on("close", () => { 
      clientClosed = true; 
      console.log("Azione interrotta dall'utente.");
    });

    while (true) {
      if (clientClosed) break;
      const { done, value } = await reader.read();
      if (done) break;

      lineBuffer += decoder.decode(value, { stream: true });
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop(); // Tieni la riga incompleta

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const json = JSON.parse(line);
          if (json.response) {
            sendEvent({ text: json.response });
          }
        } catch (e) {
          // Ignora chunk parziali
        }
      }
    }

    res.end();
  } catch (err) {
    console.error("CARD SEARCH STREAM ERROR:", err);
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
  if (!topic) return res.status(400).json({ ok: false, content: "Inserisci un argomento." });

  console.log(`📡 [WEB INFERENCE] Intelligence Report per: ${topic}`);

  try {
    // 1. Recupero notizie grezze
    const newsResults = await getRelevantNews(topic);
    if (!newsResults || newsResults.length === 0) {
      return res.json({ ok: true, content: "<p class='news-report-p'>Nessuna informazione recente trovata nel database web.</p>" });
    }

    // 2. Preparazione contesto per l'AI
    const context = newsResults.map(n => `FONTE: ${n.title}\nCONTENUTO: ${n.snippet}`).join("\n\n");

    // 3. Chiamata alla 5090 (Porta 11434 - ollama-gptoss)
    const prompt = `Sei un analista di intelligence. Genera un report professionale su: ${topic}
Basandoti su queste info:
${context}

REGOLE DI FORMATTAZIONE (USA SOLO QUESTI TAG):
- Ogni sezione deve iniziare con: <div class="news-report-h">TITOLO SEZIONE</div>
- Il testo deve essere dentro: <p class="news-report-p">Contenuto...</p>
- Le fonti devono essere citate a fine paragrafo con: <span class="news-source">(Fonte: Nome Sito)</span>
- Usa <hr> per separare i macro-argomenti.
- NON USARE MARKDOWN (* o #). SOLO HTML.

RISPONDI IN ITALIANO:`;

    const ollamaRes = await fetch("http://localhost:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-oss:20b",
        prompt: prompt,
        stream: false, // Per la news card carichiamo il blocco intero per eleganza
        options: { num_ctx: 4096, temperature: 0.6 }
      })
    });

    const data = await ollamaRes.json();
    res.json({ ok: true, content: data.response });

  } catch (err) {
    console.error("ERRORE NEWS:", err);
    res.status(500).json({ ok: false, content: "Errore durante l'elaborazione del report." });
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

// Avvia il scheduler
startScheduler();

app.listen(3000, () => console.log("🚀 Keblo Final running on http://localhost:3000"));