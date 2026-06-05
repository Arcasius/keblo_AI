import "dotenv/config";
import fs from "fs/promises";
import path from "path";

const GNEWS_API_KEY = process.env.GNEWS_API_KEY || "";
const WORLD_BRIEF_PATH = process.env.WORLD_BRIEF_PATH || "./storage/world_brief.json";

const MAX_ITALY = Number(process.env.WORLD_BRIEF_MAX_ITALY || 12);
const MAX_WORLD = Number(process.env.WORLD_BRIEF_MAX_WORLD || 12);
const MAX_TECH = Number(process.env.WORLD_BRIEF_MAX_TECH || 6);
const MAX_SCIENCE = Number(process.env.WORLD_BRIEF_MAX_SCIENCE || 6);
const HOURS_BACK = Number(process.env.WORLD_BRIEF_HOURS_BACK || 36);

async function isBriefFresh(filePath, maxMinutes = 30) {
  try {
    const stat = await fs.stat(filePath);
    const ageMs = Date.now() - stat.mtimeMs;
    return ageMs < maxMinutes * 60 * 1000;
  } catch {
    return false;
  }
}

function requireApiKey() {
  if (!GNEWS_API_KEY) {
    throw new Error("GNEWS_API_KEY mancante nel file .env");
  }
}

function isoSince(hoursBack = HOURS_BACK) {
  const d = new Date(Date.now() - hoursBack * 60 * 60 * 1000);
  return d.toISOString();
}

function normalizeText(s = "") {
  return String(s)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function simpleHashTitle(title = "") {
  const t = normalizeText(title)
    .replace(/\b(oggi|ultime|ultimo|ultimi|breaking|live|video|diretta)\b/g, "")
    .trim();
  return t.slice(0, 180);
}

function dedupeArticles(articles = []) {
  const seen = new Set();
  const out = [];

  for (const a of articles) {
    const key = simpleHashTitle(a.title);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }

  return out;
}

function classifyArticle(a) {
  const text = normalizeText(`${a.title} ${a.description}`);

  // GEOPOLITICA / GUERRA (Priorità alta)
  if (/(guerra|war|conflict|ucraina|russia|putin|zelensky|israele|hamas|gaza|iran|missili|attacco|bombardamento|nato|geopolitica|escalation|frontline)/.test(text)) {
    return "geopolitica";
  }
  // ... resto delle categorie come prima ...
  if (/(governo|parlamento|meloni|schlein|salvini|tajani|elezioni|politica)/.test(text)) return "politica";
  if (/(borsa|mercati|inflazione|pil|bce|fed|tassi)/.test(text)) return "economia";
  if (/(ai|intelligenza artificiale|nvidia|openai|software|cyber|hacker)/.test(text)) return "tecnologia";
  if (/(studio|ricerca|medicina|salute|scientific|science|nature)/.test(text)) return "scienza_salute";
  
  return "generale";
}

function normalizeArticle(a, scope = "world") {
  return {
    title: a.title || "",
    description: a.description || "",
    content: a.content || "",
    url: a.url || "",
    image: a.image || null,
    publishedAt: a.publishedAt || null,
    source: a.source?.name || "unknown",
    scope,
    category: classifyArticle(a),
  };
}

function articleToLine(a, idx) {
  const date = a.publishedAt ? new Date(a.publishedAt).toLocaleString("it-IT") : "data n/d";
  return `${idx + 1}. [${a.category}] ${a.title} — ${a.source} — ${date}`;
}

function buildSignals({ italy, world, tech, science }) {
  const all = [...italy, ...world, ...tech, ...science];
  const counts = all.reduce((acc, a) => {
    acc[a.category] = (acc[a.category] || 0) + 1;
    return acc;
  }, {});

  const topCats = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k]) => k);

  const signals = [];

  if (topCats.includes("geopolitica")) {
    signals.push("Segnale forte: geopolitica in primo piano.");
  }
  if (topCats.includes("economia")) {
    signals.push("Segnale forte: economia e mercati molto presenti nel ciclo notizie.");
  }
  if (topCats.includes("politica")) {
    signals.push("Segnale forte: politica italiana tra i temi dominanti.");
  }
  if (topCats.includes("tecnologia")) {
    signals.push("Segnale forte: tecnologia e AI molto presenti.");
  }
  if (topCats.includes("scienza_salute")) {
    signals.push("Segnale forte: salute e ricerca scientifica ben rappresentate.");
  }

  return signals.slice(0, 5);
}

