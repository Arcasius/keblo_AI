import fetch from "node-fetch";

const OLLAMA_URL = "http://localhost:11434/api/generate";
const MODEL = "qwen3.5:27b";

const STYLE = `
Rispondi SEMPRE in ITALIANO.
Stile: Naturale, umano, empatico. 


REGOLE FORMATO:
- Usa i titoli ### solo per i cambi di argomento importanti.
- Usa il **grassetto** per le parole chiave.
- NON inserire righe vuote multiple. 
- Rispondi in Markdown
`.trim();

// -------------------------------
// KEBLO CORE: sanitize LLM reply
// -------------------------------

function normalizeText(s) {
  if (!s) return "";
  return String(s)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripHtmlLike(s) {
  return s
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function removePipeTables(s) {
  return s.split("\n").map(line => {
    const pipeCount = (line.match(/\|/g) || []).length;
    if (pipeCount >= 2) return line.replace(/\|/g, " ");
    return line;
  }).join("\n");
}

function breakRepeatingBlocks(text, window = 10) {
  const lines = normalizeText(text).split("\n").map(l => l.trim()).filter(Boolean);
  if (lines.length < window * 2) return normalizeText(text);

  for (let i = window; i <= lines.length - window; i++) {
    const prev = lines.slice(i - window, i).join("||");
    const next = lines.slice(i, i + window).join("||");
    if (prev && next && prev === next) {
      return lines.slice(0, i).join("\n").trim();
    }
  }
  return lines.join("\n").trim();
}

function dedupeBullets(text, maxItems = 12) {
  const lines = normalizeText(text).split("\n").map(l => l.trim()).filter(Boolean);
  const out = [];
  const seen = new Set();

  for (const line of lines) {
    const m = line.match(/^(?:•|\-|\*)\s+(.*)$/);
    if (!m) {
      // Se non è un bullet, lo teniamo (es. frase introduttiva)
      if (out.length < 2) out.push(line); 
      continue;
    }

    const payload = (m[1] || "").trim();
    if (!payload) continue;

    const norm = payload.toLowerCase().replace(/\s+/g, " ").replace(/[.,;:!?]+$/g, "").trim();
    if (!norm || seen.has(norm)) continue;

    // Controllo extra per ridondanze parziali
    let isRedundant = false;
    for (let s of seen) if (norm.includes(s) || s.includes(norm)) { isRedundant = true; break; }
    if (isRedundant) continue;

    seen.add(norm);

    // Manteniamo il pallino qui, lo convertiamo dopo
    const pretty = payload.charAt(0).toUpperCase() + payload.slice(1);
    out.push("• " + pretty);

    if (out.length >= maxItems) break;
  }

  return out.join("\n").trim();
}

function truncateHard(text, maxChars = 3500, maxLines = 120) {
  let t = normalizeText(text);
  let lines = t.split("\n");
  if (lines.length > maxLines) lines = lines.slice(0, maxLines);
  t = lines.join("\n").trim();
  if (t.length > maxChars) t = t.slice(0, maxChars).trim();
  return t;
}

function guessMode(text) {
  const lines = normalizeText(text).split("\n").map(l => l.trim()).filter(Boolean);
  const bulletLines = lines.filter(l => /^(?:•|\-|\*)\s+/.test(l)).length;
  if (bulletLines >= 3) return "list"; // Se ci sono almeno 3 bullet, è una lista
  return "prose";
}

function sanitizeLLMReply(reply, opts = {}) {
  const { mode = "auto", maxItems = 12, maxChars = 3500, maxLines = 120 } = opts;
  let text = normalizeText(reply);
  if (!text) return "";

  text = stripHtmlLike(text);
  text = removePipeTables(text);
  text = normalizeText(text);
  text = breakRepeatingBlocks(text, 8); // Anti-Loop

  const resolvedMode = mode === "auto" ? guessMode(text) : mode;

  if (resolvedMode === "list") {
    text = dedupeBullets(text, maxItems);
  }

  return truncateHard(text, maxChars, maxLines);
}

// --- QUESTA È LA FUNZIONE CHE AGGIUSTA LA GRAFICA ---
function bulletsToMarkdown(text) {
  if (!text) return text;
  // Sostituisce "• " con "- " (Trattino + Spazio)
  // Il trattino viene interpretato dal browser come <li>, andando a capo automaticamente
  return text.replace(/^•\s+/gm, "- "); 
}

// ==========================================
// === MAIN FUNCTION ===
// ==========================================

// DENTRO llm_router.js

   // --- PUNTO 1: L'OROLOGIO (Fuori dalla funzione principale) ---
function getTimeAgo(timestamp) {
  if (!timestamp) return "tempo ignoto";
  const now = new Date();
  const then = new Date(timestamp);
  const diffInMs = now - then;
  const diffInMins = Math.floor(diffInMs / 60000);

  if (diffInMins < 1) return "proprio ora";
  if (diffInMins < 60) return `${diffInMins} min fa`;
  if (diffInMins < 1440) return `${Math.floor(diffInMins / 60)} ore fa`;
  return `${Math.floor(diffInMins / 1440)} giorni fa`;
}
function smartTrim(s, max=260){
  const t = String(s).replace(/\s+/g," ").trim();
  if (t.length <= max) return t;

  const cut = t.slice(0, max);
  const lastP = Math.max(cut.lastIndexOf("."), cut.lastIndexOf("!"), cut.lastIndexOf("?"));
  if (lastP > 80) return cut.slice(0, lastP+1).trim() + "…";

  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 80 ? cut.slice(0, lastSpace) : cut).trim() + "…";
}
//GPT Repaly per Qwen
/*
export async function gptReply(userPrompt, history = [], mood = "mood=neutral") {
  
  const oraAttuale = new Date().toLocaleString('it-IT', { 
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' 
  });

  const contextString = history
    .filter(turn => turn.text !== userPrompt) 
    .map(turn => {
      const roleName = turn.role === "user" ? "Utente" : "Keblo";
      const quando = getTimeAgo(turn.ts);
      const cleanText = smartTrim(turn.text, 260);
      return `[${quando}] ${roleName}: ${cleanText}`;
    })
    .join("\n");

  const prompt = `${STYLE}
DATI DI SISTEMA:
- ORARIO ATTUALE: ${oraAttuale}
- STATO EMOTIVO UTENTE: ${mood}
- ENGINE: Qwen-Core

CRONOLOGIA:
${contextString || "Nessun contesto precedente."}

DOMANDA ATTUALE:
${userPrompt}

RISPOSTA:`;

  try {
    const res = await fetch(OLLAMA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        prompt, 
        stream: false, // Assicuriamoci che sia false
        options: {
          temperature: 0.7, 
          top_p: 0.9,
          num_ctx: 8192 
        }
      })
    });

    // --- FIX ERRORE JSON ---
    const rawResponse = await res.text(); // Leggiamo come testo grezzo
    
    let data;
    try {
      data = JSON.parse(rawResponse); // Proviamo a parsare manualmente
    } catch (e) {
      console.error("ERRORE CRITICO OLLAMA (JSON NON VALIDO):", rawResponse);
      // Se fallisce, creiamo un oggetto di emergenza per non far crashare il server
      return { 
        reply: "Scusami, ho avuto un'interferenza nel mio modulo di linguaggio.", 
        prompt: prompt, 
        raw: { eval_count: 0, eval_duration: 1 } 
      };
    }

    let reply = (data.response || "").trim();

    // Pulizia e formattazione
    reply = sanitizeLLMReply(reply, { mode: "auto", maxItems: 12 });
    reply = bulletsToMarkdown(reply);

    return { 
      reply: reply || "⚠️ Nessuna risposta dal modello.", 
      prompt: prompt,
      raw: data 
    };

  } catch (e) {
    console.error("Errore di rete/Ollama:", e);
    return { reply: "Errore di connessione al cervello neurale.", prompt: "", raw: {} };
  }
}*/
//Chiusura momentanea GPT RPLY Modello GPT-oss
// Aggiungiamo 'mood' ai parametri (con default neutral)
export async function gptReply(userPrompt, history = [], mood = "mood=neutral") {
  
  // --- PUNTO 2: IL PRESENTE (Bussola Temporale) ---
  const oraAttuale = new Date().toLocaleString('it-IT', { 
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' 
  });

  // --- PUNTO 3: TRASFORMARE LA STORIA (Inserimento Timestamp) ---
  const contextString = history
    .filter(turn => turn.text !== userPrompt) 
    .map(turn => {
      const roleName = turn.role === "user" ? "Utente" : "Keblo";
      const quando = getTimeAgo(turn.ts);
      const cleanText = smartTrim(turn.text, 260);
      return `[${quando}] ${roleName}: ${cleanText}`;
    })
    .join("\n");

  // --- COSTRUZIONE DEL PROMPT FINALE ---
  const prompt = `${STYLE}

DATI DI SISTEMA:
- ORARIO ATTUALE: ${oraAttuale}
- STATO EMOTIVO UTENTE: ${mood} <--- 🧠 KEBLO ORA TI SENTE
- STATO: Operativo

CRONOLOGIA CONVERSAZIONE (Usa i timestamp tra parentesi per orientarti):
${contextString || "Nessun contesto precedente."}

DOMANDA ATTUALE (Inviata ora):
${userPrompt}

RISPOSTA DI KEBLO:`;

  // Log tecnico nel terminale
  console.log("\n================ PROMPT FINALE ================\n");
  console.log(prompt);
  console.log("\n================================================\n"); 

  try {
    const res = await fetch(OLLAMA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        prompt, 
        stream: false,
        options: {
          temperature: 0.7, 
          top_p: 0.9,
          repeat_penalty: 1.3,
          num_ctx: 8192 
        }
      })
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error("Ollama error: " + errText);
    }

    const data = await res.json();
    console.log("[DEBUG OLLAMA RAW]:", { 
      eval: data.eval_count, 
      dur: data.eval_duration 
    });
    let reply = (data.response || "").trim();

    // Pulizia e formattazione
    reply = sanitizeLLMReply(reply, { mode: "auto", maxItems: 12 });
    reply = bulletsToMarkdown(reply);

// Restituiamo un oggetto, così l'Engine può leggere sia il testo che il prompt
return { 
  reply: reply || "⚠️ Nessuna risposta dal modello.", 
  prompt: prompt,
  raw: data 

};
  } catch (e) {
    console.error(e);
    return "Errore di connessione al cervello neurale.";
  }
}

