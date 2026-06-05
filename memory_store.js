import fs from "fs";
import path from "path";

const BASE_PATH = "./storage/memory";

export function saveCard(userId, card) {
  const filePath = path.join(BASE_PATH, `${userId}.json`);

  const entry = {
    ...card,
    timestamp: new Date().toISOString()
  };

  let data = [];
  if (fs.existsSync(filePath)) {
    data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  }

  data.push(entry);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}
