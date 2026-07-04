import fetch from "node-fetch";

const DEFAULT_OLLAMA_URL = process.env.NEXUS_DEEP_AUDIT_OLLAMA_URL || "http://localhost:11434/api/generate";
const DEFAULT_MODEL = process.env.NEXUS_DEEP_AUDIT_MODEL || "qwen3.5:27b";
const DEFAULT_TIMEOUT_MS = Number(process.env.NEXUS_DEEP_AUDIT_TIMEOUT_MS || 120000);

function asArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function compactFile(file) {
  return {
    path: file.relativePath || file.path || file.name,
    size: file.size,
    imports: asArray(file.imports).slice(0, 12)
  };
}

function snapshotForPrompt(snapshot, heuristicAudit) {
  const analysis = snapshot?.analysis || snapshot || {};
  const scan = snapshot?.scan || {};
  const files = asArray(scan.files);

  return {
    projectId: snapshot?.projectId || analysis.projectId,
    projectName: snapshot?.projectName || analysis.projectName,
    rootPath: snapshot?.rootPath || analysis.rootPath || scan.rootPath,
    summary: analysis.summary,
    stack: asArray(analysis.stack),
    architecture: analysis.architecture || {},
    entrypoints: asArray(analysis.entrypoints),
    domains: asArray(analysis.domains),
    criticalFiles: asArray(analysis.criticalFiles).slice(0, 40),
    risks: asArray(analysis.risks),
    recommendedFixes: asArray(analysis.recommendedFixes),
    stats: analysis.stats || scan.stats || {},
    importantFiles: files
      .filter((file) => /server\.js|public\/index\.html|llm|memory|orbitale|conversation|router|pipeline|vision|storage|scheduler|repo|package\.json/i.test(file.relativePath || file.path || file.name || ""))
      .slice(0, 120)
      .map(compactFile),
    heuristicAudit: heuristicAudit ? {
      auditSummary: heuristicAudit.auditSummary,
      projectPurpose: heuristicAudit.projectPurpose,
      weaknesses: asArray(heuristicAudit.weaknesses),
      technicalDebt: asArray(heuristicAudit.technicalDebt),
      nextSteps: asArray(heuristicAudit.nextSteps),
      codexStrategy: heuristicAudit.codexStrategy
    } : null
  };
}

function buildDeepAuditPrompt(snapshot, heuristicAudit) {
  const context = snapshotForPrompt(snapshot, heuristicAudit);
  return `
Agisci come senior software architect. Devi produrre un AUDIT TECNICO APPROFONDITO in JSON valido.

Usa SOLO lo snapshot qui sotto. Non inventare file non presenti nello snapshot. Non assumere contenuto completo dei file.
Se una cosa e' inferita, dichiarala come inferenza nel testo.

Obiettivi:
- Spiega cos'e' questo progetto.
- Spiega cosa non e'.
- Ricostruisci l'architettura reale.
- Identifica componenti core e flussi principali.
- Evidenzia Memoria Orbitale se emergono segnali memory/memoria/orbitale/conversation_repo/intent_memory_router.
- Evidenzia rischi tecnici e debito tecnico.
- Suggerisci fix ordinati per priorita'.
- Per ogni fix suggerisci un prompt Codex breve.
- Indica cosa non rompere.

Rispondi SOLO con JSON valido, senza markdown, con questa struttura:
{
  "executiveSummary": "...",
  "whatThisProjectIs": "...",
  "whatThisProjectIsNot": "...",
  "architecture": {
    "overview": "...",
    "backend": "...",
    "frontend": "...",
    "memoryOrbitale": "...",
    "aiLayer": "...",
    "storage": "...",
    "vision": "...",
    "automation": "..."
  },
  "coreFlows": [
    { "name": "Chat flow", "description": "...", "files": ["..."] }
  ],
  "strengths": [],
  "weaknesses": [],
  "risks": [],
  "technicalDebt": [],
  "memoryOrbitaleAssessment": {
    "summary": "...",
    "files": [],
    "risks": [],
    "recommendedFixes": []
  },
  "recommendedFixes": [
    {
      "title": "...",
      "priority": "high",
      "area": "backend",
      "reason": "...",
      "suggestedCodexPrompt": "..."
    }
  ],
  "nextSteps": [],
  "codexStrategy": "...",
  "dontBreak": [],
  "openQuestions": []
}

Snapshot:
${JSON.stringify(context, null, 2)}
`.trim();
}

