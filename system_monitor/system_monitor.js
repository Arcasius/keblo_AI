// system_monitor.js
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import fs from "node:fs";

const execFileAsync = promisify(execFile);

function safeNum(v, fallback = 0) {
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? n : fallback;
}

function fmtBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let val = bytes;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }
  return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function readLoadAvg() {
  const [l1, l5, l15] = os.loadavg();
  return {
    l1: Number(l1.toFixed(2)),
    l5: Number(l5.toFixed(2)),
    l15: Number(l15.toFixed(2)),
  };
}

function readUptime() {
  const total = os.uptime();
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  return `${d}d ${h}h ${m}m`;
}

async function runNvidiaSmi(args) {
  try {
    const { stdout } = await execFileAsync("nvidia-smi", args, { timeout: 5000 });
    return stdout.trim();
  } catch {
    return "";
  }
}

async function getGpus() {
  const gpuRaw = await runNvidiaSmi([
    "--query-gpu=index,name,uuid,temperature.gpu,utilization.gpu,memory.used,memory.total,power.draw",
    "--format=csv,noheader,nounits",
  ]);

  const procRaw = await runNvidiaSmi([
    "--query-compute-apps=gpu_uuid,pid,process_name,used_memory",
    "--format=csv,noheader,nounits",
  ]);

  const gpus = gpuRaw
    ? gpuRaw.split("\n").map((line) => {
        const parts = line.split(",").map((x) => x.trim());
        return {
          index: safeNum(parts[0]),
          name: parts[1] || "Unknown GPU",
          uuid: parts[2] || "",
          tempC: safeNum(parts[3]),
          utilPercent: safeNum(parts[4]),
          memoryUsedMB: safeNum(parts[5]),
          memoryTotalMB: safeNum(parts[6]),
          powerDrawW: safeNum(parts[7]),
          processes: [],
        };
      })
    : [];

  const procLines = procRaw ? procRaw.split("\n") : [];
  for (const line of procLines) {
    const parts = line.split(",").map((x) => x.trim());
    const gpuUuid = parts[0] || "";
    const pid = safeNum(parts[1], -1);
    const processName = parts[2] || "unknown";
    const usedMemoryMB = safeNum(parts[3]);

    const gpu = gpus.find((g) => g.uuid === gpuUuid);
    if (gpu) {
      gpu.processes.push({
        pid,
        processName,
        usedMemoryMB,
      });
    }
  }

  return gpus.map((gpu) => ({
    ...gpu,
    memoryPercent: gpu.memoryTotalMB > 0
      ? Number(((gpu.memoryUsedMB / gpu.memoryTotalMB) * 100).toFixed(1))
      : 0,
  }));
}

async function getTopProcesses(limit = 8) {
  try {
    const { stdout } = await execFileAsync(
      "ps",
      ["-eo", "pid,comm,%cpu,%mem,rss", "--sort=-%mem"],
      { timeout: 5000 }
    );

    const lines = stdout.trim().split("\n").slice(1, limit + 1);
    return lines.map((line) => {
      const parts = line.trim().split(/\s+/);
      const [pid, comm, cpu, mem, rss] = parts;
      return {
        pid: safeNum(pid),
        name: comm || "unknown",
        cpuPercent: safeNum(cpu),
        memPercent: safeNum(mem),
        rssKB: safeNum(rss),
        rssHuman: fmtBytes(safeNum(rss) * 1024),
      };
    });
  } catch {
    return [];
  }
}

async function getDisk() {
  try {
    const { stdout } = await execFileAsync("df", ["-k", "/"], { timeout: 5000 });
    const lines = stdout.trim().split("\n");
    const row = lines[1]?.trim().split(/\s+/) || [];
    const totalKB = safeNum(row[1]);
    const usedKB = safeNum(row[2]);
    const availKB = safeNum(row[3]);
    const usePercent = safeNum(String(row[4] || "0").replace("%", ""));
    return {
      totalKB,
      usedKB,
      availKB,
      totalHuman: fmtBytes(totalKB * 1024),
      usedHuman: fmtBytes(usedKB * 1024),
      availHuman: fmtBytes(availKB * 1024),
      usePercent,
      mount: row[5] || "/",
    };
  } catch {
    return null;
  }
}

function getMemory() {
  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;
  return {
    total,
    free,
    used,
    totalHuman: fmtBytes(total),
    freeHuman: fmtBytes(free),
    usedHuman: fmtBytes(used),
    usedPercent: Number(((used / total) * 100).toFixed(1)),
  };
}

