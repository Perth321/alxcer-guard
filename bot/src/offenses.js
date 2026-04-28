import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const OFFENSES_PATH = path.resolve(__dirname, "..", "offenses.json");

export function loadOffenses() {
  if (!fs.existsSync(OFFENSES_PATH)) return { users: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(OFFENSES_PATH, "utf8"));
    if (!raw || typeof raw !== "object") return { users: {} };
    if (!raw.users || typeof raw.users !== "object") return { users: {} };
    return raw;
  } catch (err) {
    console.error("[offenses] failed to parse offenses.json:", err?.message);
    return { users: {} };
  }
}

export function writeLocal(obj) {
  fs.writeFileSync(OFFENSES_PATH, JSON.stringify(obj, null, 2) + "\n");
}
