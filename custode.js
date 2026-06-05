import fs from "fs";
fs.mkdirSync("./logs/users", { recursive: true });

function log(file, event, payload) {
  const line = JSON.stringify({ ts: new Date().toISOString(), event, payload });
  fs.appendFileSync(file, line + "\n");
}

export function audit(event, payload = {}) {
  log("./logs/audit.log", event, payload);
}

export function userAudit(userId, event, payload = {}) {
  log(`./logs/users/${userId}.log`, event, payload);
}
