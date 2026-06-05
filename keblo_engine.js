import { estimateTokens, consumeTokens, checkLimit } from "./token_manager.js";
import { maybeShowCard } from "./cards.js";
import { gptReply,gptReplyStream,gptVisionReplyStream } from "./llm_router.js";
import { saveCard } from "./memory_store.js";
import { prepareImage } from "./image_utils.js";

export async function initialState() {
  return {
    tokenUsed: 0,
    tokenLimit: 10000,
    blocked: false,
    activeCard: null
  }; 
}
/*Process Input GPT OSS
export async function processInput(text, state, history = [], mood = "mood=neutral") {
  // 1. --- FIX STATO: Aggiunto 'await' perché initialState è async ---
  if (!state) state = await initialState(); 
  
  if (typeof state.tokenUsed !== 'number') state.tokenUsed = 0;
  if (typeof state.tokenLimit !== 'number') state.tokenLimit = 10000;

  console.log("[ENGINE] INPUT", { text, mood });

  // 2. 🔒 Controllo blocco Token
  if (state.blocked) {
    return {
      reply: "Hai esaurito i token disponibili.",
      card: null,
      meta: { tokenUsed: state.tokenUsed, tokenLimit: state.tokenLimit, blocked: true }
    };
  }

  // 3. 🔢 Consuma token INPUT
  consumeTokens(state, text);

  // 4. 🧠 Card logic
  const card = maybeShowCard(text, state);
  if (card) {
    state.activeCard = card;
    const reply = `Vuoi salvare questa ${card.title.toLowerCase()}?`;
    consumeTokens(state, reply);
    return {
      reply,
      card,
      meta: { tokenUsed: state.tokenUsed, tokenLimit: state.tokenLimit, blocked: checkLimit(state) }
    };
  }

  // 5. 🤖 LLM (Ollama) - Chiamata al router
  const result = await gptReply(text, history, mood);

  // 6. 🔢 Consuma token OUTPUT (result ora è un oggetto {reply, prompt})
  consumeTokens(state, result.reply);
  const blocked = checkLimit(state);

  // 🚀 RITORNO FINALE con GPToss
  // DENTRO processInput (File Engine)
  
const out = {
    reply: result.reply,
    prompt: result.prompt,
    card: null,
    raw: result.raw,
    meta: {
      tokenUsed: state.tokenUsed,
      tokenLimit: state.tokenLimit,
      blocked: blocked,
      // 🚀 AGGIUNGI QUESTO CAMPO QUI:
      prompt_eval_count: result.raw?.prompt_eval_count, 
      eval_count: result.raw?.eval_count, 
      eval_duration: result.raw?.eval_duration
    }
};

  console.log("[ENGINE] EXIT (LLM)");
  return out;
}*/
// keblo_engine.js

//Bakcup Process input 29/03/2026
/*
export async function processInput(text, state, history = [], mood = "mood=neutral", onChunk) {
  // 1. --- FIX STATO: Aggiunto 'await' perché initialState è async ---
  if (!state) state = await initialState(); 
  
  if (typeof state.tokenUsed !== 'number') state.tokenUsed = 0;
  if (typeof state.tokenLimit !== 'number') state.tokenLimit = 10000;

  console.log("[ENGINE] INPUT", { text, mood });

  // 2. 🔒 Controllo blocco Token
  if (state.blocked) {
    return {
      reply: "Hai esaurito i token disponibili.",
      card: null,
      meta: { tokenUsed: state.tokenUsed, tokenLimit: state.tokenLimit, blocked: true }
    };
  }

  // 3. 🔢 Consuma token INPUT
  consumeTokens(state, text);

  // 4. 🧠 Card logic
  const card = maybeShowCard(text, state);
  if (card) {
    state.activeCard = card;
    const reply = `Vuoi salvare questa ${card.title.toLowerCase()}?`;
    consumeTokens(state, reply);
    
    // Se c'è una card, simuliamo un micro-chunk per coerenza o restituiamo subito
    if (onChunk) onChunk(reply); 

    return {
      reply,
      card,
      meta: { tokenUsed: state.tokenUsed, tokenLimit: state.tokenLimit, blocked: checkLimit(state) }
    };
  }

  // 5. 🤖 LLM (Ollama) - Chiamata al router con STREAMING
  // Passiamo onChunk alla funzione gptReplyStream nel llm_router
  const result = await gptReplyStream(text, history, mood, onChunk);

  // 6. 🔢 Consuma token OUTPUT (result ora è un oggetto {reply, prompt, raw})
  consumeTokens(state, result.reply);
  const blocked = checkLimit(state);

  // 🚀 RITORNO FINALE OTTIMIZZATO PER QWEN/5090
  const out = {
    reply: result.reply,
    prompt: result.prompt,
    card: null,
    raw: result.raw || {}, // Contiene i dati di Ollama (eval_count, ecc.)
    meta: {
      tokenUsed: state.tokenUsed,
      tokenLimit: state.tokenLimit,
      blocked: blocked,
      // Usiamo || 0 per evitare gli errori di undefined visti prima
      prompt_eval_count: result.raw?.prompt_eval_count || 0, 
      eval_count: result.raw?.eval_count || 0, 
      eval_duration: result.raw?.eval_duration || 1
    }
};

  console.log(`[ENGINE] EXIT - Gen: ${out.meta.eval_count} tokens`);
  return out;
}*/
// importa qui:
// initialState, consumeTokens, checkLimit, maybeShowCard, gptReplyStream

