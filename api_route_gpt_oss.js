// --- ROTTE PROTETTE API/CHAT Principale---per GPT oss
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

  const userId = req.session.user.id;
  await ensureConversationSession(userId);

  const { text } = req.body;
  const t = (text || "").trim().toLowerCase();

  if (t === "init_session" || t === "ping" || t === "session") {
    sendEvent({ type: "done", reply: "ok", card: null, meta: { tokenUsed: 0, tokenLimit: 10000000, blocked: false } });
    return res.end();
  }

  // Salva messaggio utente
  await appendTurn(userId, { 
    role: "user", 
    text,
    meta: { tokenUsed: 0, tokenLimit: 10000, blocked: false }
  });

  userAudit(userId, "CHAT_INPUT", { chars: text.length });

  try {
    // --- 🚀 INIEZIONE EMA (IL CUORE EMOTIVO) ---
    // 1. Otteniamo l'oggetto completo dei dati emotivi
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
      options: {
        temperature: 0.01,
        num_ctx: 2048
      }
    })
  });

  const data = await response.json();
  return data.response;
}
});


    // 2. ESTRAZIONE DELLA MOOD LINE (Il fix di Aiden)  Pulizia: togliamo "mood=" e prendiamo la prima parola prima del +
  
    const currentMood = emoData?.promptEmotion?.mood_line ?? "mood=neutral";
    const primaryMood = currentMood.split('=')[1].split('+')[0];


    console.log(`[FRONTEND-SYNC] Invio mood alla mascotte: ${primaryMood}`);
    console.log(`[EMA] MoodLine per ${userId}: ${currentMood}`);

    // 1️⃣ Recupero storia Green
    const history = await readLastGreenExchanges(userId, 8);

    // 2️⃣ Engine - Ora currentMood è una stringa pulita!
    const result = await processInput(
      text,
      req.session.user.state,
      history,
      currentMood 
    );
    console.log("RESULT META RICEVUTO:", result.meta);

    const metaEngine = result.meta || {};

     
    // --- 🚀 CALCOLO PRESTAZIONI (Tokens/Sec) ---
    const evalCount = result.meta?.eval_count || 0;
    const evalDuration = result.meta?.eval_duration || 1; // Evitiamo divisione per 0
    
    // Formula: Token generati / (Durata in nanosecondi / 1 miliardo)
    const tps = (evalCount / (evalDuration / 1_000_000_000)).toFixed(2);
    
    // Calcoliamo il totale reale (Input + Output)
    const totalTokens = (result.meta?.prompt_eval_count || 0) + evalCount;
    const promptTokens = result.meta?.prompt_eval_count || 0; // <--- Recuperiamo i token del prompt

    const finalMeta = {
      tokenUsed: totalTokens,
      tokenLimit: 10000,
      promptTokens: promptTokens, //lunghezza prompt
      speed: tps, // velocità nei meta
      blocked: totalTokens >= 10000
    };

    // 4️⃣ Salvataggio assistant
    const saved = await appendTurn(userId, {
      role: "assistant",
      text: result.reply,
      traffic: "yellow",
      confidence: 0.5,
      card: result.card ?? null,
      meta: finalMeta
    });

    if (req.session.user.state.memoryContext) {
      req.session.user.state.memoryContext = null;
    }

    // 5️⃣ INVIO EVENTO CON METRICHE AGGIORNATE
    sendEvent({
      type: "done",
      reply: result.reply,
      ts: saved.ts,
      mood: primaryMood, 
      card: result.card ?? null,
      meta: finalMeta // <--- Invia tps e tokenUsed reali
    });
    

    res.end();
  } catch (err) {
    console.error(err);
    // ... gestione errore (identica alla tua) ...
    res.end();
  }
});*/