function extractJsonObject(text) {
  const cleaned = String(text || "").trim().replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(cleaned.slice(start, end + 1));
    }
    throw new Error("LLM response is not valid JSON.");
  }
}

function fallbackFixesFromText(rawText) {
  return String(rawText || "")
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-*•]\s*/, ""))
    .filter((line) => /fix|refactor|test|separa|riduci|aggiungi|migliora|rischio|debito/i.test(line))
    .slice(0, 8)
    .map((line, index) => ({
      title: line.slice(0, 120),
      priority: index < 2 ? "high" : "medium",
      area: "backend",
      reason: "Estratto da risposta LLM non JSON.",
      suggestedCodexPrompt: `Implementa questo fix in modo incrementale: ${line.slice(0, 180)}`
    }));
}

function normalizeFix(fix, index) {
  const priority = ["high", "medium", "low"].includes(fix?.priority) ? fix.priority : (index < 2 ? "high" : "medium");
  const area = ["backend", "frontend", "memory", "ai", "storage", "security", "ux"].includes(fix?.area) ? fix.area : "backend";
  return {
    title: String(fix?.title || `Fix consigliato ${index + 1}`).trim(),
    priority,
    area,
    reason: String(fix?.reason || "Suggerito dal deep audit.").trim(),
    suggestedCodexPrompt: String(fix?.suggestedCodexPrompt || `Analizza e implementa il fix: ${fix?.title || "fix consigliato"}`).trim()
  };
}

function normalizeDeepAudit(parsed, snapshot, rawText = "") {
  const analysis = snapshot?.analysis || snapshot || {};
  const projectId = snapshot?.projectId || analysis.projectId || "unknown_project";
  const projectName = snapshot?.projectName || analysis.projectName || projectId;
  const rootPath = snapshot?.rootPath || analysis.rootPath || "";
  const fixes = asArray(parsed.recommendedFixes).map(normalizeFix);

  return {
    projectId,
    projectName,
    rootPath,
    auditedAt: new Date().toISOString(),
    mode: "deep_ai",
    executiveSummary: parsed.executiveSummary || "",
    whatThisProjectIs: parsed.whatThisProjectIs || "",
    whatThisProjectIsNot: parsed.whatThisProjectIsNot || "",
    architecture: parsed.architecture || {},
    coreFlows: asArray(parsed.coreFlows),
    strengths: asArray(parsed.strengths),
    weaknesses: asArray(parsed.weaknesses),
    risks: asArray(parsed.risks),
    technicalDebt: asArray(parsed.technicalDebt),
    memoryOrbitaleAssessment: parsed.memoryOrbitaleAssessment || { summary: "", files: [], risks: [], recommendedFixes: [] },
    recommendedFixes: fixes,
    nextSteps: asArray(parsed.nextSteps),
    codexStrategy: parsed.codexStrategy || "",
    dontBreak: asArray(parsed.dontBreak),
    openQuestions: asArray(parsed.openQuestions),
    rawText
  };
}

export async function generateDeepAudit(snapshot, options = {}) {
  const prompt = buildDeepAuditPrompt(snapshot, options.heuristicAudit || null);
  const timeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(options.ollamaUrl || DEFAULT_OLLAMA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: options.model || DEFAULT_MODEL,
        prompt,
        stream: false,
        options: {
          temperature: 0.15,
          top_p: 0.85,
          num_ctx: 16384
        }
      })
    });

    if (!response.ok) throw new Error(`Ollama HTTP ${response.status}`);

    const payload = await response.json();
    const rawText = String(payload.response || "").trim();

    try {
      return normalizeDeepAudit(extractJsonObject(rawText), snapshot, rawText);
    } catch {
      return normalizeDeepAudit({
        executiveSummary: "Il modello locale ha restituito testo non JSON. Il report grezzo e' salvato in rawText.",
        recommendedFixes: fallbackFixesFromText(rawText),
        risks: ["Risposta deep audit non strutturata: verificare prompt/modello o rilanciare."]
      }, snapshot, rawText);
    }
  } catch (error) {
    const message = error?.name === "AbortError" ? "Timeout deep audit LLM locale." : error.message;
    const wrapped = new Error(message);
    wrapped.cause = error;
    throw wrapped;
  } finally {
    clearTimeout(timeout);
  }
}