export async function processInput(
  input,
  state,
  history = [],
  mood = "mood=neutral",
  onChunk,
  intentAnalysis = null
) {
  if (!state) state = await initialState();
  if (typeof state.tokenUsed !== "number") state.tokenUsed = 0;
  if (typeof state.tokenLimit !== "number") state.tokenLimit = 10000;

  const rawText = typeof input === "string" ? input : (input?.text || "");
  const rawImages = Array.isArray(input?.images) ? input.images : [];

  const normalizedText = rawText.trim();

  console.log("[ENGINE] INPUT", {
    text: normalizedText,
    mood,
    images: rawImages.length,
    intent: intentAnalysis?.refinedIntent?.primaryIntent || null,
    domain: intentAnalysis?.refinedIntent?.primaryDomain || null,
    topic: intentAnalysis?.shortMemory?.activeTopic || null
  });

  if (state.blocked) {
    return {
      reply: "Hai esaurito i token disponibili.",
      card: null,
      meta: {
        tokenUsed: state.tokenUsed,
        tokenLimit: state.tokenLimit,
        blocked: true
      }
    };
  }

  consumeTokens(state, normalizedText);

  const card = maybeShowCard(normalizedText, state);
  if (card) {
    state.activeCard = card;

    const reply = `Vuoi salvare questa ${card.title.toLowerCase()}?`;
    consumeTokens(state, reply);

    if (onChunk) onChunk(reply);

    return {
      reply,
      card,
      meta: {
        tokenUsed: state.tokenUsed,
        tokenLimit: state.tokenLimit,
        blocked: checkLimit(state)
      }
    };
  }

  const preparedImages = [];

  for (const img of rawImages) {
    if (!img?.path) continue;

    try {
      const base64 = await prepareImage(img.path);

      preparedImages.push({
        name: img.name || null,
        path: img.path,
        mime: img.mime || "image/jpeg",
        base64
      });
    } catch (err) {
      console.error("[VISION] Errore preprocess immagine:", img?.path, err);
    }
  }

  const hasImages = preparedImages.length > 0;

  const result = hasImages
    ? await gptVisionReplyStream(
        {
          text: normalizedText,
          images: preparedImages
        },
        history,
        mood,
        onChunk,
        intentAnalysis
      )
    : await gptReplyStream(
        normalizedText,
        history,
        mood,
        onChunk,
        intentAnalysis
      );

  consumeTokens(state, result.reply);
  const blocked = checkLimit(state);

  const out = {
    reply: result.reply,
    prompt: result.prompt,
    card: null,
    raw: result.raw || {},
    meta: {
      tokenUsed: state.tokenUsed,
      tokenLimit: state.tokenLimit,
      blocked,
      prompt_eval_count: result.raw?.prompt_eval_count || 0,
      eval_count: result.raw?.eval_count || 0,
      eval_duration: result.raw?.eval_duration || 1,
      multimodal: hasImages,
      imageCount: preparedImages.length
    }
  };

  console.log(`[ENGINE] EXIT - Gen: ${out.meta.eval_count} tokens`);
  return out;
}