// --- DIARIO ---
const DIARY_PROMPT_SYSTEM = `
Sei un diario di ascolto.
Il tuo compito principale è ascoltare e custodire ciò che l’utente scrive.
Non devi guidare, correggere o consigliare.
Rispondi in modo calmo e breve.
`.trim();

export async function gptDiaryReply(userText, historyContext = "") {
  const fullPrompt = `${DIARY_PROMPT_SYSTEM}
CONTESTO:
${historyContext}
UTENTE:
${userText}
DIARIO:`;

  try {
    const res = await fetch(OLLAMA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        prompt: fullPrompt,
        stream: false,
        options: { temperature: 0.6, top_p: 0.9 }
      })
    });
    const data = await res.json();
    return (data.response || "").trim();
  } catch (e) {
    console.error("LLM Diary Error:", e);
    return "Ti ascolto.";
  }
}
// llm_router.js
//backup gprReplystream 29/03/206
/*
export async function gptReplyStream(userPrompt, history = [], mood = "mood=neutral", onChunk) {
  const startedAt = Date.now(); // <-- DEBUG tempo totale

  // 1. TIMING & BUSSOLA
  const oraAttuale = new Date().toLocaleString('it-IT', { 
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' 
  });

  // 2. RICOSTRUZIONE STORIA
  const contextString = history
    .filter(turn => turn.text !== userPrompt) 
    .map(turn => {
      const roleName = turn.role === "user" ? "Utente" : "Keblo";
      const quando = getTimeAgo(turn.ts);
      const cleanText = smartTrim(turn.text, 260);
      return `[${quando}] ${roleName}: ${cleanText}`;
    })
    .join("\n");

  // 3. COSTRUZIONE PROMPT
  const prompt = `${STYLE}

DATI DI SISTEMA:
- ORARIO ATTUALE: ${oraAttuale}
- STATO EMOTIVO UTENTE: ${mood} <--- 🧠 KEBLO ORA TI SENTE
- STATO: Operativo

CRONOLOGIA CONVERSAZIONE (Usa i timestamp tra parentesi per orientarti):
${contextString || "Nessun contesto precedente."}

DOMANDA ATTUALE (Inviata ora):
${userPrompt}

RISPOSTA DI KEBLO:`;

  console.log("\n" + "=".repeat(60));
  console.log("🧠 NEXUS INJECTION - PROMPT INVIATO ALLA 5090");
  console.log("=".repeat(60));
  console.log(prompt);
  console.log("=".repeat(60) + "\n");

  try {
    const fetchStartedAt = Date.now(); // <-- DEBUG inizio chiamata modello

    const res = await fetch(OLLAMA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        prompt: prompt, 
        stream: true,
        think:false, 
        options: {
          temperature: 0.7, 
          top_p: 0.9,
          repeat_penalty: 1.1,
          num_ctx: 8192
        }
      })
    });

    if (!res.ok) throw new Error("Ollama connection error");

    const reader = res.body;
    const decoder = new TextDecoder();
    let fullReply = "";
    let lastMetadata = {};
    let buffer = "";

    let firstTokenAt = null;   // <-- DEBUG TTFT
    let chunkCount = 0;        // <-- DEBUG quanti chunk
    let debugPreview = "";     // <-- DEBUG accumulo primi caratteri

    for await (const chunk of reader) {
      buffer += decoder.decode(chunk, { stream: true });
      let lines = buffer.split("\n");
      buffer = lines.pop(); 

      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const data = JSON.parse(line);

          // <-- DEBUG: vedi i primi oggetti grezzi che manda Ollama
          if (chunkCount < 5) {
            console.log(`[DEBUG RAW ${chunkCount + 1}]`, data);
          }

          if (data.response) {
            if (!firstTokenAt) {
              firstTokenAt = Date.now();
              console.log(`[TTFT] Primo token dopo ${firstTokenAt - fetchStartedAt} ms`);
            }

            const content = data.response;
            fullReply += content;

            if (debugPreview.length < 1200) {
              debugPreview += content;
            }

            chunkCount++;

            // <-- DEBUG: primi chunk testuali veri
            if (chunkCount <= 10) {
              console.log(`[CHUNK ${chunkCount}]`, JSON.stringify(content));
            }

            if (onChunk) onChunk(content);
          }

          if (data.done) {
            lastMetadata = data;
          }
        } catch (e) {
          // opzionale: log solo se vuoi beccare righe strane
          // console.log("[DEBUG PARSE FAIL LINE]", line);
        }
      }
    }

    // <-- DEBUG: se resta qualcosa nel buffer a fine stream
    if (buffer.trim()) {
      console.log("[DEBUG BUFFER FINALE NON VUOTO]", buffer);
    }

    // <-- DEBUG: lunghezza testo grezzo PRIMA della sanitize
    console.log("[DEBUG] fullReply.length =", fullReply.length);
    console.log("[DEBUG] fullReply preview =", fullReply.slice(0, 1200));

    let cleanReply = sanitizeLLMReply(fullReply, { mode: "auto" });
    cleanReply = bulletsToMarkdown(cleanReply);

    // <-- DEBUG: confronto prima/dopo sanitize
    console.log("[DEBUG] cleanReply.length =", cleanReply.length);
    console.log("[DEBUG] cleanReply preview =", cleanReply.slice(0, 1200));

    // <-- DEBUG: metadata finali completi di Ollama
    console.log("[DEBUG] lastMetadata =", JSON.stringify(lastMetadata, null, 2));

    console.log(
      `[5090 STATS] Prompt: ${lastMetadata.prompt_eval_count || 0} | Gen: ${lastMetadata.eval_count || 0} | Speed: ${
        lastMetadata.eval_duration
          ? (lastMetadata.eval_count / (lastMetadata.eval_duration / 1e9)).toFixed(2)
          : "n/a"
      } tps`
    );

    console.log(`[DEBUG] tempo totale gptReplyStream = ${Date.now() - startedAt} ms`);

    return { 
      reply: cleanReply, 
      prompt: prompt,
      raw: lastMetadata 
    };

  } catch (e) {
    console.error("ERRORE DURANTE LO STREAMING:", e);
    throw e;
  }
}*/
// importa qui:
// STYLE, OLLAMA_URL, MODEL, sanitizeLLMReply, bulletsToMarkdown,
// getTimeAgo, smartTrim

