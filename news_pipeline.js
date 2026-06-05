// news_pipeline.js
import fetch from "node-fetch";

// --- ENV ---
const SERPER_API_KEY = (process.env.SERPER_API_KEY || "").trim();
const RERANKER_URL = process.env.RERANKER_URL || "http://localhost:8000/v1/rerank";
const RERANKER_API_KEY = (process.env.API_KEY || "").trim();

const OLLAMA_NEWS_URL = process.env.OLLAMA_NEWS_URL || "http://localhost:11435/api/generate";
const OLLAMA_NEWS_MODEL = process.env.OLLAMA_NEWS_MODEL || "llama3:8b";

// --- Helpers ---
export function cleanNewsQuery(userText = "") {
  return (userText || "")
    .replace(/ciao|keblo/gi, "")
    .replace(/news|notizie|aggiornami/gi, "")
    .replace(/ricerca|cerca|trova/gi, "")
    .replace(/\b(sul|sulla|su|del|della|dei|delle)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeEventQuery(q = "") {
  return /prossima|quando|orario|calendario|partita|match|fixture|schedule|dove vedere|a che ora/i.test(q);
}

function postCleanLLM(text = "") {
  let t = (text || "").trim();

  // elimina intro “I identified…” / “Here is…” / “Ecco…”
  t = t.replace(/^i identified.*?\n+/i, "");
  t = t.replace(/^here (is|are).*?\n+/i, "");
  t = t.replace(/^ecco.*?:\s*/i, "");

  // elimina markdown residuo
  t = t.replace(/\*\*/g, "");

  // compatta spazi
  t = t.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

  return t;
}

/**
 * 1) Fetch (Serper)
 * - /news per news vere
 * - /search per query “evento/calendario/partita…”
 */
export async function fetchGoogleNews(userText) {
  if (!SERPER_API_KEY) throw new Error("SERPER_API_KEY mancante nel .env");

  const clean = cleanNewsQuery(userText);
  const finalQuery = clean || userText;

  const useSearch = looksLikeEventQuery(finalQuery);
  const endpoint = useSearch ? "https://google.serper.dev/search" : "https://google.serper.dev/news";

  const body = useSearch
    ? { q: finalQuery, gl: "it", hl: "it", num: 15 }
    : { q: finalQuery, gl: "it", hl: "it", num: 10 };

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "X-API-KEY": SERPER_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error("❌ SERPER STATUS:", res.status);
    console.error("❌ SERPER BODY:", errText);
    throw new Error("Errore API Serper");
  }

  const data = await res.json();
  const results = [];

  // /news => data.news[]
  if (!useSearch && Array.isArray(data.news)) {
    for (const n of data.news) {
      results.push({
        title: n.title || "",
        snippet: n.snippet || "",
        url: n.link || "",
      });
    }
    return results;
  }

  // /search => topStories + organic (+ answerBox)
  if (data.topStories) {
    data.topStories.forEach((s) => {
      results.push({
        title: s.title || "",
        snippet: `Fonte: ${s.source || ""} ${s.date ? `- ${s.date}` : ""}`.trim(),
        url: s.link || "",
      });
    });
  }

  if (data.answerBox) {
    results.unshift({
      title: "Risposta Diretta",
      snippet: data.answerBox.answer || data.answerBox.snippet || "",
      url: data.answerBox.link || "",
    });
  }

  if (data.organic) {
    data.organic.forEach((o) => {
      results.push({
        title: o.title || "",
        snippet: o.snippet || "",
        url: o.link || "",
      });
    });
  }

  return results;
}

/**
 * 2) Rerank (BGE)
 */
export async function rerankNews(query, results) {
  if (!results.length) return [];

  const documents = results.map((r, i) => ({
    id: `doc_${i}`,
    text: `${r.title}. ${r.snippet}`.trim(),
  }));

  const headers = { "Content-Type": "application/json" };
  if (RERANKER_API_KEY) headers["X-API-Key"] = RERANKER_API_KEY;

  const res = await fetch(RERANKER_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ query, documents, top_k: 5 }),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error("❌ RERANKER STATUS:", res.status);
    console.error("❌ RERANKER BODY:", errText);
    throw new Error("Errore reranker news");
  }

  const data = await res.json();
  return (data.results || [])
    .sort((a, b) => a.rank - b.rank)
    .map((r) => {
      const index = parseInt(String(r.id).replace("doc_", ""), 10);
      return results[index];
    })
    .filter(Boolean);
}

/**
 * 3) LLM summary (Ollama 8B su GPU1)
 */
export async function buildNewsSnippets(results, topic = "", userText = "") {
  if (!results.length) return "Nessuna notizia rilevante trovata.";

  // contesto pulito (NO bullet, NO markdown)
  const context = results.slice(0, 5).map((r, i) => {
    const t = (r.title || "").trim();
    const s = (r.snippet || "").trim();
    const u = (r.url || "").trim();
    return `Articolo ${i + 1}\nTitolo: ${t}\nContenuto: ${s}\nLink: ${u}`.trim();
  }).join("\n\n");

  const prompt = `
[TASK]
1) Detect the language of the USER REQUEST below.
2) Summarize ONLY what is supported by the articles.
3) Output the final summary in the SAME language detected at step 1.

[USER REQUEST]
${userText}

[TOPIC]
${topic}

[ARTICLES]
${context}

[CONSTRAINTS]
- Output MUST be in the SAME LANGUAGE as the USER REQUEST.
- Plain text only (no markdown, no bullets, no titles).
- No introductions like "Ecco", "Here is", "I identified".
- Max 2 short paragraphs, max 6 sentences total.
- Neutral tone. No opinions. No invented details.

[FINAL SUMMARY]
`.trim();

  const res = await fetch(OLLAMA_NEWS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_NEWS_MODEL,
      prompt,
      stream: false,
      keep_alive: "24h",
      options: {
        temperature: 0.1,
        top_p: 0.9,
        num_predict: 220,
      },
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error("❌ OLLAMA STATUS:", res.status);
    console.error("❌ OLLAMA BODY:", errText);
    throw new Error("Errore Ollama news");
  }

  const data = await res.json();
  return postCleanLLM(data.response || "");
}

/**
 * 4) Entry point
 */
export async function getRelevantNews(userText) {
  const raw = await fetchGoogleNews(userText);
  const top = await rerankNews(userText, raw);
  return top;
}
