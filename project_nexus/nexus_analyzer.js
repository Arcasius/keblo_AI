import path from "path";

const IMPORTANT_FILE_PATTERNS = [
  /^server\.js$/i,
  /^index\.html$/i,
  /^public\/index\.html$/i,
  /^package\.json$/i,
  /^vite\.config\.[^.]+$/i,
  /^docker-compose.*$/i,
  /^\.env\.example$/i,
  /^readme.*$/i,
  /(^|\/)[^/]*_engine\.[^.]+$/i,
  /(^|\/)[^/]*_repo\.[^.]+$/i,
  /(^|\/)[^/]*_pipeline\.[^.]+$/i,
  /(^|\/)[^/]*_router\.[^.]+$/i,
  /(^|\/)workflow.*\.json$/i
];

const DOMAIN_RULES = {
  backend: [/server/i, /express/i, /route/i, /api/i, /controller/i],
  frontend: [/public\//i, /src\//i, /index\.html/i, /\.jsx?$/i, /\.tsx?$/i, /vite/i],
  ai: [/llm/i, /gpt/i, /openai/i, /prompt/i, /model/i, /ai/i],
  memory: [/memory/i, /memoria/i, /orbitale/i, /conversation/i],
  vision: [/vision/i, /image/i, /sharp/i, /camera/i, /ocr/i],
  database: [/db/i, /sqlite/i, /postgres/i, /pg/i, /repo/i, /sql/i],
  agents: [/agent/i, /\.agents\//i],
  networking: [/axios/i, /fetch/i, /http/i, /websocket/i, /socket/i],
  storage: [/storage/i, /files/i, /upload/i, /multer/i],
  ui: [/cards/i, /public\//i, /\.css$/i, /index\.html/i],
  automation: [/scheduler/i, /cron/i, /workflow/i, /pipeline/i, /job/i]
};

function fileMatches(file, patterns) {
  return patterns.some((pattern) => pattern.test(file.relativePath));
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function detectStack(files) {
  const names = new Set(files.map((file) => file.relativePath.toLowerCase()));
  const imports = files.flatMap((file) => file.imports || []).join(" ").toLowerCase();
  const extensions = new Set(files.map((file) => file.extension));
  const stack = [];

  if (names.has("package.json") || extensions.has(".js") || extensions.has(".mjs")) stack.push("Node.js");
  if (imports.includes("express") || names.has("server.js")) stack.push("Express");
  if (imports.includes("vite") || [...names].some((name) => name.startsWith("vite.config."))) stack.push("Vite");
  if (extensions.has(".ts") || extensions.has(".tsx")) stack.push("TypeScript");
  if (extensions.has(".jsx") || extensions.has(".tsx") || imports.includes("react")) stack.push("React");
  if (imports.includes("pg") || imports.includes("postgres")) stack.push("PostgreSQL");
  if (imports.includes("sqlite") || [...names].some((name) => name.endsWith(".sqlite"))) stack.push("SQLite");
  if (imports.includes("multer")) stack.push("Multer uploads");
  if (imports.includes("node-cron") || imports.includes("cron")) stack.push("Cron scheduler");
  if (imports.includes("sharp")) stack.push("Sharp image processing");

  return unique(stack);
}

function detectDomains(files, folders) {
  const domainScores = {};
  const corpus = [
    ...files.map((file) => `${file.relativePath} ${(file.imports || []).join(" ")}`),
    ...folders.map((folder) => folder.relativePath)
  ];

  for (const [domain, rules] of Object.entries(DOMAIN_RULES)) {
    const hits = corpus.filter((text) => rules.some((rule) => rule.test(text))).length;
    if (hits > 0) domainScores[domain] = hits;
  }

  return Object.entries(domainScores)
    .sort((a, b) => b[1] - a[1])
    .map(([name, score]) => ({ name, score }));
}

function detectEntrypoints(files) {
  const preferred = [
    "server.js",
    "app.js",
    "index.js",
    "src/index.js",
    "src/main.js",
    "src/main.ts",
    "public/index.html",
    "index.html",
    "package.json"
  ];

  const byPath = new Map(files.map((file) => [file.relativePath, file]));
  const entrypoints = preferred.filter((name) => byPath.has(name)).map((name) => byPath.get(name));

  return entrypoints.map((file) => ({
    path: file.relativePath,
    size: file.size,
    imports: file.imports
  }));
}

function detectArchitecture(files, folders) {
  const topFolders = folders
    .filter((folder) => folder.depth === 1)
    .map((folder) => folder.relativePath)
    .sort();

  const hasPublic = topFolders.includes("public");
  const hasSrc = topFolders.includes("src");
  const hasServer = files.some((file) => file.relativePath === "server.js");
  const hasRepos = files.some((file) => /_repo\.[^.]+$/i.test(file.name));
  const hasPipelines = files.some((file) => /_pipeline\.[^.]+$/i.test(file.name));

  const notes = [];
  if (hasServer) notes.push("Backend Express concentrato attorno a server.js.");
  if (hasPublic) notes.push("Frontend statico presente in public/.");
  if (hasSrc) notes.push("Codice modulare presente in src/.");
  if (hasRepos) notes.push("Persistenza organizzata con moduli *_repo.");
  if (hasPipelines) notes.push("Workflow applicativi organizzati con moduli *_pipeline.");

  return {
    topFolders,
    notes
  };
}

function detectRisks(scanResult, criticalFiles) {
  const risks = [];

  if (scanResult.stats.skippedLargeFiles > 0) {
    risks.push({
      level: "medium",
      area: "scan",
      message: `${scanResult.stats.skippedLargeFiles} file troppo grandi saltati dalla scansione.`
    });
  }

  if (scanResult.stats.scannedFiles >= 1800) {
    risks.push({
      level: "medium",
      area: "scale",
      message: "Il progetto e' vicino al limite file della scansione read-only."
    });
  }

  if (criticalFiles.some((file) => file.path === "server.js" && file.size > 120 * 1024)) {
    risks.push({
      level: "high",
      area: "architecture",
      message: "server.js e' molto grande: rischio di accoppiamento e regressioni su modifiche backend."
    });
  }

  if (!criticalFiles.some((file) => /^readme/i.test(path.basename(file.path)))) {
    risks.push({
      level: "low",
      area: "documentation",
      message: "README non rilevato tra i file scansionati."
    });
  }

  for (const warning of scanResult.warnings || []) {
    risks.push({
      level: "low",
      area: "permissions",
      message: warning
    });
  }

  return risks;
}

function recommendedFixes(risks, architecture) {
  const fixes = [];

  if (architecture.notes.some((note) => note.includes("server.js"))) {
    fixes.push("Separare gradualmente route, storage e servizi dal server principale.");
  }

  if (risks.some((risk) => risk.area === "documentation")) {
    fixes.push("Aggiungere un README tecnico sintetico con avvio, variabili ambiente e struttura moduli.");
  }

  if (risks.some((risk) => risk.area === "scan")) {
    fixes.push("Configurare ignore o limiti dedicati per asset/runtime data pesanti.");
  }

  return unique(fixes);
}

export function analyzeProject(scanResult) {
  const files = scanResult.files || [];
  const folders = scanResult.folders || [];
  const stack = detectStack(files);
  const domains = detectDomains(files, folders);
  const entrypoints = detectEntrypoints(files);
  const architecture = detectArchitecture(files, folders);
  const criticalFiles = files
    .filter((file) => fileMatches(file, IMPORTANT_FILE_PATTERNS))
    .map((file) => ({
      path: file.relativePath,
      name: file.name,
      size: file.size,
      imports: file.imports
    }))
    .sort((a, b) => a.path.localeCompare(b.path));

  const risks = detectRisks(scanResult, criticalFiles);
  const fixes = recommendedFixes(risks, architecture);
  const domainNames = domains.map((domain) => domain.name);
  const summary = [
    `${scanResult.projectName} contiene ${scanResult.stats.scannedFiles} file scansionati e ${folders.length} cartelle entro profondita' ${scanResult.stats.maxDepthReached}.`,
    stack.length ? `Stack rilevato: ${stack.join(", ")}.` : "Stack non determinato dai file scansionati.",
    domainNames.length ? `Domini principali: ${domainNames.slice(0, 6).join(", ")}.` : "Domini tecnici non rilevati con confidenza sufficiente."
  ].join(" ");

  return {
    projectName: scanResult.projectName,
    projectId: scanResult.projectId,
    rootPath: scanResult.rootPath,
    summary,
    stack,
    architecture,
    entrypoints,
    domains,
    criticalFiles,
    risks,
    recommendedFixes: fixes,
    stats: scanResult.stats
  };
}
