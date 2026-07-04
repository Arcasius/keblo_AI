import path from "path";
import { scanProject } from "./nexus_scanner.js";
import { analyzeProject } from "./nexus_analyzer.js";
import { saveSnapshot } from "./nexus_storage.js";

async function main() {
  const targetPath = process.argv[2];
  if (!targetPath) {
    console.error("Uso: node project_nexus/test_nexus_scan.js /path/progetto");
    process.exitCode = 1;
    return;
  }

  const rootPath = path.resolve(targetPath);
  const scanResult = await scanProject(rootPath);
  const analysis = analyzeProject(scanResult);
  const snapshot = {
    projectId: analysis.projectId,
    projectName: analysis.projectName,
    rootPath: analysis.rootPath,
    scannedAt: scanResult.scannedAt,
    scan: scanResult,
    analysis
  };

  const saved = await saveSnapshot("u1", snapshot);

  console.log("Project Nexus scan completato");
  console.log("");
  console.log("Summary:");
  console.log(analysis.summary);
  console.log("");
  console.log("File critici:");
  for (const file of analysis.criticalFiles) {
    console.log(`- ${file.path}`);
  }
  console.log("");
  console.log("Domini:");
  for (const domain of analysis.domains) {
    console.log(`- ${domain.name} (${domain.score})`);
  }
  console.log("");
  console.log(`Snapshot: ${saved.snapshotPath}`);
}

main().catch((error) => {
  console.error(`Project Nexus scan fallito: ${error.message}`);
  process.exitCode = 1;
});
