export function generateCodexPrompt(snapshot, userRequest) {
  const analysis = snapshot.analysis || snapshot;
  const entrypoints = analysis.entrypoints || [];
  const criticalFiles = analysis.criticalFiles || [];
  const risks = analysis.risks || [];

  return [
    "Agisci come senior software engineer su Keblo / Project Nexus.",
    "",
    "Contesto progetto:",
    `- Nome: ${analysis.projectName || "N/D"}`,
    `- Root: ${analysis.rootPath || "N/D"}`,
    `- Summary: ${analysis.summary || "N/D"}`,
    `- Stack: ${(analysis.stack || []).join(", ") || "N/D"}`,
    "",
    "Entrypoint rilevati:",
    ...entrypoints.map((entry) => `- ${entry.path}`),
    "",
    "File critici:",
    ...criticalFiles.slice(0, 30).map((file) => `- ${file.path}`),
    "",
    "Rischi rilevati:",
    ...risks.slice(0, 20).map((risk) => `- [${risk.level}] ${risk.area}: ${risk.message}`),
    "",
    "Vincoli:",
    "- Non assumere contenuti completi dei file: lo snapshot contiene solo metadati e import principali.",
    "- Prima di modificare codice, leggere i file reali necessari nel workspace.",
    "- Mantenere le modifiche coerenti con architettura e rischi sopra.",
    "",
    "Richiesta utente:",
    userRequest || "Analizza lo snapshot e proponi il prossimo intervento tecnico."
  ].join("\n");
}