function safeHistoryText(v) {
  return typeof v === "string" ? v.trim() : "";
}

export async function gptReplyStream(
  userPrompt,
  history = [],
  mood = "mood=neutral",
  onChunk,
  intentAnalysis = null
) {
  const startedAt = Date.now();

  // 1. Timing
  const oraAttuale = new Date().toLocaleString("it-IT", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });

  // 2. Ricostruzione storia
  const contextString = history
    .filter(turn => safeHistoryText(turn?.text) !== safeHistoryText(userPrompt))
    .map(turn => {
      const roleName = turn.role === "user" ? "Utente" : "Keblo";
      const quando = getTimeAgo(turn.ts);
      const cleanText = smartTrim(turn.text, 260);
      return `[${quando}] ${roleName}: ${cleanText}`;
    })
    .join("\n");

  // 3. Directives dal router
 const intentDirectives = intentAnalysis?.promptDirectives
  ? intentAnalysis.promptDirectives
  : `[ACTIVE INTERPRETATION]
intent=inform
domain=general
topic=generic
sub_topic=none
need=none
current_turn_wins=true
memory_can_assist=false

[RESPONSE MODE]
style=balanced
first_sentence=answer_first
structure=compact_paragraphs
brevity=0.55
warmth=0.25
technicality=0.4
depth=0.55

[CRITICAL RULES]
- Rispondi alla richiesta attuale.
- Non inferire paure, diagnosi o problemi non espressi.
- Se il turno attuale contraddice il contesto precedente, prevale il turno attuale.`;

