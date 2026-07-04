function asArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function includesAny(text, patterns) {
  const haystack = String(text || "").toLowerCase();
  return patterns.some((pattern) => haystack.includes(pattern));
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function fileText(file) {
  return `${file.relativePath || file.path || ""} ${file.name || ""} ${asArray(file.imports).join(" ")}`;
}

function findFiles(files, patterns) {
  return files.filter((file) => includesAny(fileText(file), patterns));
}

function hasFile(files, patterns) {
  return findFiles(files, patterns).length > 0;
}

function describePurpose(analysis, files) {
  const domains = asArray(analysis.domains).map((domain) => domain.name || domain);
  const stack = asArray(analysis.stack);
  const signals = [];

  if (stack.includes("Express") || hasFile(files, ["server.js"])) signals.push("backend Express locale");
  if (hasFile(files, ["public/index.html"])) signals.push("dashboard frontend monolitica a card");
  if (hasFile(files, ["llm_router", "gpt", "ollama", "openai"])) signals.push("orchestrazione LLM/AI");
  if (hasFile(files, ["conversation_repo", "intent_memory_router", "orbitale", "memory"])) signals.push("memoria conversazionale e orbitale");
  if (hasFile(files, ["news_pipeline", "pubmed", "rss"])) signals.push("pipeline informative e news");
  if (hasFile(files, ["vision", "image", "sharp"])) signals.push("workflow visione/immagini");

  return signals.length
    ? `Il progetto appare come un workspace AI locale che combina ${signals.join(", ")}. Domini rilevati: ${domains.slice(0, 6).join(", ") || "non classificati"}.`
    : analysis.summary || "Scopo non deducibile con confidenza dai metadati dello snapshot.";
}

function buildCoreComponents(files) {
  const components = [];
  const rules = [
    ["Backend Express", ["server.js", "express", "/api/"], "Nodo centrale HTTP/API e coordinamento servizi."],
    ["Frontend dashboard", ["public/index.html", "card", "spawncard"], "Interfaccia utente monolitica basata su card operative."],
    ["LLM router", ["llm_router", "gpt", "ollama", "openai"], "Instradamento richieste AI e generazione risposte."],
    ["Memoria conversazionale", ["conversation_repo", "intent_memory_router", "memory", "orbitale"], "Persistenza e recupero del contesto conversazionale."],
    ["Pipeline news", ["news_pipeline", "pubmed", "rss"], "Acquisizione, ricerca e sintesi di contenuti esterni."],
    ["Vision workflow", ["vision", "image", "sharp", "camera", "ocr"], "Funzioni di generazione, analisi o gestione immagini."],
    ["Storage locale", ["storage", "upload", "multer", "files"], "Persistenza filesystem per utenti, upload, snapshot e runtime data."],
    ["Scheduler", ["scheduler", "cron", "world_brief"], "Job periodici e aggiornamenti automatici."]
  ];

  for (const [name, patterns, role] of rules) {
    const matches = findFiles(files, patterns).slice(0, 8).map((file) => file.relativePath || file.path || file.name);
    if (matches.length) components.push({ name, role, files: matches });
  }

  return components;
}

function detectWeaknesses(analysis, files, stats) {
  const weaknesses = [];
  const server = files.find((file) => file.relativePath === "server.js");
  const index = files.find((file) => file.relativePath === "public/index.html" || file.relativePath === "index.html");
  const testFiles = files.filter((file) => /(^|\/)(test|tests|__tests__)|\.test\.|\.spec\./i.test(file.relativePath || ""));
  const jsFiles = files.filter((file) => [".js", ".mjs", ".cjs"].includes(file.extension));
  const tsFiles = files.filter((file) => [".ts", ".tsx"].includes(file.extension));

  if (server && server.size > 120 * 1024) weaknesses.push("server.js e' molto grande: molte responsabilita' backend sembrano concentrate in un solo file.");
  if (index && index.size > 180 * 1024) weaknesses.push("public/index.html e' molto grande: UI, CSS e logica client sembrano accoppiati in modo fragile.");
  if (!testFiles.length) weaknesses.push("Non sono stati rilevati test automatici significativi nello snapshot.");
  if (jsFiles.length && tsFiles.length) weaknesses.push("Coesistono JavaScript e TypeScript: possibile duplicazione o confine non chiaro tra runtime e moduli tipizzati.");
  if ((stats.scannedFiles || 0) > 1000) weaknesses.push("Numero di file elevato per una scansione locale: serve disciplina su ignore, storage runtime e asset generati.");
  if (hasFile(files, [".env"]) && !hasFile(files, [".env.example"])) weaknesses.push("Sono presenti segnali di file ambiente ma non e' evidente un template .env.example.");

  return weaknesses;
}

function detectTechnicalDebt(analysis, files) {
  const debt = [];
  const criticalPaths = asArray(analysis.criticalFiles).map((file) => file.path || file.relativePath || "");

  if (criticalPaths.includes("server.js")) debt.push("Separare progressivamente route Express, servizi applicativi e adapter storage dal server principale.");
  if (criticalPaths.includes("public/index.html")) debt.push("Estrarre componenti/card e funzioni client da public/index.html in moduli piu' piccoli.");
  if (hasFile(files, ["storage/users", "output/", "uploads", "chat_images", "audio"])) debt.push("Verificare che file runtime, output generati e dati utente non finiscano in commit.");
  if (hasFile(files, ["project_nexus"])) debt.push("Consolidare Project Nexus come modulo con contratti stabili tra scan, audit, storage e UI.");
  if (!hasFile(files, ["test", ".spec.", ".test."])) debt.push("Aggiungere test smoke per API critiche e funzioni pure come analyzer/auditor.");

  return unique(debt);
}

function detectStrengths(analysis, files) {
  const strengths = [];
  const stack = asArray(analysis.stack);

  if (stack.length) strengths.push(`Stack riconoscibile dai metadati: ${stack.join(", ")}.`);
  if (asArray(analysis.entrypoints).length) strengths.push("Entrypoint principali identificabili, utile per orientare interventi incrementali.");
  if (hasFile(files, ["_repo", "pipeline", "router", "scheduler"])) strengths.push("Sono presenti moduli con responsabilita' nominate: repo, pipeline, router o scheduler.");
  if (hasFile(files, ["project_nexus"])) strengths.push("Project Nexus introduce snapshot read-only e audit separati dal codice applicativo.");
  if (hasFile(files, ["storage"])) strengths.push("Persistenza locale esplicita, utile per debug e sviluppo offline.");

  return strengths.length ? strengths : ["Lo snapshot fornisce una base leggibile per audit incrementali e prompt Codex mirati."];
}

function buildCodexStrategy(analysis, weaknesses, debt) {
  const entrypoints = asArray(analysis.entrypoints).map((entry) => entry.path).filter(Boolean);
  const firstTargets = unique([...entrypoints, "server.js", "public/index.html"]).slice(0, 6);

  return [
    `Prima leggere i file reali necessari, partendo da: ${firstTargets.join(", ") || "entrypoint rilevati nello snapshot"}.`,
    "Separare scan/audit/fix: usare Nexus per orientare il lavoro, poi modificare solo file letti nel workspace.",
    weaknesses.length ? `Priorita': ridurre i punti fragili maggiori (${weaknesses.slice(0, 2).join(" | ")}).` : "Priorita': mantenere interventi piccoli e verificabili.",
    debt.length ? `Debito da trattare in step piccoli: ${debt.slice(0, 3).join(" | ")}.` : "Aggiungere test mirati prima di cambiare flussi condivisi."
  ];
}

export function generateProjectAudit(snapshot) {
  const analysis = snapshot?.analysis || snapshot || {};
  const scan = snapshot?.scan || {};
  const files = asArray(scan.files);
  const stats = analysis.stats || scan.stats || {};
  const risks = asArray(analysis.risks);
  const recommendedFixes = asArray(analysis.recommendedFixes);
  const coreComponents = buildCoreComponents(files);
  const weaknesses = detectWeaknesses(analysis, files, stats);
  const technicalDebt = detectTechnicalDebt(analysis, files);
  const strengths = detectStrengths(analysis, files);
  const architectureNotes = asArray(analysis.architecture?.notes);
  const topFolders = asArray(analysis.architecture?.topFolders);

  const projectId = snapshot?.projectId || analysis.projectId || "unknown_project";
  const projectName = snapshot?.projectName || analysis.projectName || projectId;
  const rootPath = snapshot?.rootPath || analysis.rootPath || scan.rootPath || "";
  const auditedAt = new Date().toISOString();

  const architectureOverview = [
    analysis.summary,
    architectureNotes.length ? architectureNotes.join(" ") : "",
    topFolders.length ? `Cartelle top-level: ${topFolders.join(", ")}.` : ""
  ].filter(Boolean).join(" ");

  const coreFlow = [
    "Richieste utente e UI partono dalla dashboard/card frontend.",
    hasFile(files, ["server.js", "express"]) ? "Le API Express centralizzano autenticazione, routing e accesso ai servizi." : null,
    hasFile(files, ["llm_router", "gpt", "ollama"]) ? "Le richieste AI passano dal router LLM e dai moduli di pipeline." : null,
    hasFile(files, ["conversation_repo", "memory", "orbitale"]) ? "Contesto e memoria vengono persistiti tramite repository locali e memoria orbitale." : null,
    hasFile(files, ["storage"]) ? "Snapshot, upload e dati runtime sono salvati su filesystem locale." : null
  ].filter(Boolean);

  const currentState = [
    `Snapshot con ${stats.scannedFiles || 0} file scansionati, ${stats.folders || 0} cartelle e profondita' massima ${stats.maxDepthReached || 0}.`,
    risks.length ? `${risks.length} rischi gia' rilevati dall'analyzer.` : "Analyzer non segnala rischi strutturali espliciti.",
    weaknesses.length ? "Il sistema e' operativo ma presenta concentrazione di responsabilita' e/o assenza di test." : "Stato leggibile e adatto a interventi incrementali."
  ];

  const nextSteps = unique([
    ...recommendedFixes.slice(0, 6),
    ...technicalDebt.slice(0, 6),
    "Aggiungere smoke test per API Nexus e flussi frontend critici.",
    "Documentare quali directory sono runtime e quali sono sorgenti versionabili."
  ]).slice(0, 10);

  const codexStrategy = buildCodexStrategy(analysis, weaknesses, technicalDebt);

  return {
    projectId,
    projectName,
    auditedAt,
    rootPath,
    projectPurpose: describePurpose(analysis, files),
    architectureOverview: architectureOverview || "Architettura non deducibile con confidenza dai metadati disponibili.",
    coreComponents,
    coreFlow,
    strengths,
    weaknesses,
    risks,
    technicalDebt,
    currentState,
    recommendedFixes,
    nextSteps,
    codexStrategy,
    auditSummary: `${projectName}: audit tecnico generato da snapshot read-only. Focus principale: ${weaknesses[0] || risks[0]?.message || "mantenere separazione tra scan, audit e interventi Codex mirati"}.`
  };
}
