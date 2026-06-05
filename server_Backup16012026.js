// --- 1. GESTIONE IMPORT ---
import express from "express";
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
import multer from "multer";
import { createRequire } from "module";
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

// --- 4.1 SESSION HANDSHAKE (non sporca la history) ---
app.post("/api/session", async (req, res) => {
  if (!req.session.user) {
    req.session.user = { id: "test_user", state: initialState() };
  }
  try {
    await ensureConversationSession(req.session.user.id);
  } catch (e) {
    console.error("SESSION ensureConversationSession error:", e);
  }
  res.json({ ok: true, userId: req.session.user.id });
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

// ... da qui in poi prosegui con le tue rotte (app.post("/api/login"), ecc.)
app.post("/api/login", async (req, res) => {
  const { email } = req.body;

  req.session.user = {
    id: "u_" + Date.now(),
    email,
    state: initialState()
  };

  await ensureConversationSession(req.session.user.id);

  audit("USER_LOGIN", { email });
  res.json({ ok: true });
});

// AGGIUNGI QUESTO ENDPOINT NEL TUO server.js
// Sostituisce l'endpoint /api/chat esistente con questa versione streaming

app.post("/api/chat", async (req, res) => {
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

  if (!req.session.user) {
    req.session.user = { id: "test_user", state: initialState() };
  }

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
 // --- 4. LOGICA STANDARD (PULITA) ---
  await appendTurn(userId, { 
    role: "user", 
    text,
    meta: { tokenUsed: 0, tokenLimit: 10000, blocked: false }
  });

  userAudit(userId, "CHAT_INPUT", { chars: text.length });

  // RIMOSSA TUTTA LA LOGICA DI CONFERMA (isConfirm, isCancel, pendingReminder)

  try {
    const result = await processInput(text, req.session.user.state);
    
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

    // RIMOSSO IL BLOCCO: if (result.card?.type === "reminder" && result.card.status === "pending") { ... }
    
    // ... Prosegue con la News Pipeline e l'invio dell'evento ...

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
// Endpoint per leggere lo storico
app.get("/api/history", async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: "not logged" });
  const userId = req.session.user.id;
  const limit = Number(req.query.limit || 30);
  const turns = await readLastTurns(userId, limit);
  res.json({ userId, turns });
});

// Endpoint per cercare nello storico
app.get("/api/history/search", async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: "not logged" });
  const userId = req.session.user.id;
  const q = String(req.query.q || "");
  const limit = Number(req.query.limit || 30);
  const hits = await searchTurns(userId, q, limit);
  res.json({ userId, q, hits });
});

// Endpoint per i promemoria attivi
app.get("/api/reminders", async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: "not logged" });
  const userId = req.session.user.id;
  const reminders = getReminders(userId);
  // Restituiamo solo quelli NON cancellati
  const visible = reminders.filter(r => r.status !== "dismissed");
  res.json({ userId, reminders: visible });
});

app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.session.user) return res.status(401).json({ ok: false, msg: "Sessione scaduta" });
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

// --- NUOVO: Endpoint per eliminare un file ---
app.delete("/api/delete-file", (req, res) => {
  if (!req.session.user) return res.status(401).json({ ok: false, msg: "Non loggato" });
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

// --- Endpoint per la lista file dell'utente ---
app.get("/api/user-files", (req, res) => {
    // Controlla la sessione
    if (!req.session.user) return res.status(401).json({ error: "not logged" });
    
    const userId = req.session.user.id;
    const dir = path.join(process.cwd(), "storage", "users", userId, "files");
    
    if (!fs.existsSync(dir)) return res.json({ files: [] });
    
    // Prendiamo solo i file originali (evitiamo i .txt duplicati nell'elenco)
    const files = fs.readdirSync(dir).filter(f => !f.endsWith(".txt"));
    res.json({ files });
});

// --- Endpoint Ricerca Semantica in Streaming per la Card ---
app.post("/api/card-search-stream", async (req, res) => {
    // Imposta gli header SSE subito
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");

    const sendEvent = (obj) => {
      try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch (e) {}
    };

    try {
      if (!req.session.user) {
        sendEvent({ error: "Sessione non valida" });
        return res.end();
      }

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
          stream: true
        })
      });

      const reader = ollamaRes.body.getReader();
      const decoder = new TextDecoder();
      
      // --- FIX: DICHIARAZIONE VARIABILI MANCANTI ---
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
  startScheduler();
// --- Endpoint per l'inferenza indipendente della Card News ---
app.post("/api/news-inference", async (req, res) => {
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
// Endpoint per eliminare un promemoria dall'agenda
app.delete("/api/reminders/:id", (req, res) => {
  if (!req.session.user) return res.status(401).json({ ok: false });
  const userId = req.session.user.id;
  const reminderId = req.params.id;

  // Invece di cancellare, lo segniamo come 'dismissed'
  // updateReminder è già importato nel tuo server.js
  updateReminder(userId, reminderId, { status: "dismissed" });
  
  console.log(`🔕 Reminder ${reminderId} segnato come DISMISSED`);
  res.json({ ok: true });
});

// Endpoint per aggiunta rapida da card
app.post("/api/reminders/quick-add", async (req, res) => {
  if (!req.session.user) return res.status(401).json({ ok: false });
  const { text } = req.body;
  const userId = req.session.user.id;

  const parsed = parseDueDate(text); // Controlla che questa funzione sia importata!
  
  if (!parsed || !parsed.date) {
    return res.json({ ok: false, msg: "Data non valida o non capita." });
  }

  const newRem = {
    id: "r_" + Date.now(),
    userId,
    text: text,
    dueAt: parsed.date.toISOString(),
    status: "pending", 
    createdAt: new Date().toISOString()
  };

  addReminder(userId, newRem);
  res.json({ ok: true });
});
// Endpoint per la ricerca semantica avanzata nell'agenda
app.get("/api/reminders/search", async (req, res) => {
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
app.get("/api/reminders/archived", async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: "not logged" });
  const reminders = getReminders(req.session.user.id);
  // Restituiamo solo quelli marchiati come dismissed
  const archived = reminders.filter(r => r.status === "dismissed");
  res.json({ archived });
});
app.listen(3000, () => console.log("🚀 Keblo Final running on http://localhost:3000"));