const prompt = `
${STYLE}

PRIORITÀ ASSOLUTA:
- Rispondi alla richiesta attuale.
- Non inferire paure, diagnosi, problemi scolastici o stati emotivi non espressi.
- Se il turno attuale contraddice il contesto precedente, prevale il turno attuale.
- Non trasformare riferimenti a figli o famiglia in un problema clinico o emotivo se la richiesta è informativa, grammaticale, scolastica o tecnica.
- Se una frase è ambigua, fai al massimo una chiarificazione breve.

DATI DI SISTEMA:
- ORARIO ATTUALE: ${oraAttuale}
- CLIMA EMOTIVO RECENTE DELL’UTENTE: ${mood}
- NOTA: questo è uno stato generale cumulativo derivato da più turni recenti e non descrive necessariamente il tono o il bisogno del messaggio attuale.
- Il bisogno del turno corrente va dedotto prima di tutto dal testo attuale e dall'intent router.
- STATO: Operativo

INTENT ROUTER E MEMORY STATE:
${intentDirectives}

CRONOLOGIA CONVERSAZIONE
(Usa i timestamp solo come orientamento temporale, non per inventare bisogni):
${contextString || "Nessun contesto precedente."}

DOMANDA ATTUALE:
${userPrompt}

RISPOSTA DI KEBLO:
`.trim();

  console.log("\n" + "=".repeat(60));
  console.log("🧠 NEXUS INJECTION - PROMPT INVIATO ALLA 5090");
  console.log("=".repeat(60));
  console.log(prompt);
  console.log("=".repeat(60) + "\n");

  try {
    const fetchStartedAt = Date.now();

    const res = await fetch(OLLAMA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        prompt,
        stream: true,
        think: false,
        logprobs: true,
        top_logprobs: 5,
        options: {
          temperature: 0.7,
          top_p: 0.9,
          repeat_penalty: 1.1,
          num_ctx: 8192
        }
      })
    });

    if (!res.ok) {
      throw new Error(`Ollama connection error: ${res.status}`);
    }

    const reader = res.body;
    const decoder = new TextDecoder();

    let fullReply = "";
    let lastMetadata = {};
    let buffer = "";
    let firstTokenAt = null;
    let chunkCount = 0;
    let debugPreview = "";
     // LOGPROBS COLLECTION
    const tokenLogprobs = [];
    const weakTokens = [];

    for await (const chunk of reader) {
      buffer += decoder.decode(chunk, { stream: true });

      let lines = buffer.split("\n");
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const data = JSON.parse(line);
         
          if (chunkCount < 5) {
            console.log(`[DEBUG RAW ${chunkCount + 1}]`, data);
          }

          // Raccolta logprobs senza sparare un muro infinito nel terminale
          if (Array.isArray(data.logprobs)) {
            for (const lp of data.logprobs) {
              if (typeof lp?.logprob === "number") {
                const item = {
                  token: lp.token ?? "",
                  logprob: lp.logprob,
                  top_logprobs: Array.isArray(lp.top_logprobs) ? lp.top_logprobs : []
                };

                tokenLogprobs.push(item);

                if (lp.logprob < -2) {
                  weakTokens.push(item);
                }
              }
            }
          }

          if (data.response) {
            if (!firstTokenAt) {
              firstTokenAt = Date.now();
              console.log(`[TTFT] Primo token dopo ${firstTokenAt - fetchStartedAt} ms`);
            }

            const content = data.response;
            fullReply += content;

            if (debugPreview.length < 1200) {
              debugPreview += content;
            }

            chunkCount++;

            if (chunkCount <= 10) {
              console.log(`[CHUNK ${chunkCount}]`, JSON.stringify(content));
            }

            if (onChunk) onChunk(content);
          }

          if (data.done) {
            lastMetadata = data;
          }
        } catch (e) {
          // opzionale: attiva se vuoi loggare righe strane
          // console.log("[DEBUG PARSE FAIL LINE]", line);
        }
      }
    }

    if (buffer.trim()) {
      console.log("[DEBUG BUFFER FINALE NON VUOTO]", buffer);
    }

    console.log("[DEBUG] fullReply.length =", fullReply.length);
    console.log("[DEBUG] fullReply preview =", fullReply.slice(0, 1200));

    let cleanReply = sanitizeLLMReply(fullReply, { mode: "auto" });
    cleanReply = bulletsToMarkdown(cleanReply);

    console.log("[DEBUG] cleanReply.length =", cleanReply.length);
    console.log("[DEBUG] cleanReply preview =", cleanReply.slice(0, 1200));
     // SUMMARY LOGPROBS
    let logprobsSummary = null;

    if (tokenLogprobs.length > 0) {
      const avgLogprob =
        tokenLogprobs.reduce((sum, t) => sum + t.logprob, 0) / tokenLogprobs.length;

      const minLogprob = Math.min(...tokenLogprobs.map(t => t.logprob));

      const worstTokens = [...weakTokens]
        .sort((a, b) => a.logprob - b.logprob)
        .slice(0, 10)
        .map(t => ({
          token: t.token,
          logprob: Number(t.logprob.toFixed(4)),
          top_alternatives: t.top_logprobs.slice(0, 3).map(alt => ({
            token: alt.token,
            logprob: Number(alt.logprob.toFixed(4))
          }))
        }));

      logprobsSummary = {
        tokenCount: tokenLogprobs.length,
        avgLogprob: Number(avgLogprob.toFixed(4)),
        minLogprob: Number(minLogprob.toFixed(4)),
        weakTokenCount: weakTokens.length,
        worstTokens
      };

      console.log("========== LOGPROBS SUMMARY ==========");
      console.log("Token totali:", logprobsSummary.tokenCount);
      console.log("Media logprob:", logprobsSummary.avgLogprob);
      console.log("Min logprob:", logprobsSummary.minLogprob);
      console.log("Token deboli (< -2):", logprobsSummary.weakTokenCount);

      if (logprobsSummary.worstTokens.length) {
        console.log("Peggiori token:");
        for (const t of logprobsSummary.worstTokens) {
          console.log(
            `TOKEN=${JSON.stringify(t.token)} | logprob=${t.logprob} | alt=${JSON.stringify(t.top_alternatives)}`
          );
        }
      }

      console.log("======================================");
    }


    //console.log("[DEBUG] lastMetadata =", JSON.stringify(lastMetadata, null, 2));

    console.log(
      `[5090 STATS] Prompt: ${lastMetadata.prompt_eval_count || 0} | Gen: ${lastMetadata.eval_count || 0} | Speed: ${
        lastMetadata.eval_duration
          ? (lastMetadata.eval_count / (lastMetadata.eval_duration / 1e9)).toFixed(2)
          : "n/a"
      } tps`
    );

    console.log(`[DEBUG] tempo totale gptReplyStream = ${Date.now() - startedAt} ms`);

    return {
      reply: cleanReply,
      prompt,
      raw: lastMetadata
    };
  } catch (e) {
    console.error("ERRORE DURANTE LO STREAMING:", e);
    throw e;
  }
}