async function fetchGNews({ q, lang = "it", country, max = 10, from }) {
  requireApiKey();

  const url = new URL("https://gnews.io/api/v4/search");
  url.searchParams.set("q", q);
  url.searchParams.set("lang", lang);
  url.searchParams.set("max", String(max));
  url.searchParams.set("apikey", GNEWS_API_KEY);

  if (country) url.searchParams.set("country", country);
  if (from) url.searchParams.set("from", from);

  const res = await fetch(url.toString(), {
    headers: {
      "User-Agent": "KebloWorldBrief/1.0"
    }
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GNews HTTP ${res.status}: ${body}`);
  }

  const data = await res.json();
  return Array.isArray(data.articles) ? data.articles : [];
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchAllNews() {
  const from = isoSince(HOURS_BACK);

  console.log("[WORLD BRIEF] Avvio fetch multi-canale...");


 // 1. ITALIA: Più specifica sulla nazione
  const italyRaw = await fetchGNews({
    q: "politica italiana OR governo meloni OR parlamento OR attualità italia OR cronaca italia", // Query più "stretta"
    lang: "it",
    country: "it",
    max: 15,
    from
  });
  await sleep(1100);

  // 2. GEOPOLITICA E GUERRA (Il pezzo mancante)
  // Usiamo parole chiave forti in inglese per avere fonti internazionali
  const geoRaw = await fetchGNews({
    q: "war OR conflict OR Ukraine OR Gaza OR Israel OR missiles OR geopolitics",
    lang: "en",
    max: 15,
    from
  });
  await sleep(1100);

  // 3. TECNOLOGIA (AI e Tech)
  const techRaw = await fetchGNews({
    q: '"artificial intelligence" OR AI OR Nvidia OR OpenAI OR "cyber security"',
    lang: "en",
    max: 10,
    from
  });
  await sleep(1100);

  // 4. SCIENZA E SALUTE
  const scienceRaw = await fetchGNews({
    q: "science OR medical research OR health OR space exploration",
    lang: "en",
    max: 10,
    from
  });

  // Normalizzazione e Deduplica
  const italy = dedupeArticles(italyRaw.map(a => normalizeArticle(a, "italy"))).slice(0, MAX_ITALY);
  const world = dedupeArticles(geoRaw.map(a => normalizeArticle(a, "world"))).slice(0, MAX_WORLD);
  const tech = dedupeArticles(techRaw.map(a => normalizeArticle(a, "tech"))).slice(0, MAX_TECH);
  const science = dedupeArticles(scienceRaw.map(a => normalizeArticle(a, "science"))).slice(0, MAX_SCIENCE);

  return { italy, world, tech, science };
}

function buildBriefSummarySections({ italy, world, tech, science, signals }) {
  return {
    italy_text: italy.map(articleToLine).join("\n"),
    world_text: world.map(articleToLine).join("\n"),
    tech_text: tech.map(articleToLine).join("\n"),
    science_text: science.map(articleToLine).join("\n"),
    signals_text: signals.map((s, i) => `${i + 1}. ${s}`).join("\n"),
  };
}

export async function buildWorldBrief(forceRefresh = false) {
  if (!forceRefresh && await isBriefFresh(WORLD_BRIEF_PATH, 30)) {
    console.log("[WORLD BRIEF] uso cache esistente");
    return readWorldBrief();
  }

  console.log("[WORLD BRIEF] fetch da GNews...");

  const startedAt = new Date().toISOString();

  const { italy, world, tech, science } = await fetchAllNews();
  const signals = buildSignals({ italy, world, tech, science });
  const summaries = buildBriefSummarySections({ italy, world, tech, science, signals });

  const brief = {
    ok: true,
    generated_at: new Date().toISOString(),
    started_at: startedAt,
    source: "gnews",
    italy,
    world,
    technology: tech,
    science_health: science,
    signals,
    summaries,
    counts: {
      italy: italy.length,
      world: world.length,
      technology: tech.length,
      science_health: science.length,
    }
  };

  const outDir = path.dirname(WORLD_BRIEF_PATH);
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(WORLD_BRIEF_PATH, JSON.stringify(brief, null, 2), "utf-8");

  console.log("[WORLD BRIEF] nuovo brief salvato");
  return brief;
}

export async function readWorldBrief() {
  const raw = await fs.readFile(WORLD_BRIEF_PATH, "utf-8");
  return JSON.parse(raw);
}