function getCpu() {
  const cpus = os.cpus() || [];
  return {
    cores: cpus.length,
    model: cpus[0]?.model || "Unknown CPU",
    loadAvg: readLoadAvg(),
  };
}

async function checkServiceTcp(host, port, label) {
  const net = await import("node:net");
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = new net.Socket();

    const done = (online) => {
      try { socket.destroy(); } catch {}
      resolve({
        name: label,
        host,
        port,
        online,
        latencyMs: online ? Date.now() - started : null,
      });
    };

    socket.setTimeout(1200);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    socket.connect(port, host);
  });
}

async function getServices() {
  const targets = [
    { host: "127.0.0.1", port: 3000, name: "Keblo API" },
    { host: "127.0.0.1", port: 11434, name: "Ollama Main" },
    { host: "127.0.0.1", port: 11435, name: "Ollama News" },
    { host: "127.0.0.1", port: 8000, name: "Reranker" },
    { host: "127.0.0.1", port: 6333, name: "Qdrant" },
    { host: "127.0.0.1", port: 6379, name: "Redis" },
    { host: "127.0.0.1", port: 8188, name: "ComfyUI" },
  ];

  return Promise.all(targets.map((t) => checkServiceTcp(t.host, t.port, t.name)));
}

function buildAlerts({ memory, disk, gpus, services }) {
  const alerts = [];

  if (memory.usedPercent >= 85) {
    alerts.push({ level: "critical", text: `RAM alta: ${memory.usedPercent}%` });
  } else if (memory.usedPercent >= 75) {
    alerts.push({ level: "warning", text: `RAM sotto pressione: ${memory.usedPercent}%` });
  }

  if (disk?.usePercent >= 90) {
    alerts.push({ level: "critical", text: `Disco quasi pieno: ${disk.usePercent}%` });
  } else if (disk?.usePercent >= 80) {
    alerts.push({ level: "warning", text: `Disco alto: ${disk.usePercent}%` });
  }

  for (const gpu of gpus) {
    if (gpu.memoryPercent >= 95) {
      alerts.push({ level: "critical", text: `GPU ${gpu.index} VRAM quasi piena: ${gpu.memoryPercent}%` });
    } else if (gpu.memoryPercent >= 85) {
      alerts.push({ level: "warning", text: `GPU ${gpu.index} VRAM alta: ${gpu.memoryPercent}%` });
    }

    if (gpu.tempC >= 82) {
      alerts.push({ level: "critical", text: `GPU ${gpu.index} temperatura alta: ${gpu.tempC}°C` });
    } else if (gpu.tempC >= 74) {
      alerts.push({ level: "warning", text: `GPU ${gpu.index} calda: ${gpu.tempC}°C` });
    }
  }

  for (const svc of services) {
    if (!svc.online) {
      alerts.push({ level: "critical", text: `${svc.name} non risponde su :${svc.port}` });
    }
  }

  return alerts;
}

function buildStatus(alerts) {
  if (alerts.some((a) => a.level === "critical")) return "CRITICAL";
  if (alerts.some((a) => a.level === "warning")) return "STRESS";
  return "OK";
}

function inferGpuRole(index) {
  if (index === 0) return "Cognition";
  if (index === 1) return "Perception";
  return "General";
}

function buildInsight(gpus, services) {
  const gpu1 = gpus.find((g) => g.index === 1);
  const comfy = services.find((s) => s.name === "ComfyUI");
  const reranker = services.find((s) => s.name === "Reranker");

  if (gpu1 && gpu1.memoryPercent > 80 && comfy?.online && reranker?.online) {
    return "GPU1 è sotto carico: ComfyUI e Reranker sono attivi, meglio evitare task pesanti di visione.";
  }

  const busyGpu = gpus.find((g) => g.memoryPercent > 85);
  if (busyGpu) {
    return `GPU ${busyGpu.index} è vicina alla saturazione VRAM.`;
  }

  return "Sistema stabile.";
}

export async function getSystemOverview() {
  const [gpus, topProcesses, disk, services] = await Promise.all([
    getGpus(),
    getTopProcesses(),
    getDisk(),
    getServices(),
  ]);

  const memory = getMemory();
  const cpu = getCpu();
  const alerts = buildAlerts({ memory, disk, gpus, services });
  const status = buildStatus(alerts);

  return {
    status,
    host: os.hostname(),
    uptime: readUptime(),
    timestamp: new Date().toISOString(),
    cpu,
    memory,
    disk,
    gpus: gpus.map((g) => ({
      ...g,
      role: inferGpuRole(g.index),
    })),
    services,
    topProcesses,
    alerts,
    insight: buildInsight(gpus, services),
  };
}