export async function gptVisionReplyStream(
  input,
  history = [],
  mood = "mood=neutral",
  onChunk,
  intentAnalysis = null
) {
  const startedAt = Date.now();

  const oraAttuale = new Date().toLocaleString("it-IT", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });

  const contextString = history
    .filter(turn => safeHistoryText(turn?.text) !== safeHistoryText(input.text))
    .map(turn => {
      const roleName = turn.role === "user" ? "Utente" : "Keblo";
      const quando = getTimeAgo(turn.ts);
      const cleanText = smartTrim(turn.text, 260);
      return `[${quando}] ${roleName}: ${cleanText}`;
    })
    .join("\n");

  const intentDirectives = intentAnalysis?.promptDirectives
    ? intentAnalysis.promptDirectives
    : `[ACTIVE INTERPRETATION]
intent=inform
domain=general
topic=generic
sub_topic=none
need=none
current_turn_wins=true
memory_can_assist=false`;

  const prompt = `
${STYLE}

PRIORITÀ ASSOLUTA:
- Rispondi alla richiesta attuale.
- Se sono presenti immagini, trattale come parte integrante del turno utente.
- Non limitarti a descrivere: collega ciò che vedi alla richiesta dell'utente.
- Se un dettaglio visivo non è certo, dichiaralo chiaramente.
- Se il turno attuale contraddice il contesto precedente, prevale il turno attuale.

DATI DI SISTEMA:
- ORARIO ATTUALE: ${oraAttuale}
- CLIMA EMOTIVO RECENTE DELL’UTENTE: ${mood}
- STATO: Operativo

INTENT ROUTER E MEMORY STATE:
${intentDirectives}

CRONOLOGIA CONVERSAZIONE
${contextString || "Nessun contesto precedente."}

DOMANDA ATTUALE:
${input.text || "Analizza l'immagine allegata e rispondi in modo utile."}

RISPOSTA DI KEBLO:
`.trim();

  console.log("\n" + "=".repeat(60));
  console.log("👁️ NEXUS VISION - PROMPT INVIATO ALLA 5090");
  console.log("=".repeat(60));
  console.log(prompt);
  console.log("=".repeat(60) + "\n");

  try {
    const res = await fetch("http://localhost:11434/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen3.5:27b",
        messages: [
          {
            role: "user",
            content: prompt,
            images: input.images.map(img => img.base64)
          }
        ],
        stream: false,
        think: false,
        options: {
          temperature: 0.4,
          top_p: 0.9,
          repeat_penalty: 1.1,
          num_ctx: 8192
        }
      })
    });

    if (!res.ok) {
      throw new Error(`Ollama vision connection error: ${res.status}`);
    }

    const data = await res.json();
    const fullReply = data?.message?.content || "";
    const cleanReply = bulletsToMarkdown(
      sanitizeLLMReply(fullReply, { mode: "auto" })
    );

    if (onChunk && cleanReply) {
      onChunk(cleanReply);
    }

    console.log(`[VISION] tempo totale = ${Date.now() - startedAt} ms`);

    return {
      reply: cleanReply,
      prompt,
      raw: data
    };
  } catch (e) {
    console.error("ERRORE DURANTE LO STREAMING VISION:", e);
    throw e;
  }
}